import { and, desc, eq, sql } from "drizzle-orm";
import { db, historicalMatchesTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import type { PlayerProfile, PlayerSummary, TennisDataProvider } from "./types";

/**
 * Real cross-source player identity resolution (Task #22). API-Tennis (the only reachable tennis
 * data provider in this environment -- see docs/audit-task22-player-coverage.md, which
 * re-verified live on 2026-07-11 that API_SPORTS_KEY and RAPIDAPI_KEY still have no working,
 * subscribed tennis endpoint) has no name-search endpoint and scopes `get_standings` to current
 * ATP/WTA top rankings only. That leaves Challenger/ITF-only players, and recently-retired or
 * -returning players outside the current top rankings, genuinely unsearchable by name and
 * missing a `tour` from `getPlayer` alone.
 *
 * This module supplements the provider with our OWN previously-fetched, already-verified real
 * match history (`historical_matches`, populated by the backfill pipeline and by paper-trading
 * grading) as a second real identity source -- never a fuzzy guess, never fabricated: every row
 * matched here is an exact `player_key` the provider itself reported on a real match. A player
 * found ONLY this way is always labeled `source: "historical-match"` so callers (and the UI) can
 * distinguish it from a live-standings-verified profile, per Task #22's "clearly disclosed, not
 * silently dropped" requirement.
 */

/** Doubles fixtures store the pair as one "player" with a "/"-joined name (e.g. "Collignon/ Kasnikowski") -- exclude those from singles player identity lookups. */
function isSinglesName(name: string): boolean {
  return !name.includes("/");
}

/**
 * Characters that do NOT decompose under Unicode NFD (no base + combining-diacritic split) but
 * are common in tennis player names and need explicit transliteration before the diacritic-strip
 * pass. Confirmed live: Đ (U+0110), đ (U+0111), Ł/ł (U+0141/42), Ø/ø (U+00D8/F8), ß (U+00DF)
 * all survive NFD unchanged and must be mapped here or they remain as non-ASCII after stripping.
 */
const NON_NFD_TRANSLITERATIONS: [RegExp, string][] = [
  [/[Đđ]/g, "d"],
  [/[Łł]/g, "l"],
  [/[Øø]/g, "o"],
  [/[ß]/g, "ss"],
  [/[Ææ]/g, "ae"],
  [/[Œœ]/g, "oe"],
];

/**
 * Well-known short names and nicknames for top ATP/WTA players, keyed by their normalized form
 * (output of normalizePlayerName — lowercase, no punctuation except apostrophes, no diacritics).
 * Values are the canonical full name to use as the expanded search term.
 *
 * Limited to unambiguous monikers where exactly one player is universally intended.
 * "Alex", "carlos" etc. are deliberately excluded — too ambiguous at the circuit level.
 */
export const WELL_KNOWN_NICKNAMES: Record<string, string> = {
  rafa: "Rafael Nadal",
  nole: "Novak Djokovic",
  djoker: "Novak Djokovic",
  muzza: "Andy Murray",
  delpo: "Juan Martin del Potro",
  guga: "Gustavo Kuerten",
  coco: "Cori Gauff",
  meddy: "Daniil Medvedev",
  sascha: "Alexander Zverev",
  serena: "Serena Williams",
  venus: "Venus Williams",
  roger: "Roger Federer",
};

/**
 * Folds accents/diacritics, lowercases, strips punctuation, and collapses whitespace so the same
 * real person spelled two different ways by different provider feeds ("Krumich" vs "Krúmich",
 * "de Lange" vs "De Lange") compares equal. Used only as a real, structural identity signal (an
 * exact match after normalization) -- never a fuzzy/approximate match.
 *
 * Two-pass: explicit transliteration of characters that don't decompose under NFD (Đ→d, Ł→l,
 * etc.) then the standard NFD + diacritic-strip pass that handles the majority of accented
 * Latin characters (é, ó, ñ, etc.).
 *
 * Apostrophes are PRESERVED in the primary pass so that "O'Brien" normalises to "o'brien"
 * (not "obrien"), enabling a precise primary lookup. `generateNameVariants` adds an apostrophe-
 * stripped fallback variant so searches without the apostrophe still resolve correctly.
 */
export function normalizePlayerName(name: string): string {
  let s = name;
  for (const [pattern, replacement] of NON_NFD_TRANSLITERATIONS) {
    s = s.replace(pattern, replacement);
  }
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")  // apostrophes preserved — see comment above
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true when the normalized name looks like an initial-first-name form, i.e. the first
 * word is a single letter ("r nadal"). Used to gate initial-expansion matching so we don't
 * run expansion on regular full names.
 */
export function isInitialNamePattern(normalizedName: string): boolean {
  const words = normalizedName.split(" ");
  return words.length >= 2 && words[0].length === 1;
}

/**
 * Abbreviated name keys (e.g. "m uchijima", "a smith") are not stable identity keys when more
 * than one player shares the same initial+surname form. Those keys must never be used to merge
 * distinct provider IDs into one canonical identity.
 */
function isWeakIdentityNameKey(normalizedName: string): boolean {
  const words = normalizedName.split(" ").filter(Boolean);
  if (words.length < 2) return true;
  return words.some((w) => w.length <= 1);
}

/**
 * Generates every normalized name variant that should be tried when resolving a player by name.
 * Always includes the direct normalized form. Additionally:
 *  - Reversed word order ("nadal rafael" alongside "rafael nadal"), so providers that report
 *    last-name-first are matched correctly.
 *  - For initial-pattern names ("r nadal"): expands to check both "r <surname>" AND
 *    "<surname> r" orderings, so reversed-initial forms are caught too.
 *  - Apostrophe-stripped fallback variants: "o'brien" → "obrien" so cross-system lookups
 *    (where the apostrophe was stripped before storage) still resolve correctly.
 * Deduplicates variants so callers never check the same normalized string twice.
 */
export function generateNameVariants(name: string): string[] {
  const direct = normalizePlayerName(name);
  if (!direct) return [];

  const seen = new Set<string>();
  const variants: string[] = [];
  const add = (v: string) => { if (v && !seen.has(v)) { seen.add(v); variants.push(v); } };

  add(direct);

  // Reversed word order
  const words = direct.split(" ");
  if (words.length >= 2) {
    const reversed = [...words].reverse().join(" ");
    add(reversed);
  }

  // Apostrophe-stripped fallback — only added when the primary form contains an apostrophe.
  // This ensures "O'Brien" (primary "o'brien") also matches index entries stored as "obrien".
  if (direct.includes("'")) {
    const stripped = direct.replace(/'/g, "");
    add(stripped);
    const strippedWords = stripped.split(" ");
    if (strippedWords.length >= 2) {
      add([...strippedWords].reverse().join(" "));
    }
  }

  return variants;
}

/** Result when name resolution is confident (exactly one candidate). */
export interface NameResolutionHit {
  ambiguous: false;
  id: string;
  /** How the match was made — callers can use this for disclosure. */
  confidence: "exact" | "reversed";
}

/** Result when the name matches multiple distinct players — caller must ask for disambiguation. */
export interface NameResolutionAmbiguous {
  ambiguous: true;
  /** Normalized names of all candidates that matched. */
  candidates: string[];
}

export type NameResolutionResult = NameResolutionHit | NameResolutionAmbiguous | null;

/**
 * Resolves a player name against the identity index, trying multiple normalized variants
 * (direct form, reversed word order). Returns:
 *  - `{ ambiguous: false, id, confidence }` when exactly one canonical ID is found.
 *  - `{ ambiguous: true, candidates }` when multiple distinct IDs match across variants
 *    (the caller must ask for clarification rather than guessing).
 *  - `null` when no variant matches anything in the index.
 *
 * Never guesses between ambiguous candidates — the explicit ambiguous signal is always
 * returned so callers can surface it to the user rather than silently picking the wrong player.
 */
export function resolvePlayerNameWithAmbiguity(
  index: PlayerIdentityIndex,
  name: string,
): NameResolutionResult {
  const variants = generateNameVariants(name);
  if (variants.length === 0) return null;

  const directNorm = variants[0];
  const hits = new Map<string, "exact" | "reversed">(); // canonicalId -> confidence

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const confidence: "exact" | "reversed" = i === 0 ? "exact" : "reversed";

    // Try direct name lookup
    const byName = index.canonicalIdByName.get(variant);
    if (byName) {
      if (!hits.has(byName) || confidence === "exact") {
        hits.set(byName, confidence);
      }
    }
  }

  if (hits.size === 0) return null;
  if (hits.size === 1) {
    const [id, confidence] = [...hits.entries()][0];
    return { ambiguous: false, id, confidence };
  }
  // Multiple distinct canonical IDs — genuinely ambiguous
  return { ambiguous: true, candidates: [...hits.keys()] };
}

/**
 * Canonical player-identity resolution (Task #77). Built once per run by cross-referencing every
 * singles player id/name pair ever recorded in `historical_matches`: when two or more distinct
 * provider ids share the exact same normalized name, that is a real fragmentation signal (the
 * same person issued multiple `player_key`s by the provider over time), not a fuzzy guess -- the
 * most-recently-active id under that name is treated as canonical, and every other id/name variant
 * sighted under that name is aliased to it. `canonicalIdById` also covers the overwhelmingly
 * common non-fragmented case (an id maps to itself) so callers can always canonicalize
 * unconditionally.
 */
export interface PlayerIdentityIndex {
  /** normalizedName -> canonical playerId (most-recently-active id seen under that name). */
  canonicalIdByName: Map<string, string>;
  /** raw playerId (as reported by the provider) -> canonical playerId. Identity map for the common case. */
  canonicalIdById: Map<string, string>;
  /**
   * Reverse of `canonicalIdById`: canonical playerId -> every raw id (including itself) ever
   * sighted under that canonical identity. Required by any caller that queries a DIFFERENT table
   * (e.g. `match_feature_snapshots`) keyed by the RAW provider id -- looking up only the canonical
   * id in such a table silently misses every row stored under an alias id (see `opponentStrength.ts`'s
   * `resolveOpponentStrength`, which merges history across the whole alias group, not just the
   * canonical id, for exactly this reason).
   */
  aliasIdsByCanonicalId: Map<string, string[]>;
}

/** Builds a fresh `PlayerIdentityIndex` from every singles sighting in `historical_matches`. */
export async function buildPlayerIdentityIndex(): Promise<PlayerIdentityIndex> {
  const [player1Rows, player2Rows] = await Promise.all([
    db
      .select({ id: historicalMatchesTable.player1Id, name: historicalMatchesTable.player1Name, scheduledStartAt: historicalMatchesTable.scheduledStartAt })
      .from(historicalMatchesTable),
    db
      .select({ id: historicalMatchesTable.player2Id, name: historicalMatchesTable.player2Name, scheduledStartAt: historicalMatchesTable.scheduledStartAt })
      .from(historicalMatchesTable),
  ]);

  // normalizedName -> (playerId -> most recent sighting timestamp under that name)
  const byName = new Map<string, Map<string, number>>();
  for (const row of [...player1Rows, ...player2Rows]) {
    if (!isSinglesName(row.name)) continue;
    const normalized = normalizePlayerName(row.name);
    if (!normalized) continue;
    const idMap = byName.get(normalized) ?? new Map<string, number>();
    const seenAt = row.scheduledStartAt.getTime();
    idMap.set(row.id, Math.max(idMap.get(row.id) ?? -Infinity, seenAt));
    byName.set(normalized, idMap);
  }

  const canonicalIdByName = new Map<string, string>();
  const canonicalIdById = new Map<string, string>();
  const aliasIdsByCanonicalId = new Map<string, string[]>();
  for (const [normalized, idMap] of byName) {
    // Never alias multiple IDs together on an abbreviated key like "m uchijima".
    if (idMap.size > 1 && isWeakIdentityNameKey(normalized)) {
      for (const id of idMap.keys()) {
        if (!canonicalIdById.has(id)) canonicalIdById.set(id, id);
      }
      continue;
    }

    let canonicalId: string | null = null;
    let mostRecent = -Infinity;
    for (const [id, seenAt] of idMap) {
      if (seenAt > mostRecent) {
        mostRecent = seenAt;
        canonicalId = id;
      }
    }
    if (!canonicalId) continue;
    canonicalIdByName.set(normalized, canonicalId);
    // Apostrophe-stripped fallback: also index "obrien" when primary key is "o'brien" so
    // callers that normalized without apostrophe preservation still resolve to the right player.
    // Only set if no OTHER entry (a distinct player stored without the apostrophe) already owns
    // the stripped key — we never overwrite a more specific existing entry.
    if (normalized.includes("'")) {
      const stripped = normalized.replace(/'/g, "");
      if (!canonicalIdByName.has(stripped)) canonicalIdByName.set(stripped, canonicalId);
    }
    const aliasIds = Array.from(idMap.keys());
    aliasIdsByCanonicalId.set(canonicalId, aliasIds);
    for (const id of idMap.keys()) canonicalIdById.set(id, canonicalId);
  }

  return { canonicalIdByName, canonicalIdById, aliasIdsByCanonicalId };
}

/**
 * Resolves `id` to its canonical id: an exact id match first (covers the common non-fragmented
 * case and, post-alias-resolution, any id already known to be a fragment), then falls back to a
 * normalized-name lookup when `name` is supplied and the raw id itself was never sighted in
 * `historical_matches` under any name (e.g. a live-only id the backfill hasn't seen yet, but whose
 * name matches a player we do have real history for). Returns `id` unchanged when genuinely
 * unresolvable -- never guesses.
 */
export function canonicalizePlayerId(index: PlayerIdentityIndex, id: string, name?: string | null): string {
  const direct = index.canonicalIdById.get(id);
  if (direct) return direct;
  if (name) {
    const normalized = normalizePlayerName(name);
    const byName = index.canonicalIdByName.get(normalized);
    if (byName) return byName;
  }
  return id;
}

/**
 * Every raw id belonging to `canonicalId`'s alias group, always including `canonicalId` itself
 * even when it has no recorded aliases (the common non-fragmented case). Use this -- not
 * `canonicalId` alone -- whenever querying a table keyed by the RAW provider id (e.g.
 * `match_feature_snapshots`), or rows stored under a historical alias id will be silently missed.
 */
export function getAliasIds(index: PlayerIdentityIndex, canonicalId: string): string[] {
  return index.aliasIdsByCanonicalId.get(canonicalId) ?? [canonicalId];
}

let cachedIdentityIndex: { index: PlayerIdentityIndex; builtAt: number } | null = null;
const IDENTITY_INDEX_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Cached accessor for live/per-fixture callers (e.g. `opponentStrength.ts`'s `resolveOpponentStrength`)
 * -- rebuilding the whole-corpus identity index is real DB work, so it's computed once and reused
 * for `IDENTITY_INDEX_CACHE_TTL_MS` rather than rebuilt on every single prediction request.
 * Backtest/rebuild callers that already build one index per run (walk-forward, full-corpus
 * rebuild) should call `buildPlayerIdentityIndex` directly instead, so their run-scoped index
 * can't go stale mid-run.
 */
export async function getCachedPlayerIdentityIndex(): Promise<PlayerIdentityIndex> {
  if (cachedIdentityIndex && Date.now() - cachedIdentityIndex.builtAt < IDENTITY_INDEX_CACHE_TTL_MS) {
    return cachedIdentityIndex.index;
  }
  const index = await buildPlayerIdentityIndex();
  cachedIdentityIndex = { index, builtAt: Date.now() };
  return index;
}

/**
 * Test-only escape hatch: forces the next `getCachedPlayerIdentityIndex()` call to rebuild from
 * the DB instead of serving a stale in-memory cache. Integration tests that insert their own
 * `historical_matches` fixture rows and then exercise a live caller (e.g. `resolveOpponentStrength`)
 * must call this first, or an index already cached from an earlier test/request won't see the
 * fixture. Never called from production code.
 */
export function invalidatePlayerIdentityCacheForTests(): void {
  cachedIdentityIndex = null;
}

interface HistoricalPlayerRow {
  id: string;
  name: string;
  tour: string | null;
}

/** Most recent real historical-match sighting of a given player_key, or null if we've never seen them. */
async function findMostRecentHistoricalSighting(playerId: string): Promise<HistoricalPlayerRow | null> {
  const [asPlayer1, asPlayer2] = await Promise.all([
    db
      .select({ id: historicalMatchesTable.player1Id, name: historicalMatchesTable.player1Name, tour: historicalMatchesTable.tour, scheduledStartAt: historicalMatchesTable.scheduledStartAt })
      .from(historicalMatchesTable)
      .where(eq(historicalMatchesTable.player1Id, playerId))
      .orderBy(desc(historicalMatchesTable.scheduledStartAt))
      .limit(1),
    db
      .select({ id: historicalMatchesTable.player2Id, name: historicalMatchesTable.player2Name, tour: historicalMatchesTable.tour, scheduledStartAt: historicalMatchesTable.scheduledStartAt })
      .from(historicalMatchesTable)
      .where(eq(historicalMatchesTable.player2Id, playerId))
      .orderBy(desc(historicalMatchesTable.scheduledStartAt))
      .limit(1),
  ]);

  const candidates = [...asPlayer1, ...asPlayer2].filter((row) => isSinglesName(row.name));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.scheduledStartAt.getTime() - a.scheduledStartAt.getTime());
  const best = candidates[0];
  return { id: best.id, name: best.name, tour: best.tour };
}

interface HistoricalIdValidationCacheRow {
  checkedAt: number;
  profile: PlayerProfile | null;
}

const HISTORICAL_ID_VALIDATION_TTL_MS = 6 * 60 * 60 * 1000;
const historicalIdValidationCache = new Map<string, HistoricalIdValidationCacheRow>();

async function validateHistoricalPlayerId(provider: TennisDataProvider, playerId: string): Promise<PlayerProfile | null | undefined> {
  const cached = historicalIdValidationCache.get(playerId);
  if (cached && Date.now() - cached.checkedAt < HISTORICAL_ID_VALIDATION_TTL_MS) {
    return cached.profile;
  }

  try {
    const profile = await provider.getPlayer(playerId);
    historicalIdValidationCache.set(playerId, { profile, checkedAt: Date.now() });
    return profile;
  } catch (err) {
    logger.warn({ err, playerId }, "Historical ID provider validation failed; keeping historical player fallback for this search");
    return undefined;
  }
}

export interface PredictionPlayerResolution {
  profile: PlayerProfile | null;
  resolvedPlayerId: string;
  /** Populated only when resolution failed, so callers can show exact remediation. */
  detail: string | null;
}

/**
 * Prediction-time player resolution that starts from an input player id and attempts stable
 * remapping when that id exists only in historical rows but no longer resolves in the provider.
 */
export async function resolvePlayerProfileForPrediction(
  provider: TennisDataProvider,
  requestedPlayerId: string,
): Promise<PredictionPlayerResolution> {
  const direct = await resolvePlayerProfile(provider, requestedPlayerId);
  if (direct) {
    return { profile: direct, resolvedPlayerId: direct.id, detail: null };
  }

  const sighting = await findMostRecentHistoricalSighting(requestedPlayerId);
  if (!sighting) {
    return {
      profile: null,
      resolvedPlayerId: requestedPlayerId,
      detail: `Player ID ${requestedPlayerId} could not be found in provider data or historical records.`,
    };
  }

  const index = await getCachedPlayerIdentityIndex();
  const canonicalId = canonicalizePlayerId(index, requestedPlayerId, sighting.name);
  if (canonicalId !== requestedPlayerId) {
    const canonicalProfile = await resolvePlayerProfile(provider, canonicalId);
    if (canonicalProfile) {
      logger.info(
        { requestedPlayerId, canonicalId, sightingName: sighting.name },
        "Resolved stale historical player ID to canonical provider-resolvable ID for prediction",
      );
      return { profile: canonicalProfile, resolvedPlayerId: canonicalProfile.id, detail: null };
    }
  }

  const normalizedName = normalizePlayerName(sighting.name);
  const byNameCandidates = await provider.searchPlayers(sighting.name);
  const exactNameCandidates = byNameCandidates.filter((c) => normalizePlayerName(c.name) === normalizedName);

  if (exactNameCandidates.length === 1) {
    const remappedId = exactNameCandidates[0]!.id;
    const remappedProfile = await resolvePlayerProfile(provider, remappedId);
    if (remappedProfile) {
      logger.info(
        { requestedPlayerId, remappedId, sightingName: sighting.name },
        "Resolved historical-only player ID to live provider ID via exact name match",
      );
      return { profile: remappedProfile, resolvedPlayerId: remappedProfile.id, detail: null };
    }
  }

  // Reverse-abbreviation fallback: when the historical name is a FULL name (e.g. "Moyuka Uchijima")
  // but the provider's search returns only abbreviated forms (e.g. "M. Uchijima"), the exact-match
  // step above finds nothing. Check whether any candidate is a valid abbreviated form of the
  // historical full name (initial matches first letter, surname(s) match exactly). Only use it
  // when exactly one candidate qualifies -- multiple matches mean ambiguity (e.g. "M. Uchijima"
  // could be Maiko OR Moyuka) and we must not guess.
  if (exactNameCandidates.length === 0) {
    const fullWords = normalizedName.split(" ").filter(Boolean);
    if (fullWords.length >= 2 && !isInitialNamePattern(normalizedName)) {
      const abbreviatedCandidates = byNameCandidates.filter((c) => {
        const cNorm = normalizePlayerName(c.name);
        if (!isInitialNamePattern(cNorm)) return false;
        const cWords = cNorm.split(" ").filter(Boolean);
        if (cWords.length !== fullWords.length) return false;
        if (cWords[0] !== fullWords[0]![0]) return false;
        return cWords.slice(1).every((w, i) => w === fullWords.slice(1)[i]);
      });
      if (abbreviatedCandidates.length === 1) {
        const remappedId = abbreviatedCandidates[0]!.id;
        const remappedProfile = await resolvePlayerProfile(provider, remappedId);
        if (remappedProfile) {
          logger.info(
            { requestedPlayerId, remappedId, sightingName: sighting.name },
            "Resolved full historical player name to live provider ID via reverse-abbreviation match",
          );
          return { profile: remappedProfile, resolvedPlayerId: remappedProfile.id, detail: null };
        }
      }
      if (abbreviatedCandidates.length > 1) {
        const names = abbreviatedCandidates.map((c) => c.name).join(", ");
        return {
          profile: null,
          resolvedPlayerId: requestedPlayerId,
          detail: `Historical player ID ${requestedPlayerId} ("${sighting.name}") matches multiple abbreviated provider records (${names}); choose the exact full-name player from Search.`,
        };
      }
    }
  }

  const words = normalizedName.split(" ").filter(Boolean);
  if (isInitialNamePattern(normalizedName) && words.length >= 2) {
    const initial = words[0]!;
    const surnameWords = words.slice(1);
    const surnameQuery = surnameWords.join(" ");

    const surnameCandidates = await provider.searchPlayers(surnameQuery);
    const narrowed = surnameCandidates.filter((candidate) => {
      const candidateWords = normalizePlayerName(candidate.name).split(" ").filter(Boolean);
      if (candidateWords.length < 2) return false;
      const candidateWordSet = new Set(candidateWords);
      return surnameWords.every((w) => candidateWordSet.has(w)) && candidateWords[0]![0] === initial;
    });

    if (narrowed.length === 1) {
      const remappedId = narrowed[0]!.id;
      const remappedProfile = await resolvePlayerProfile(provider, remappedId);
      if (remappedProfile) {
        logger.info(
          { requestedPlayerId, remappedId, sightingName: sighting.name },
          "Resolved abbreviated historical player name to unique live provider ID via initial+surname narrowing",
        );
        return { profile: remappedProfile, resolvedPlayerId: remappedProfile.id, detail: null };
      }
    }

    if (narrowed.length > 1) {
      const names = narrowed.map((c) => c.name).join(", ");
      return {
        profile: null,
        resolvedPlayerId: requestedPlayerId,
        detail: `Historical player ID ${requestedPlayerId} (\"${sighting.name}\") is ambiguous across multiple live players (${names}); choose the exact full-name player from Search.`,
      };
    }
  }

  if (exactNameCandidates.length > 1) {
    return {
      profile: null,
      resolvedPlayerId: requestedPlayerId,
      detail: `Historical player ID ${requestedPlayerId} (\"${sighting.name}\") maps to multiple live players; choose the exact player from Search.`,
    };
  }

  // Noncritical identity data gap fallback: when the provider has no resolvable ID at all,
  // proceed with a historical-only player profile instead of hard-blocking prediction.
  // This keeps Maiko/Moyuka-style ITF matchups runnable with lower confidence/data quality.
  const historicalOnlyProfile: PlayerProfile = {
    id: requestedPlayerId,
    name: sighting.name,
    fullName: null,
    countryCode: null,
    currentRank: null,
    tour: sighting.tour,
    age: null,
    plays: null,
    source: "historical-match",
  };

  logger.warn(
    { requestedPlayerId, sightingName: sighting.name, sightingTour: sighting.tour },
    "Falling back to historical-only player profile for prediction because no provider-resolvable ID was found",
  );
  return { profile: historicalOnlyProfile, resolvedPlayerId: requestedPlayerId, detail: null };
}

/**
 * Resolves a player profile the way every prediction route needs: try the live provider first
 * (works for ANY known player_key, not just standings-listed ones -- confirmed live 2026-07-11
 * against a real Challenger-only player_key), and when the provider found them but couldn't
 * attach a live tour/rank (not in current standings), fall back to their own most recent real
 * historical match record for `tour` -- honestly labeled `source: "historical-match"`, never
 * presented as a live ranking.
 *
 * Returns null only when the provider itself has no record of this player_key at all -- the one
 * case that really is "not found", unchanged from before.
 */
export async function resolvePlayerProfile(provider: TennisDataProvider, playerId: string): Promise<PlayerProfile | null> {
  const player = await provider.getPlayer(playerId);
  if (!player) return null;
  if (player.tour !== null) return player; // already resolved from live standings

  const sighting = await findMostRecentHistoricalSighting(playerId);
  if (!sighting || sighting.tour === null) {
    // Genuinely unresolvable from any connected source -- leave tour null and source undefined
    // rather than guessing. Callers building prediction warnings should treat this distinctly
    // from a player who simply hasn't had their historical match data fetched yet.
    return player;
  }

  logger.info({ playerId, tour: sighting.tour }, "Resolved player tour from historical match record (not in current live standings)");
  return { ...player, tour: sighting.tour, source: "historical-match" };
}

/**
 * Extends the provider's own name search (current ATP/WTA standings only) with real matches
 * found in our own previously-fetched historical match records -- e.g. Challenger/ITF players who
 * have never been in a top-ranking standings snapshot but have played (and been recorded playing)
 * a real match we already imported. Never fabricates a player; every result is an exact
 * `player_key` + name the provider itself reported on some real match.
 */
export async function searchKnownPlayers(provider: TennisDataProvider, query: string): Promise<PlayerSummary[]> {
  // Nickname expansion: if the query is a well-known moniker (e.g. "Rafa"), also search by the
  // canonical full name ("Rafael Nadal") so the result set includes the actual player record,
  // which downstream word-subset matching can then confidently identify.
  const normalizedQuery = normalizePlayerName(query.trim());
  const expandedName = WELL_KNOWN_NICKNAMES[normalizedQuery];

  const [primaryResults, expandedResults] = await Promise.all([
    provider.searchPlayers(query),
    expandedName ? provider.searchPlayers(expandedName) : Promise.resolve([] as PlayerSummary[]),
  ]);

  const liveResults = [...primaryResults];
  if (expandedResults.length > 0) {
    const existingIds = new Set(primaryResults.map((p) => p.id));
    for (const p of expandedResults) {
      if (!existingIds.has(p.id)) { liveResults.push(p); existingIds.add(p.id); }
    }
  }

  // Filter abbreviated/weak names from live results (e.g. "M. Uchijima" from provider standings).
  // These are not stable identity keys -- they're ambiguous across multiple full-name players
  // sharing the same initial+surname (e.g. Maiko vs. Moyuka Uchijima). Historical filtering
  // already blocks weak names from the historical fallback; this closes the same gap for live.
  const filteredLiveResults = liveResults.filter((p) => !isWeakIdentityNameKey(normalizePlayerName(p.name)));

  const seenIds = new Set(filteredLiveResults.map((p) => p.id));

  const lowerQuery = query.toLowerCase().trim();
  const likePattern = `%${lowerQuery}%`;
  let historicalRows: HistoricalPlayerRow[] = [];
  try {
    const [asPlayer1Rows, asPlayer2Rows] = await Promise.all([
      db
        .select({ id: historicalMatchesTable.player1Id, name: historicalMatchesTable.player1Name, tour: historicalMatchesTable.tour })
        .from(historicalMatchesTable)
        .where(and(sql`lower(${historicalMatchesTable.player1Name}) like ${likePattern}`, sql`${historicalMatchesTable.player1Name} not like '%/%'`, sql`${historicalMatchesTable.player1Name} !~ ' [A-Z]$'`))
        .limit(100),
      db
        .select({ id: historicalMatchesTable.player2Id, name: historicalMatchesTable.player2Name, tour: historicalMatchesTable.tour })
        .from(historicalMatchesTable)
        .where(and(sql`lower(${historicalMatchesTable.player2Name}) like ${likePattern}`, sql`${historicalMatchesTable.player2Name} not like '%/%'`, sql`${historicalMatchesTable.player2Name} !~ ' [A-Z]$'`))
        .limit(100),
    ]);
    historicalRows = [...asPlayer1Rows, ...asPlayer2Rows];
  } catch (err) {
    logger.warn({ err, query }, "Historical player search fallback unavailable; returning live provider search results only");
  }

  const historicalById = new Map<string, HistoricalPlayerRow>();
  for (const row of historicalRows) {
    if (seenIds.has(row.id)) continue; // already covered by the live standings result
    const existing = historicalById.get(row.id);
    // Keep the first-seen tour for a given id -- good enough for a "last known tour" disclosure;
    // exact recency isn't worth a second query here since this is a supplementary search result.
    if (!existing) historicalById.set(row.id, row);
  }

  const historicalSummaries: PlayerSummary[] = [];
  for (const row of historicalById.values()) {
    const historicalNorm = normalizePlayerName(row.name);
    const historicalNameIsWeak = isWeakIdentityNameKey(historicalNorm);
    const validated = await validateHistoricalPlayerId(provider, row.id);

    // Explicitly stale/invalid historical ID: don't present it as a selectable player.
    if (validated === null) continue;

    if (validated) {
      const validatedNameIsWeak = isWeakIdentityNameKey(normalizePlayerName(validated.name));
      if (validatedNameIsWeak) continue;
      historicalSummaries.push({
        id: validated.id,
        name: validated.name,
        countryCode: validated.countryCode,
        currentRank: validated.currentRank,
        tour: validated.tour ?? row.tour,
        source: "historical-match",
      });
      continue;
    }

    // Provider validation unavailable (transient provider error): keep the historical row,
    // clearly labeled, rather than dropping all fallback coverage. Weak abbreviated names are
    // still excluded because they are not stable identity records.
    if (historicalNameIsWeak) continue;
    historicalSummaries.push({
      id: row.id,
      name: row.name,
      countryCode: null,
      currentRank: null,
      tour: row.tour,
      source: "historical-match",
    });
  }

  const deduped = new Map<string, PlayerSummary>();
  for (const player of [...filteredLiveResults, ...historicalSummaries]) {
    if (!deduped.has(player.id)) deduped.set(player.id, player);
  }
  const results = Array.from(deduped.values()).slice(0, 25);
  await enrichCountryCodes(provider, results);
  return results;
}

/**
 * Historical-match rows never carry a country (not stored on `historical_matches`), but
 * API-Tennis's `get_players` DOES have it for any known `player_key` -- it's just not fetched
 * for every search result to avoid an N+1 live call per keystroke. Bounded, best-effort
 * enrichment: only the top `MAX_COUNTRY_ENRICHMENTS` historical-match results (the ones actually
 * visible without scrolling) are resolved, each cached by player_key so repeated searches/keystrokes
 * for the same player never re-hit the provider. A lookup failure (unavailable provider, unknown
 * key) leaves `countryCode` honestly `null` -- never guessed.
 */
const MAX_COUNTRY_ENRICHMENTS = 5;
const COUNTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // country codes don't change; cache generously
const countryCodeCache = new Map<string, { countryCode: string | null; cachedAt: number }>();

async function enrichCountryCodes(provider: TennisDataProvider, results: PlayerSummary[]): Promise<void> {
  const candidates = results.filter((r) => r.source === "historical-match" && r.countryCode === null).slice(0, MAX_COUNTRY_ENRICHMENTS);
  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map(async (summary) => {
      const cached = countryCodeCache.get(summary.id);
      if (cached && Date.now() - cached.cachedAt < COUNTRY_CACHE_TTL_MS) {
        summary.countryCode = cached.countryCode;
        return;
      }
      try {
        const profile = await provider.getPlayer(summary.id);
        const countryCode = profile?.countryCode ?? null;
        countryCodeCache.set(summary.id, { countryCode, cachedAt: Date.now() });
        summary.countryCode = countryCode;
      } catch (err) {
        // Provider unavailable or unknown key -- leave countryCode null (already its default),
        // never guess. Don't cache failures so a transient outage gets retried next search.
        logger.warn({ err, playerId: summary.id }, "Failed to enrich historical-match search result with a live country code");
      }
    }),
  );
}

/** Test-only escape hatch: clears the module-level country-code cache between test cases. */
export function clearCountryCodeCacheForTests(): void {
  countryCodeCache.clear();
}

// ─── Rank enrichment ─────────────────────────────────────────────────────────

/**
 * Best-effort rank enrichment via the provider's name-search endpoint (which, for MatchStat /
 * tennis-api-atp-wta-itf, searches through the live ATP/WTA rankings list).
 *
 * Called when a player's `currentRank` is null after the primary profile resolution — for example,
 * when the player is known to the provider but is not in the current live standings snapshot that
 * the regular `getPlayer` path consults. In that case, the rankings-search path (which MatchStat
 * serves from a different endpoint) may still carry their current rank.
 *
 * Matching is exact-normalized-name only — if the search returns multiple results or no result
 * whose normalized name equals the player's own, the profile is returned unchanged. Never guesses
 * between ambiguous candidates, and never falls back to a partial/fuzzy match.
 *
 * Failures (provider unavailable, rate limit, unexpected response) are silently swallowed — the
 * caller will proceed with `currentRank: null` and surface honest "missing rank" disclosures.
 */
export async function enrichPlayerRankFromSearch(
  provider: TennisDataProvider,
  player: PlayerProfile,
): Promise<PlayerProfile> {
  if (player.currentRank !== null) return player; // already have a rank

  try {
    const results = await provider.searchPlayers(player.name);
    const normalizedTarget = normalizePlayerName(player.name);

    // Collect ALL exact-normalized-name candidates that carry a rank.
    // "Exactly one" is the safety rule: if multiple players share the same normalized
    // name and all have a rank, we cannot determine which rank belongs to THIS player
    // without a reliable cross-provider ID linkage — so we don't guess.
    const exactMatches = results.filter(
      (r) => normalizePlayerName(r.name) === normalizedTarget && r.currentRank != null,
    );

    if (exactMatches.length === 1) {
      // Exactly one ranked candidate with this exact normalized name → safe to adopt.
      logger.debug(
        { playerId: player.id, playerName: player.name, rankFound: exactMatches[0].currentRank },
        "Enriched missing player rank via search endpoint",
      );
      return { ...player, currentRank: exactMatches[0].currentRank! };
    }

    if (exactMatches.length > 1) {
      // Multiple candidates share this name — cannot tell which rank belongs here.
      logger.debug(
        { playerId: player.id, playerName: player.name, candidateCount: exactMatches.length },
        "Rank enrichment skipped — multiple exact-name matches, ambiguous identity",
      );
    }
    // Zero matches → rank stays null; the honest "missing rank" disclosure fires downstream.
  } catch (err) {
    // Provider unavailable or search failed — leave rank null, never guess.
    logger.debug({ err, playerName: player.name }, "Rank enrichment via search failed — rank stays null");
  }

  return player;
}
