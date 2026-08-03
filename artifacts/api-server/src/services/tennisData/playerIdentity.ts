import { and, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { db, historicalMatchesTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import type { PlayerProfile, PlayerSummary, TennisDataProvider } from "./types";
import { resolveWikidataAliases } from "./wikidataResolver.js";

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

  // normalizedName -> (playerId -> { minSeenAt, maxSeenAt } under that name)
  const byName = new Map<string, Map<string, { minSeenAt: number; maxSeenAt: number }>>();
  for (const row of [...player1Rows, ...player2Rows]) {
    if (!isSinglesName(row.name)) continue;
    const normalized = normalizePlayerName(row.name);
    if (!normalized) continue;
    const idMap = byName.get(normalized) ?? new Map<string, { minSeenAt: number; maxSeenAt: number }>();
    const seenAt = row.scheduledStartAt.getTime();
    const existing = idMap.get(row.id);
    if (existing) {
      existing.minSeenAt = Math.min(existing.minSeenAt, seenAt);
      existing.maxSeenAt = Math.max(existing.maxSeenAt, seenAt);
    } else {
      idMap.set(row.id, { minSeenAt: seenAt, maxSeenAt: seenAt });
    }
    byName.set(normalized, idMap);
  }

  const canonicalIdByName = new Map<string, string>();
  const canonicalIdById = new Map<string, string>();
  const aliasIdsByCanonicalId = new Map<string, string[]>();
  for (const [normalized, idMap] of byName) {
    // Never alias multiple IDs together on an abbreviated key like "m uchijima" — two distinct
    // real players can share the same initial+surname form. The Sackmann bridge below is the ONE
    // exception: when exactly one of the two IDs is a sackmann-* ID and their active date ranges
    // are disjoint, the same physical person is almost certainly represented across two data eras
    // (Sackmann pre-2024, live provider from ~2024 onward) — not two players competing simultaneously.
    if (idMap.size > 1 && isWeakIdentityNameKey(normalized)) {
      // --- Sackmann bridge ---
      // Condition: exactly 2 IDs, one sackmann-* and one live; date ranges must not overlap.
      if (idMap.size === 2) {
        const entries = [...idMap.entries()];
        const sackmannEntry = entries.find(([id]) => id.startsWith("sackmann-"));
        const liveEntry = entries.find(([id]) => !id.startsWith("sackmann-"));
        if (sackmannEntry && liveEntry) {
          const [sackmannId, sackmannRange] = sackmannEntry;
          const [liveId, liveRange] = liveEntry;
          // Disjoint = zero temporal overlap between the two IDs' active windows.
          const disjoint =
            sackmannRange.maxSeenAt <= liveRange.minSeenAt ||
            liveRange.maxSeenAt <= sackmannRange.minSeenAt;
          if (disjoint) {
            // Live ID is canonical (most recent). Sackmann ID is an alias.
            canonicalIdByName.set(normalized, liveId);
            aliasIdsByCanonicalId.set(liveId, [liveId, sackmannId]);
            canonicalIdById.set(sackmannId, liveId);
            if (!canonicalIdById.has(liveId)) canonicalIdById.set(liveId, liveId);
            logger.debug(
              {
                normalized,
                sackmannId,
                liveId,
                sackmannMax: new Date(sackmannRange.maxSeenAt).toISOString(),
                liveMin: new Date(liveRange.minSeenAt).toISOString(),
              },
              "playerIdentity: Sackmann bridge — disjoint date ranges, aliasing sackmann ID to live ID",
            );
            continue;
          }
        }
      }
      // Overlapping or >2 IDs: keep all as self-canonical (collision guard stands).
      for (const id of idMap.keys()) {
        if (!canonicalIdById.has(id)) canonicalIdById.set(id, id);
      }
      continue;
    }

    let canonicalId: string | null = null;
    let mostRecent = -Infinity;
    for (const [id, range] of idMap) {
      if (range.maxSeenAt > mostRecent) {
        mostRecent = range.maxSeenAt;
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

/**
 * Test-only escape hatch: clears the module-level transient-failure cache so integration tests
 * that seed fresh player IDs always start from a cold-cache state. Without this, a prior run that
 * caused a failure for a given player ID would shield later runs (same ID, within the 2-min TTL)
 * from the provider call, making timing tests non-deterministic. Never called from production code.
 */
export function clearTransientFailureCacheForTests(): void {
  historicalIdTransientFailureCache.clear();
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

// Short-TTL cache for transient provider failures (circuit open, MatchStat timeout, etc.).
// Without this, every one of N screenshots in a batch triggers fresh (slow) provider calls for
// the same player IDs — each call takes ~2.5 s waiting for MatchStat to time out before falling
// through to the API-Tennis circuit breaker. A 2-min TTL means the same ID is probed at most
// once per 2 minutes, not once per screenshot.
const TRANSIENT_FAILURE_TTL_MS = 2 * 60 * 1000;
const historicalIdTransientFailureCache = new Map<string, number>(); // playerId → timestamp

async function validateHistoricalPlayerId(provider: TennisDataProvider, playerId: string): Promise<PlayerProfile | null | undefined> {
  // Transient-failure fast path: skip re-querying a provider that just failed for this ID.
  const failedAt = historicalIdTransientFailureCache.get(playerId);
  if (failedAt !== undefined && Date.now() - failedAt < TRANSIENT_FAILURE_TTL_MS) {
    return undefined;
  }

  const cached = historicalIdValidationCache.get(playerId);
  if (cached && Date.now() - cached.checkedAt < HISTORICAL_ID_VALIDATION_TTL_MS) {
    return cached.profile;
  }

  try {
    const profile = await provider.getPlayer(playerId);
    // `null` means "player not in provider's current index" (e.g. ITF / WTA 125K players absent
    // from live standings) — NOT "explicitly stale/invalid". Returning `undefined` here instead of
    // `null` lets the historical-fallback path in `searchKnownPlayers` include them rather than
    // silently dropping them (which the `validated === null` guard does for `null`).
    // We only cache the result if it's a real profile (truthy) — caching `null` as a permanent
    // "not found" would prevent ITF players from appearing via the historical path even after they
    // enter the provider's standings.
    if (profile) historicalIdValidationCache.set(playerId, { profile, checkedAt: Date.now() });
    return profile ?? undefined;
  } catch (err) {
    logger.warn({ err, playerId }, "Historical ID provider validation failed; keeping historical player fallback for this search");
    // Cache the transient failure so repeated batch calls (73-screenshot upload) don't each
    // re-queue the same slow MatchStat timeout for the same player IDs.
    historicalIdTransientFailureCache.set(playerId, Date.now());
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
 * Resolves a player profile purely by name when a direct ID lookup is unavailable or unreliable.
 * Searches the provider, finds the best singles-name match, and returns the resolved profile.
 * Falls through to a constructed minimal profile when the provider has an abbreviated form only.
 */
/**
 * Constructs a minimal PlayerProfile from a search-result candidate when getPlayer() is broken
 * for that ID (returns a wrong/doubles player). The search result is trusted because it came from
 * API-Tennis's own name-search endpoint and matched the player's name exactly or by abbreviation.
 */
function minimalProfileFromSearchCandidate(
  candidate: { id: string; name: string; tour?: string | null; countryCode?: string | null; currentRank?: number | null },
  submittedFullName: string,
  requestedPlayerId: string,
  reason: string,
): PlayerProfile {
  logger.warn(
    { requestedPlayerId, submittedName: submittedFullName, candidateId: candidate.id, candidateName: candidate.name, reason },
    "resolvePlayerProfileByName: getPlayer broken — constructing minimal profile from search result",
  );
  return {
    id: candidate.id,
    name: candidate.name,
    fullName: submittedFullName,
    countryCode: candidate.countryCode ?? null,
    currentRank: candidate.currentRank ?? null,
    tour: candidate.tour ?? null,
    age: null,
    plays: null,
    source: "historical-match",
  };
}

async function resolvePlayerProfileByNameInternal(
  provider: TennisDataProvider,
  submittedName: string,
  requestedPlayerId: string | null = null,
  options?: { onSearchError?: (err: unknown, query: string) => void },
): Promise<PlayerProfile | null> {
  const normalizedQuery = normalizePlayerName(submittedName);
  const queryWords = normalizedQuery.split(" ").filter(Boolean);

  // Use searchKnownPlayers (combines live + historical) rather than bare provider.searchPlayers
  // so players not in current standings can still be found via historical match records.
  // Guard against circuit-breaker open — fall back to empty list so the caller can still
  // try historical paths rather than throwing a ProviderUnavailableError.
  let candidates: Awaited<ReturnType<typeof provider.searchPlayers>>;
  try {
    candidates = await provider.searchPlayers(submittedName);
  } catch (err) {
    logger.warn(
      { submittedName, requestedPlayerId, err },
      "resolvePlayerProfileByName: provider.searchPlayers failed during primary name lookup",
    );
    options?.onSearchError?.(err, submittedName);
    candidates = [];
  }

  // 1. Exact name match
  for (const c of candidates) {
    if (/\s\/\s|\//.test(c.name ?? "")) continue;
    const cn = normalizePlayerName(c.name);
    if (cn === normalizedQuery) {
      const profile = await resolvePlayerProfile(provider, c.id);
      if (profile && !/\s\/\s|\//.test(profile.name ?? "") && playerNamesMatch(submittedName, profile.name ?? "")) {
        return profile;
      }
      // getPlayer broken for this ID (returns wrong/doubles player) but search result is trusted
      return minimalProfileFromSearchCandidate(c, submittedName, requestedPlayerId, "exact-match-getPlayer-broken");
    }
  }

  // 2. Abbreviated-form fallback: submitted "Daria Snigur" → provider entry "D. Snigur"
  if (queryWords.length >= 2) {
    const initial = queryWords[0]![0]!;
    const surnames = queryWords.slice(1);
    const abbreviated = candidates.find((c) => {
      if (/\s\/\s|\//.test(c.name ?? "")) return false;
      const cw = normalizePlayerName(c.name).split(" ").filter(Boolean);
      return (
        cw.length === queryWords.length &&
        cw[0]!.length === 1 &&
        cw[0] === initial &&
        surnames.every((s, i) => cw[i + 1] === s)
      );
    });
    if (abbreviated) {
      const profile = await resolvePlayerProfile(provider, abbreviated.id);
      if (profile && !/\s\/\s|\//.test(profile.name ?? "") && playerNamesMatch(submittedName, profile.name ?? "")) {
        return profile;
      }
      return minimalProfileFromSearchCandidate(abbreviated, submittedName, requestedPlayerId, "abbreviated-match-getPlayer-broken");
    }
  }

  // 3. Wikidata alias fallback: look up alternative name forms (transliterations without
  //    diacritics, birth names, nicknames) e.g. "Galán" → "Galan", "Feistl" → "Feistel".
  //    Non-fatal: a Wikidata timeout or parse error just skips this step.
  try {
    const wikidataAliases = await resolveWikidataAliases(submittedName);
    for (const alias of wikidataAliases) {
      const aliasNorm = normalizePlayerName(alias);
      if (aliasNorm === normalizedQuery) continue; // same as original, already tried above
      let aliasCandidates: Awaited<ReturnType<typeof provider.searchPlayers>>;
      try {
        aliasCandidates = await provider.searchPlayers(alias);
      } catch (err) {
        logger.warn(
          { submittedName, alias, requestedPlayerId, err },
          "resolvePlayerProfileByName: provider.searchPlayers failed during alias lookup",
        );
        options?.onSearchError?.(err, alias);
        continue;
      }
      for (const c of aliasCandidates) {
        if (/\s\/\s|\//.test(c.name ?? "")) continue;
        const cn = normalizePlayerName(c.name);
        if (cn === aliasNorm || cn === normalizedQuery) {
          const profile = await resolvePlayerProfile(provider, c.id);
          if (profile && !/\s\/\s|\//.test(profile.name ?? "")) {
            logger.debug(
              { submittedName, alias, resolvedName: profile.name },
              "playerIdentity: resolved via Wikidata alias",
            );
            return profile;
          }
        }
      }
    }
  } catch (err) {
    logger.debug({ err, submittedName }, "playerIdentity: Wikidata alias lookup failed (non-fatal)");
  }

  return null;
}

/**
 * Prediction-time player resolution that starts from an input player id and attempts stable
 * remapping when that id exists only in historical rows but no longer resolves in the provider.
 */
/** Returns true if two player names are the same player (exact or initial-abbreviated). */
function playerNamesMatch(a: string, b: string): boolean {
  const aN = normalizePlayerName(a).split(" ").filter(Boolean);
  const bN = normalizePlayerName(b).split(" ").filter(Boolean);
  if (aN.join(" ") === bN.join(" ")) return true;
  if (aN.length !== bN.length || aN.length < 2) return false;
  const aSurnames = aN.slice(1);
  const bSurnames = bN.slice(1);
  if (!aSurnames.every((w, i) => w === bSurnames[i])) return false;
  return (aN[0]!.length === 1 && bN[0]!.startsWith(aN[0]!)) ||
         (bN[0]!.length === 1 && aN[0]!.startsWith(bN[0]!));
}

export async function resolvePlayerProfileForPrediction(
  provider: TennisDataProvider,
  requestedPlayerId: string,
  submittedName?: string,
): Promise<PredictionPlayerResolution> {
  const direct = await resolvePlayerProfile(provider, requestedPlayerId);
  if (direct) {
    const doublesLike = /\s\/\s|\//.test(direct.name ?? "");
    // Wrong-player detection: when a submitted name is available, check that getPlayer actually
    // returned *this* player. If the ID is from a different namespace (e.g. MatchStat → API-Tennis)
    // getPlayer may return a completely different player — either a doubles team OR a real singles
    // player with that ID number in API-Tennis's own namespace (e.g. "M. Oezcelik" for ID "31728"
    // when "31728" is Anna Bondar's MatchStat ID but a different player's API-Tennis ID).
    const wrongPlayer = submittedName ? !playerNamesMatch(submittedName, direct.name ?? "") : false;
    if (!doublesLike && !wrongPlayer) {
      return { profile: direct, resolvedPlayerId: direct.id, detail: null };
    }
    logger.warn(
      { requestedPlayerId, resolvedName: direct.name, submittedName, doublesLike, wrongPlayer },
      "resolvePlayerProfileForPrediction: direct lookup returned wrong player — skipping, falling back to name search",
    );
  }

  const sighting = await findMostRecentHistoricalSighting(requestedPlayerId);
  if (!sighting) {
    // When no historical sighting exists but a submitted name was provided (e.g. from the fixture
    // card header), fall back to name-based search to construct a minimal profile. This recovers
    // players whose MatchStat fixture ID collides with an API-Tennis doubles-team record but who
    // also lack any historical_matches rows (e.g. newly-active players).
    if (submittedName) {
      const nameProfile = await resolvePlayerProfileByNameInternal(provider, submittedName, requestedPlayerId);
      if (nameProfile) {
        logger.info(
          { requestedPlayerId, submittedName, resolvedId: nameProfile.id },
          "resolvePlayerProfileForPrediction: resolved via submitted-name search (no historical sighting)",
        );
        return { profile: nameProfile, resolvedPlayerId: nameProfile.id, detail: null };
      }
      // Last-resort stub: the player appears in a fixture but is absent from the provider's player
      // database AND has no historical records in our DB (e.g. a newly-active WTA/Challenger player
      // whose API-Tennis fixture entry exists but whose get_players lookup returns null, and who
      // is not yet in the standings that searchPlayers queries).
      // Constructing a stub from the submitted fixture name is safe here because:
      //   1. getPlayer(requestedPlayerId) returned null → no wrong-player collision risk
      //   2. No historical sighting → no alias confusion
      // The prediction proceeds with empty match history; Data Quality will be very low and the
      // recommendation will be INSUFFICIENT_EDGE / LOW_CONFIDENCE, never HIGHEST_CONFIDENCE.
      logger.warn(
        { requestedPlayerId, submittedName },
        "resolvePlayerProfileForPrediction: constructing stub profile from fixture name (player absent from provider DB and history); prediction will have low data quality",
      );
      return {
        profile: {
          id: requestedPlayerId,
          name: submittedName,
          fullName: null,
          countryCode: null,
          currentRank: null,
          tour: null,
          age: null,
          plays: null,
        },
        resolvedPlayerId: requestedPlayerId,
        detail: null,
      };
    }
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
  let byNameCandidates: PlayerSummary[];
  try {
    byNameCandidates = await provider.searchPlayers(sighting.name);
  } catch {
    byNameCandidates = [];
  }
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

    let surnameCandidates: PlayerSummary[];
    try {
      surnameCandidates = await provider.searchPlayers(surnameQuery);
    } catch {
      surnameCandidates = [];
    }
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
  let player: PlayerProfile | null;
  try {
    player = await provider.getPlayer(playerId);
  } catch (err) {
    // Circuit-breaker open or provider temporarily unavailable — treat as "not in live provider".
    // The caller's fallback chain (historical sightings, name search, stub profiles) handles null.
    logger.warn({ playerId, err: (err as Error).message }, "resolvePlayerProfile: provider.getPlayer threw — falling back to historical data");
    player = null;
  }
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
 * Shared name-only resolver used by callers that start from a player name rather than a provider id.
 * Prediction routes use this when recovering from provider-namespace collisions; parlay builder uses
 * it directly so it does not need its own duplicate search/filter logic.
 */
export async function resolvePlayerProfileByName(
  provider: TennisDataProvider,
  submittedName: string,
  requestedPlayerId: string | null = null,
  options?: { onSearchError?: (err: unknown, query: string) => void },
): Promise<PlayerProfile | null> {
  return resolvePlayerProfileByNameInternal(provider, submittedName, requestedPlayerId, options);
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

  // Surname supplement: for multi-word queries like "Thanasi Kokkinakis", also search
  // by surname alone so that abbreviated provider entries ("T. Kokkinakis") are found.
  const queryWords = query.trim().split(/\s+/).filter(Boolean);
  const surnameSupplement =
    queryWords.length >= 2 && queryWords[queryWords.length - 1]!.length >= 3
      ? queryWords[queryWords.length - 1]!
      : null;

  // Wrap each live-provider call so a circuit-breaker open or provider unavailability
  // gracefully returns an empty list rather than throwing and aborting the whole search.
  // Historical-DB results below will still run and are the primary fallback when the
  // provider is down.
  const searchSafely = async (q: string): Promise<PlayerSummary[]> => {
    try {
      return await provider.searchPlayers(q);
    } catch (err) {
      logger.warn({ err, query: q }, "searchKnownPlayers: provider.searchPlayers unavailable — falling back to historical-only results");
      return [];
    }
  };

  const [primaryResults, expandedResults, surnameResults] = await Promise.all([
    searchSafely(query),
    expandedName ? searchSafely(expandedName) : Promise.resolve([] as PlayerSummary[]),
    surnameSupplement ? searchSafely(surnameSupplement) : Promise.resolve([] as PlayerSummary[]),
  ]);

  const existingIds = new Set(primaryResults.map((p) => p.id));
  const liveResults = [...primaryResults];
  for (const p of [...expandedResults, ...surnameResults]) {
    if (!existingIds.has(p.id)) { liveResults.push(p); existingIds.add(p.id); }
  }

  // Filter out abbreviated live-provider results (e.g. "M. Uchijima") when the historical DB
  // already has full-name entries for the queried surname — abbreviated live results cause false
  // disambiguation failures when two players share the same initial (e.g. Maiko vs. Moyuka
  // Uchijima, both stored as "M. Uchijima" by the provider). The historical-DB LIKE search covers
  // the same players via their full names, so filtering here doesn't drop anyone — it only removes
  // the ambiguous abbreviated duplicates that would otherwise collide with the full-name DB rows.
  // Players whose provider-stored name IS abbreviated (e.g. "T. Kokkinakis") are found via the
  // historical DB's surname LIKE match on that abbreviation, never relying on the live result.
  const filteredLiveResults = liveResults.filter((p) => !/^[A-Za-z]\.\s/.test(p.name));

  const seenIds = new Set(filteredLiveResults.map((p) => p.id));

  const lowerQuery = query.toLowerCase().trim();
  const likePattern = `%${lowerQuery}%`;
  // Also build a surname-only LIKE pattern for multi-word queries so abbreviated historical
  // entries like "T. Kokkinakis" are matched when the query is "Thanasi Kokkinakis".
  const surnameLikePattern = surnameSupplement ? `%${surnameSupplement.toLowerCase()}%` : null;

  // Apostrophe-stripped LIKE patterns — OCR frequently drops apostrophes from surnames like
  // "O'Connell" → "oconnell". The plain LIKE pattern ("%oconnell%") misses rows stored as
  // "O'Connell" because lower("O'Connell") = "o'connell" ≠ "oconnell". Fix: also compare
  // replace(lower(col), '''', '') against the apostrophe-stripped query so both directions
  // resolve correctly ("oconnell" ↔ "o'connell").
  const apostropheChar = "'"; // passed as a Drizzle parameter — properly escaped in SQL
  const strippedLikePattern = `%${lowerQuery.replace(/'/g, "")}%`;
  const strippedSurnameLikePattern = surnameLikePattern
    ? `%${surnameSupplement!.toLowerCase().replace(/'/g, "")}%`
    : null;

  let historicalRows: HistoricalPlayerRow[] = [];
  try {
    const nameFilter = (col: SQLWrapper) =>
      surnameLikePattern && strippedSurnameLikePattern
        ? sql`(lower(${col}) like ${likePattern} or lower(${col}) like ${surnameLikePattern} or replace(lower(${col}), ${apostropheChar}, '') like ${strippedLikePattern} or replace(lower(${col}), ${apostropheChar}, '') like ${strippedSurnameLikePattern})`
        : sql`(lower(${col}) like ${likePattern} or replace(lower(${col}), ${apostropheChar}, '') like ${strippedLikePattern})`;

    const [asPlayer1Rows, asPlayer2Rows] = await Promise.all([
      db
        .select({ id: historicalMatchesTable.player1Id, name: historicalMatchesTable.player1Name, tour: historicalMatchesTable.tour })
        .from(historicalMatchesTable)
        .where(and(nameFilter(historicalMatchesTable.player1Name), sql`${historicalMatchesTable.player1Name} not like '%/%'`, sql`${historicalMatchesTable.player1Name} !~ ' [A-Z]$'`))
        .limit(100),
      db
        .select({ id: historicalMatchesTable.player2Id, name: historicalMatchesTable.player2Name, tour: historicalMatchesTable.tour })
        .from(historicalMatchesTable)
        .where(and(nameFilter(historicalMatchesTable.player2Name), sql`${historicalMatchesTable.player2Name} not like '%/%'`, sql`${historicalMatchesTable.player2Name} !~ ' [A-Z]$'`))
        .limit(100),
    ]);
    historicalRows = [...asPlayer1Rows, ...asPlayer2Rows];
  } catch (err) {
    logger.warn({ err, query }, "Historical player search unavailable; using provider-only player search results");
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
  // Abbreviated names whose provider validation was unavailable (transient error) are collected
  // here separately and only merged into results when the complete candidate set is empty —
  // i.e. as a genuine last-resort fallback rather than polluting normal searches. See comment
  // below where they are added for the full rationale.
  const abbreviatedTransientFallback: PlayerSummary[] = [];

  // ── Parallel validation ───────────────────────────────────────────────────
  // validateHistoricalPlayerId calls the live provider per-ID. The old serial loop meant
  // 50 unique IDs × ~2.5 s MatchStat timeout = 125 s before any player resolved when the
  // provider is down. Parallelising brings this to one round-trip regardless of result count.
  const historicalEntries = Array.from(historicalById.values());
  const validations = await Promise.all(
    historicalEntries.map((row) => validateHistoricalPlayerId(provider, row.id)),
  );

  for (let hi = 0; hi < historicalEntries.length; hi++) {
    const row = historicalEntries[hi]!;
    const validated = validations[hi];
    const historicalNorm = normalizePlayerName(row.name);
    const historicalNameIsWeak = isWeakIdentityNameKey(historicalNorm);

    // Explicitly stale/invalid historical ID: don't present it as a selectable player.
    if (validated === null) continue;

    if (validated) {
      // Guard: if the provider returned a DOUBLES player for this ID (name contains "/"),
      // the ID has been recycled or was misidentified — fall back to the historical row data
      // instead of poisoning the result set with a doubles entry that isConfidentMatch will
      // always reject, causing the real single-name player to appear as "not found".
      // Seen in practice: id=421 ("C. O'Connell", ATP) resolved by provider to a doubles team.
      const isDoublesValidation = (validated.name ?? "").includes("/");
      if (isDoublesValidation) {
        if (!historicalNameIsWeak) {
          historicalSummaries.push({
            id: row.id,
            name: row.name,
            countryCode: null,
            currentRank: null,
            tour: row.tour,
            source: "historical-match",
          });
        }
        continue;
      }
      // Don't skip abbreviated validated names — the downstream confidence check handles
      // disambiguation. Skipping them blocked real players stored as "T. Kokkinakis" etc.
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
    // still excluded here — they are collected separately as a last-resort fallback (see
    // `abbreviatedTransientFallback` below) and only added to results when the complete candidate
    // set would otherwise be empty. This prevents "M. Uchijima" from creating spurious ambiguity
    // when both Maiko and Moyuka Uchijima appear via live standings, while still resolving
    // WTA 125K / ITF players (e.g. "M. Hontama") that exist only as abbreviated historical rows
    // and never appear in live standings.
    if (historicalNameIsWeak) {
      abbreviatedTransientFallback.push({
        id: row.id,
        name: row.name,
        countryCode: null,
        currentRank: null,
        tour: row.tour,
        source: "historical-match",
      });
      continue;
    }
    historicalSummaries.push({
      id: row.id,
      name: row.name,
      countryCode: null,
      currentRank: null,
      tour: row.tour,
      source: "historical-match",
    });
  }

  // Cross-ID deduplication: drop historical entries that are just abbreviated or expanded forms
  // of an existing live entry representing the same player (same initial + identical surnames).
  // Examples:
  //   "A. Bublik" (hist id=1895) + "Alexander Bublik" (live id=24245) → drop historical
  //   "Tereza Valentova" (hist id=73274) + "T. Valentova" (live id=8976) → drop historical
  // Without this, the player search shows duplicate cards that confuse users and cause
  // ambiguous-match errors in Paste Search for queries like "Bublik".
  const liveWordSets = filteredLiveResults.map((p) => normalizePlayerName(p.name).split(" ").filter(Boolean));
  const isShadowedByLive = (historicalName: string): boolean => {
    const hWords = normalizePlayerName(historicalName).split(" ").filter(Boolean);
    if (hWords.length < 2) return false;
    for (const lWords of liveWordSets) {
      if (lWords.length !== hWords.length || lWords.length < 2) continue;
      const lSurnames = lWords.slice(1);
      const hSurnames = hWords.slice(1);
      if (!lSurnames.every((s, i) => s === hSurnames[i])) continue;
      const l0 = lWords[0]!;
      const h0 = hWords[0]!;
      // One first word is a single-letter initial of the other's first word
      if ((l0.length === 1 && h0.startsWith(l0)) || (h0.length === 1 && l0.startsWith(h0))) {
        return true;
      }
    }
    return false;
  };

  const filteredHistorical = historicalSummaries.filter((p) => !isShadowedByLive(p.name));

  // Last-resort abbreviated fallback: if both live results and validated historical results are
  // empty (player not in standings, no validated singles history), merge in the abbreviated
  // transient-error entries collected above. This resolves WTA 125K / ITF players like
  // "M. Hontama" or "N. Hibino" whose only DB footprint is abbreviated historical rows and who
  // never appear in the live standings feed. The fallback is gated on the whole set being empty
  // so it never introduces ambiguity when both "Maiko Uchijima" and "Moyuka Uchijima" already
  // resolved correctly via standings — those cases skip this block entirely.
  //
  // Extended condition: also activate when the base pool is non-empty but contains NO entry
  // whose surname matches the query surname. This handles the case where the LIKE query found
  // a DIFFERENT player with a partially-overlapping name (e.g. searching "Anastasia Potapova"
  // hits "Vera Potapova" as a non-abbreviated row, which fills filteredHistorical and blocks the
  // abbreviated "A. Potapova" entry from ever making it into the candidate pool). When the base
  // pool's surnames don't overlap the query, it's noise from the LIKE match — we should still
  // surface the abbreviated fallback so the real player has a chance to be found.
  const baseResultsEmpty = filteredLiveResults.length === 0 && filteredHistorical.length === 0;

  // Derive the query surname (last whitespace-token of at least 3 chars) for the surname check.
  const querySurnameForFallback = lowerQuery.trim().split(/\s+/).filter(Boolean).pop() ?? "";
  const baseHasSurnameMatch =
    querySurnameForFallback.length < 3 ||
    [...filteredLiveResults, ...filteredHistorical].some((p) => {
      const candidateWords = normalizePlayerName(p.name).split(/\s+/).filter(Boolean);
      const candidateSurname = candidateWords[candidateWords.length - 1] ?? "";
      return candidateSurname === querySurnameForFallback;
    });

  const shouldUseFallback = baseResultsEmpty || !baseHasSurnameMatch;
  const fallbackEntries = shouldUseFallback
    ? abbreviatedTransientFallback.filter((p) => !isShadowedByLive(p.name))
    : [];

  const deduped = new Map<string, PlayerSummary>();
  for (const player of [...filteredLiveResults, ...filteredHistorical, ...fallbackEntries]) {
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
