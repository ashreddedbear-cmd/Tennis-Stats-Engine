/**
 * Live provider fetch for the Parlay Builder Validation Engine.
 *
 * When a player is absent from the local historical_matches cache after all
 * DB-layer resolution attempts, this module queries every configured external
 * tennis provider in the same order as the prediction engine, and returns
 * their match records for use as validation evidence.
 *
 * Provider chain (mirrors compositeProvider.ts but is intentionally independent):
 *   Tier 1: RapidAPI / MatchStat  (X_RAPIDAPI_KEY) — player search via rankings
 *   Tier 2: API-Tennis            (API_TENNIS_KEY)  — player search + full match history
 *   Tier 3: Sofascore             (no key required) — supplemental history for sparse players
 *
 * Each tier has its own error handling and diagnostics.  No tier shares circuit-breaker
 * state or provider instances with the prediction engine's compositeProvider.ts — the
 * separation is intentional so a quota exhaustion in one subsystem never silently degrades
 * the other.
 *
 * Required outcomes (per architecture spec):
 *
 *   CACHE_HIT         — found in local DB (caller sets this; not returned here)
 *   CACHE_MISS        — not in local DB; this module was invoked
 *   PLAYER_RESOLVED   — matched to a canonical provider identity
 *   DATA_FOUND        — match records retrieved from provider
 *   SOURCE_UNAVAILABLE — provider failed, timed out, or could not be queried
 *   PLAYER_NOT_FOUND  — provider responded successfully but found no matching player
 *   NO_MATCH_HISTORY  — player was identified; provider returned 0 completed matches
 *   DATA_UNAVAILABLE  — all configured providers are unreachable; scoring is impossible
 *
 * A successful fetch also writes records to historical_matches (non-blocking,
 * best-effort) so subsequent requests for the same player hit the DB cache.
 */

import { pool } from "@workspace/db";
import { ApiTennisProvider } from "../tennisData/apiTennisProvider.js";
import { MatchStatProvider } from "../tennisData/matchStatProvider.js";
import {
  ProviderUnavailableError,
  type MatchRecord,
  type PlayerSummary,
} from "../tennisData/index.js";
import { fetchFromSofascore } from "./sofascoreProvider.js";
import { fetchMarketOdds } from "../oddsData/index.js";

// ─── Outcome & diagnostic types ──────────────────────────────────────────────

export type ResolutionOutcome =
  | "CACHE_HIT"
  | "CACHE_MISS"
  | "PLAYER_RESOLVED"
  | "DATA_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "PLAYER_NOT_FOUND"
  | "NO_MATCH_HISTORY"
  | "DATA_UNAVAILABLE"
  /**
   * The player was found in the local DB cache but their records were stale
   * (most-recent match older than STALE_MAX_MATCH_AGE_DAYS days, or fewer than
   * STALE_MIN_MATCH_COUNT rows).  The live provider chain was invoked and returned
   * fresh records, which replaced the stale DB rows for this validation request.
   * The fresh records are also written back to the DB so the next request hits Layer 1.
   */
  | "CACHE_HIT_SUPPLEMENTED";

export interface ProviderSourceDiagnostic {
  source: string;
  attempted: boolean;
  succeeded: boolean;
  playerFound: boolean;
  recordsReturned: number;
  providerPlayerId?: string;
  failureReason?: string;
}

export interface LiveFetchDiagnostics {
  outcome: ResolutionOutcome;
  /** Every provider the app is configured to use. */
  sourcesConfigured: string[];
  /** Providers that were actually called this request. */
  sourcesAttempted: string[];
  /** Providers that returned a usable response. */
  sourcesSuccessful: string[];
  /** Providers that errored, timed out, or returned nothing. */
  sourcesFailed: string[];
  /** How the player identity was resolved (e.g. "full-name", "surname", "normalized"). */
  playerResolutionMethod: string;
  /** Provider name → provider-internal player ID found. */
  providerIdsFound: Record<string, string>;
  /** Provider name → number of match records returned. */
  recordsPerSource: Record<string, number>;
  /** Human-readable failure explanations. */
  failureReasons: string[];
  /** Per-provider detail — enough for an admin diagnostics panel. */
  sources: ProviderSourceDiagnostic[];
}

export interface LiveFetchResult {
  records: MatchRecord[];
  resolvedPlayerId: string | null;
  resolvedPlayerName: string | null;
  tour: string | null;
  diagnostics: LiveFetchDiagnostics;
}

// ─── Lazy provider singletons ─────────────────────────────────────────────────
//
// Each provider is constructed once per process and re-used across requests.
// They are kept separate from the prediction engine's getTennisDataProvider()
// instances so quota exhaustion / circuit state in one subsystem never bleeds
// into the other.  `undefined` = not yet initialised; `null` = key absent.

let _builderRapidApiProvider: MatchStatProvider | null | undefined;
let _builderApiTennisProvider: ApiTennisProvider | null | undefined;

function getBuilderRapidApiProvider(): MatchStatProvider | null {
  if (_builderRapidApiProvider !== undefined) return _builderRapidApiProvider;
  const key = process.env.X_RAPIDAPI_KEY ?? process.env.x_rapidapi_key;
  _builderRapidApiProvider = key ? new MatchStatProvider(key) : null;
  return _builderRapidApiProvider;
}

function getBuilderApiTennisProvider(): ApiTennisProvider | null {
  if (_builderApiTennisProvider !== undefined) return _builderApiTennisProvider;
  const key = process.env.API_TENNIS_KEY;
  _builderApiTennisProvider = key ? new ApiTennisProvider(key) : null;
  return _builderApiTennisProvider;
}

// ─── Name-matching helpers ───────────────────────────────────────────────────

function extractSurname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

function extractFirstInitial(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.replace(/\./g, "").charAt(0).toUpperCase();
}

/**
 * Normalise a name string for comparison: NFD decompose, strip combining diacritics,
 * and lower-case. Applied to both queried and candidate names so "Nădal"/"Nadal",
 * "Đoković"/"Djokovic" etc. compare equal.
 */
function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Characters that do NOT decompose via NFD and must be mapped explicitly.
    // Đ (U+0110, Latin D with stroke) ≠ Ð (U+00D0, Eth) — both need entries.
    .replace(/[ŁłÐðØøÆæĐđ]/g, (c) =>
      ({ Ł: "L", ł: "l", Ð: "D", ð: "d", Ø: "O", ø: "o", Æ: "AE", æ: "ae", Đ: "D", đ: "d" }[c] ?? c),
    )
    .toLowerCase();
}

/**
 * Normalise a provider candidate name that may arrive in "Lastname, F." or
 * "Lastname, Firstname" reversed format into the standard "F. Lastname" order.
 * When no comma is present the name is returned unchanged.
 */
function normaliseCandidateName(name: string): string {
  const commaIdx = name.indexOf(",");
  if (commaIdx === -1) return name;
  const last = name.slice(0, commaIdx).trim();
  const first = name.slice(commaIdx + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Confidence check: does a provider candidate match the queried player?
 *
 * Requires both a surname match AND a first-initial match to prevent false
 * positives in common-surname collisions (e.g. "A. Singh" vs "D. Singh").
 * Both sides are NFD-normalised before comparison so diacritics in either
 * the query ("Nădal") or the candidate ("Ĉoric") never block a real match.
 */
function isConfidentSearchMatch(candidateName: string, queriedName: string): boolean {
  const normalised = normaliseCandidateName(candidateName);
  const cNorm = normaliseName(normalised);
  const qSurname = normaliseName(extractSurname(queriedName));
  const qInitial = extractFirstInitial(queriedName).toLowerCase();

  if (!cNorm.includes(qSurname)) return false;
  if (qInitial) {
    const cInitial = extractFirstInitial(normalised).toLowerCase();
    if (cInitial !== qInitial) return false;
  }
  return true;
}

/**
 * Build a prioritised list of search queries for a player name, covering:
 * full name · surname · NFD-stripped name · without leading initial.
 */
function buildSearchQueries(playerName: string): string[] {
  const queries = new Set<string>();
  const trimmed = playerName.trim();

  // 1. Full name as given ("D. Singh", "Devvrat Singh")
  queries.add(trimmed);

  // 2. Surname only — broadest, filtered by initial in result check
  const surname = trimmed.split(/\s+/).pop() ?? trimmed;
  if (surname.length >= 3) queries.add(surname);

  // 3. NFD-normalised — strips combining diacritics (é→e, ö→o, ń→n) and maps
  //    non-NFD special letters that normalize() doesn't decompose (Đ, Ł, Ø …).
  //    Must mirror the same replacement map used in normaliseName() above.
  const nfd = trimmed
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ŁłÐðØøÆæĐđ]/g, (c) =>
      ({ Ł: "L", ł: "l", Ð: "D", ð: "d", Ø: "O", ø: "o", Æ: "AE", æ: "ae", Đ: "D", đ: "d" }[c] ?? c)
    );
  if (nfd !== trimmed) queries.add(nfd);
  const nfdSurname = nfd.split(/\s+/).pop() ?? nfd;
  if (nfdSurname !== surname && nfdSurname.length >= 3) queries.add(nfdSurname);

  // 4. Strip leading initial abbreviation: "D. Singh" → "Singh"
  const withoutInitial = trimmed.replace(/^[A-Z]\.\s*/, "");
  if (withoutInitial !== trimmed && withoutInitial.length >= 2) queries.add(withoutInitial);

  return [...queries].filter((q) => q.length >= 2);
}

/** Human-readable description of which search query led to a match. */
function classifySearchMethod(query: string, originalName: string): string {
  const t = originalName.trim();
  if (query === t) return "full-name";
  if (!query.includes(" ") && query.length < 15) return "surname";
  if (query !== t && query.replace(/\s/g, "") === t.replace(/\s/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")) return "nfd-normalized";
  return "name-variant";
}

// ─── DB cache write (non-blocking best-effort) ───────────────────────────────

async function saveMatchesToDb(
  records: MatchRecord[],
  playerId: string,
  playerName: string,
  tour: string | null,
  providerLabel: string,
): Promise<void> {
  for (const rec of records) {
    const winnerId = rec.result === "W" ? playerId : rec.opponentId;
    try {
      await pool.query(
        `INSERT INTO historical_matches (
          external_id, provider, tour,
          tournament_name, tournament_level, surface, round, match_format,
          player1_id, player1_name, player2_id, player2_name, winner_id,
          score, retired, walkover, cancelled,
          player2_rank, scheduled_start_at, imported_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, false,
          $17, $18, NOW()
        )
        ON CONFLICT DO NOTHING`,
        [
          rec.id,
          providerLabel,
          tour,
          rec.tournamentName,
          rec.tournamentLevel,
          rec.surface,
          rec.round,
          rec.matchFormat,
          playerId,
          playerName,
          rec.opponentId,
          rec.opponentName,
          winnerId,
          rec.score,
          rec.retired,
          rec.walkover,
          rec.opponentRank,
          rec.date ? new Date(rec.date) : null,
        ]
      );
    } catch {
      // Silently swallow — cache write is best-effort, never blocks validation
    }
  }
}

// ─── Tier-1: RapidAPI / MatchStat ────────────────────────────────────────────

/**
 * Attempt to resolve a player's identity via the RapidAPI / MatchStat provider.
 *
 * MatchStat exposes player search through its rankings endpoints (ATP + WTA).
 * It does NOT have a per-player match history endpoint, so this function can
 * only confirm whether the player is found in current standings — it never
 * returns match records. When the player is found their MatchStat ID is recorded
 * in diagnostics for traceability. If MatchStat is unavailable or the player is
 * not found, returns null and the caller moves on to Tier 2.
 */
async function attemptRapidApi(
  playerName: string,
  diag: LiveFetchDiagnostics,
  providerOverride?: InstanceType<typeof import("../tennisData/matchStatProvider.js").MatchStatProvider> | null,
): Promise<PlayerSummary | null> {
  const provider = providerOverride !== undefined ? providerOverride : getBuilderRapidApiProvider();
  if (!provider) return null; // key not configured — skip silently

  const sourceDiag: ProviderSourceDiagnostic = {
    source: "rapidapi",
    attempted: true,
    succeeded: false,
    playerFound: false,
    recordsReturned: 0,
  };
  diag.sourcesAttempted.push("rapidapi");

  const searchQueries = buildSearchQueries(playerName);
  let foundPlayer: PlayerSummary | null = null;

  for (const query of searchQueries) {
    try {
      const results = await provider.searchPlayers(query);
      const match = results.find((r) => isConfidentSearchMatch(r.name, playerName));
      if (match) {
        foundPlayer = match;
        break;
      }
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        const reason = err.message;
        sourceDiag.failureReason = reason;
        diag.sourcesFailed.push("rapidapi");
        diag.failureReasons.push(`rapidapi search: ${reason}`);
        diag.sources.push(sourceDiag);
        return null;
      }
      // Non-fatal — try next variant
    }
  }

  if (foundPlayer) {
    sourceDiag.succeeded = true;
    sourceDiag.playerFound = true;
    sourceDiag.providerPlayerId = foundPlayer.id;
    // MatchStat has no match-history endpoint: record 0 records but mark player found
    sourceDiag.recordsReturned = 0;
    diag.sourcesSuccessful.push("rapidapi");
    diag.providerIdsFound["rapidapi"] = foundPlayer.id;
    diag.recordsPerSource["rapidapi"] = 0;
    if (diag.playerResolutionMethod === "none") {
      diag.playerResolutionMethod = "rapidapi-search";
    }
  } else {
    sourceDiag.failureReason = "Player not found in RapidAPI rankings";
    diag.sourcesFailed.push("rapidapi");
  }

  diag.sources.push(sourceDiag);
  return foundPlayer; // caller uses this as a hint (identity confirmed) even though no records
}

// ─── Tier-2: API-Tennis (full history) ───────────────────────────────────────

/**
 * Attempt to resolve a player and their match history via API-Tennis.
 *
 * API-Tennis supports both player search and full match-history retrieval, making
 * it the primary source of actual MatchRecord data in this chain. This is tried
 * after (or in parallel with) the RapidAPI tier, and returns a full LiveFetchResult
 * when records are found. Returns null when the player cannot be identified, when
 * the provider is unavailable, or when 0 completed matches are returned (Sofascore
 * tier-3 is then tried by the caller).
 */
async function attemptMatchstat(
  playerName: string,
  diag: LiveFetchDiagnostics,
  providerOverride?: InstanceType<typeof import("../tennisData/apiTennisProvider.js").ApiTennisProvider> | null,
): Promise<LiveFetchResult | null> {
  const provider = providerOverride !== undefined ? providerOverride : getBuilderApiTennisProvider();
  if (!provider) return null; // key not configured — skip silently

  const sourceDiag: ProviderSourceDiagnostic = {
    source: "api-tennis",
    attempted: true,
    succeeded: false,
    playerFound: false,
    recordsReturned: 0,
  };
  diag.sourcesAttempted.push("api-tennis");

  // ── Step 1: Search for the player ────────────────────────────────────────
  const searchQueries = buildSearchQueries(playerName);
  let foundPlayer: PlayerSummary | null = null;
  let searchMethod = "none";

  for (const query of searchQueries) {
    try {
      const results = await provider.searchPlayers(query);
      const match = results.find((r) => isConfidentSearchMatch(r.name, playerName));
      if (match) {
        foundPlayer = match;
        searchMethod = classifySearchMethod(query, playerName);
        break;
      }
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        const reason = err.message;
        sourceDiag.failureReason = reason;
        diag.sourcesFailed.push("api-tennis");
        diag.failureReasons.push(`api-tennis search: ${reason}`);
        diag.sources.push(sourceDiag);
        return null;
      }
      // Non-fatal — try next variant
    }
  }

  if (!foundPlayer) {
    sourceDiag.failureReason = "Player not found in API-Tennis";
    diag.sourcesFailed.push("api-tennis");
    diag.sources.push(sourceDiag);
    return null;
  }

  sourceDiag.playerFound = true;
  sourceDiag.providerPlayerId = foundPlayer.id;
  diag.providerIdsFound["api-tennis"] = foundPlayer.id;
  if (diag.playerResolutionMethod === "none" || diag.playerResolutionMethod === "rapidapi-search") {
    diag.playerResolutionMethod = searchMethod;
  }

  // ── Step 2: Fetch match history ───────────────────────────────────────────
  let records: MatchRecord[] = [];
  try {
    records = await provider.getPlayerMatches(foundPlayer.id);
    sourceDiag.succeeded = true;
    sourceDiag.recordsReturned = records.length;
    diag.sourcesSuccessful.push("api-tennis");
    diag.recordsPerSource["api-tennis"] = records.length;

    if (records.length > 0) {
      diag.outcome = "DATA_FOUND";

      // Non-blocking DB cache write
      saveMatchesToDb(
        records,
        foundPlayer.id,
        foundPlayer.name,
        foundPlayer.tour ?? null,
        "builder-live-fetch:api-tennis",
      ).catch(() => {});

      diag.sources.push(sourceDiag);
      return {
        records,
        resolvedPlayerId: foundPlayer.id,
        resolvedPlayerName: foundPlayer.name,
        tour: foundPlayer.tour ?? null,
        diagnostics: diag,
      };
    }

    // Player found but no completed match records
    diag.outcome = "NO_MATCH_HISTORY";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    sourceDiag.failureReason = reason;
    diag.sourcesFailed.push("api-tennis");
    diag.failureReasons.push(`api-tennis getPlayerMatches(${foundPlayer.id}): ${reason}`);
    diag.outcome = "SOURCE_UNAVAILABLE";
  }

  diag.sources.push(sourceDiag);
  return null;
}

// ─── Tier-3: Sofascore ────────────────────────────────────────────────────────

/**
 * Attempt to resolve a player and their match history via Sofascore.
 * Called after both RapidAPI and API-Tennis tiers fail to return records.
 * Updates `diag` in-place; returns a full LiveFetchResult on success, or null
 * when Sofascore also cannot provide data.
 */
async function attemptSofascore(
  playerName: string,
  diag: LiveFetchDiagnostics,
  sofascoreOverride?: typeof fetchFromSofascore,
): Promise<LiveFetchResult | null> {
  const sfFetch = sofascoreOverride ?? fetchFromSofascore;
  const sfDiag: ProviderSourceDiagnostic = {
    source: "sofascore",
    attempted: true,
    succeeded: false,
    playerFound: false,
    recordsReturned: 0,
  };
  diag.sourcesAttempted.push("sofascore");

  try {
    const sfResult = await sfFetch(playerName);

    if (sfResult.error?.includes("rate-limit")) {
      sfDiag.failureReason = sfResult.error;
      diag.sourcesFailed.push("sofascore");
      diag.failureReasons.push(`sofascore: ${sfResult.error}`);
      diag.sources.push(sfDiag);
      return null;
    }

    if (sfResult.player && sfResult.records.length > 0) {
      sfDiag.succeeded = true;
      sfDiag.playerFound = true;
      sfDiag.providerPlayerId = sfResult.player.id;
      sfDiag.recordsReturned = sfResult.records.length;
      diag.sourcesSuccessful.push("sofascore");
      diag.providerIdsFound["sofascore"] = sfResult.player.id;
      diag.recordsPerSource["sofascore"] = sfResult.records.length;
      diag.outcome = "DATA_FOUND";
      if (diag.playerResolutionMethod === "none") {
        diag.playerResolutionMethod = "sofascore-search";
      }
      diag.sources.push(sfDiag);

      // Non-blocking DB cache write — next request for same player hits Layer 1
      saveMatchesToDb(
        sfResult.records,
        sfResult.player.id,
        sfResult.player.name,
        sfResult.player.tour ?? null,
        "builder-live-fetch:sofascore",
      ).catch(() => {});

      return {
        records: sfResult.records,
        resolvedPlayerId: sfResult.player.id,
        resolvedPlayerName: sfResult.player.name,
        tour: sfResult.player.tour ?? null,
        diagnostics: diag,
      };
    }

    if (sfResult.player) {
      // Player found but no completed match records on Sofascore either
      sfDiag.playerFound = true;
      sfDiag.providerPlayerId = sfResult.player.id;
      sfDiag.succeeded = true;
      sfDiag.recordsReturned = 0;
      diag.sourcesSuccessful.push("sofascore");
      diag.providerIdsFound["sofascore"] = sfResult.player.id;
      diag.outcome = "NO_MATCH_HISTORY";
    } else {
      sfDiag.failureReason = sfResult.error ?? "Player not found in Sofascore";
      diag.sourcesFailed.push("sofascore");
      // PLAYER_NOT_FOUND outcome stays as-is when all providers say not found
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    sfDiag.failureReason = reason;
    diag.sourcesFailed.push("sofascore");
    diag.failureReasons.push(`sofascore: ${reason}`);
  }

  diag.sources.push(sfDiag);
  return null;
}

// ─── Odds API (market consensus) ─────────────────────────────────────────────

/**
 * Attempt to fetch real pre-match head-to-head decimal odds for this matchup from the
 * configured odds providers (The Odds API primary → Odds-API.io fallback).
 *
 * Returns the decimal odds for the SELECTED player (the one passed as `selectedPlayerName`),
 * or null when:
 *   - neither odds key is configured
 *   - neither provider currently lists odds for this matchup
 *   - any transient provider error occurs (non-fatal: caller falls back to 50)
 *
 * `selectedPlayerName` is passed as "player1" to `fetchMarketOdds` so the caller can
 * use `quote.player1DecimalOdds` directly without additional name-mapping.
 *
 * Always skipped in backfill mode (asOfDate != null) — real-time API calls must never
 * fire when replaying historical matchups.
 */
export async function attemptOddsApi(
  selectedPlayerName: string,
  opponentName: string,
  scheduledStart: Date | null,
  asOfDate?: Date,
  /**
   * Optional fetch function override for unit tests. Production code always uses the real
   * `fetchMarketOdds` from the oddsData module; tests inject a stub to avoid network calls.
   */
  _fetchFn: typeof fetchMarketOdds = fetchMarketOdds,
): Promise<number | null> {
  if (asOfDate != null) return null; // never call live APIs in backfill mode
  try {
    const quote = await _fetchFn(selectedPlayerName, opponentName, scheduledStart);
    if (quote == null) return null;
    // selectedPlayerName was passed as "player1" → player1DecimalOdds is theirs
    const odds = quote.player1DecimalOdds;
    return odds > 1 ? odds : null;
  } catch {
    return null; // non-fatal — market odds are supplemental
  }
}

// ─── Exported helpers (for unit tests) ────────────────────────────────────────

export { normaliseName, normaliseCandidateName, isConfidentSearchMatch, buildSearchQueries };

// ─── Provider injection interface (tests override; production uses env-key singletons) ──

export interface BuilderProviders {
  rapidApi: InstanceType<typeof import("../tennisData/matchStatProvider.js").MatchStatProvider> | null;
  apiTennis: InstanceType<typeof import("../tennisData/apiTennisProvider.js").ApiTennisProvider> | null;
  sofascore: typeof fetchFromSofascore;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch match records for a player from all configured external providers.
 *
 * Provider chain:
 *   1. RapidAPI/MatchStat — player identity resolution via current rankings search
 *   2. API-Tennis         — player search + full match history
 *   3. Sofascore          — supplemental history for sparse/lower-tier players
 *
 * Each provider is attempted independently with its own error handling.  A
 * failure at any tier is recorded in diagnostics and the chain continues to the
 * next tier rather than surfacing a hard error to the caller.
 *
 * `_providers` is an optional injection point used exclusively by unit tests to
 * supply mock provider instances without needing module mocking.  Production
 * callers must never pass it.
 */
export async function fetchPlayerMatchesFromProviders(
  playerName: string,
  _context?: { opponentName?: string; tournamentName?: string },
  _providers?: Partial<BuilderProviders>,
): Promise<LiveFetchResult> {
  // Resolve providers: injected overrides take precedence (tests use this);
  // production falls back to env-key singletons.
  // `undefined` in the injected map means "use env key"; `null` means "disabled".
  const injectedRapidApi = _providers && "rapidApi" in _providers ? _providers.rapidApi : undefined;
  const injectedApiTennis = _providers && "apiTennis" in _providers ? _providers.apiTennis : undefined;
  const injectedSofascore = _providers?.sofascore;

  const effectiveRapidApi = injectedRapidApi !== undefined ? injectedRapidApi : getBuilderRapidApiProvider();
  const effectiveApiTennis = injectedApiTennis !== undefined ? injectedApiTennis : getBuilderApiTennisProvider();

  const sourcesConfigured: string[] = [];
  if (effectiveRapidApi) sourcesConfigured.push("rapidapi");
  if (effectiveApiTennis) sourcesConfigured.push("api-tennis");
  sourcesConfigured.push("sofascore");

  const diag: LiveFetchDiagnostics = {
    outcome: "CACHE_MISS",
    sourcesConfigured,
    sourcesAttempted: [],
    sourcesSuccessful: [],
    sourcesFailed: [],
    playerResolutionMethod: "none",
    providerIdsFound: {},
    recordsPerSource: {},
    failureReasons: [],
    sources: [],
  };

  // ── Tier 1: RapidAPI / MatchStat — player identity resolution ────────────
  // MatchStat can confirm a player exists in current standings (useful for
  // identity resolution diagnostics) but has no match-history endpoint.
  // Run it first so any identity signal is captured before Tier 2 searches.
  if (effectiveRapidApi) {
    await attemptRapidApi(playerName, diag, effectiveRapidApi);
    // Result (PlayerSummary | null) is intentionally discarded here — MatchStat
    // IDs are incompatible with API-Tennis IDs, so the Tier-2 search is always
    // run independently. The value of Tier 1 is diagnostic coverage, not data.
  }

  // ── Tier 2: API-Tennis — full search + match history ─────────────────────
  if (effectiveApiTennis) {
    const apiTennisResult = await attemptMatchstat(playerName, diag, effectiveApiTennis);
    if (apiTennisResult) return apiTennisResult;
  }

  // ── Tier 3: Sofascore — supplemental / fallback ───────────────────────────
  const sfResult = await attemptSofascore(playerName, diag, injectedSofascore);
  if (sfResult) return sfResult;

  // ── All providers exhausted ───────────────────────────────────────────────
  if (diag.outcome === "CACHE_MISS") {
    // No provider was attempted at all (no keys configured) or all returned
    // PLAYER_NOT_FOUND — pick the most accurate terminal outcome.
    const anyAttempted = diag.sourcesAttempted.length > 0;
    diag.outcome = anyAttempted ? "PLAYER_NOT_FOUND" : "DATA_UNAVAILABLE";
  }

  return {
    records: [],
    resolvedPlayerId: null,
    resolvedPlayerName: null,
    tour: null,
    diagnostics: diag,
  };
}
