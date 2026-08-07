/**
 * Independent Parlay Builder — Validation Scoring Engine
 *
 * Core architectural principle: this service NEVER reads from the predictions table,
 * NEVER uses calibratedProbability, safetyScore, or any Prediction Engine output.
 * It validates the Prediction Engine's selected winner using only independent evidence:
 * raw historical match data, rankings, and market consensus.
 *
 * Input:  BuilderSnapshot (who was selected, raw match context)
 * Output: BuilderResult (ValidationScore, RiskScore, Grade, Decision, Reasons)
 */

import { pool } from "@workspace/db";
import {
  getCachedPlayerIdentityIndex,
  canonicalizePlayerId,
  getAliasIds,
  resolvePlayerNameWithAmbiguity,
  type PlayerIdentityIndex,
} from "../tennisData/playerIdentity.js";
import {
  fetchPlayerMatchesFromProviders,
  attemptOddsApi,
  type LiveFetchDiagnostics,
  type ResolutionOutcome,
} from "./builderProviderFetch.js";
import { researchPlayerMatchup } from "./webResearchService.js";
import { scrapeMatchstatPlayer, type MatchstatPlayerData } from "./matchstatScraper.js";

export const BUILDER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Read-only snapshot from the Prediction Engine — contains ONLY who was selected and raw context. */
export interface BuilderSnapshot {
  selectedPlayerId: string;
  selectedPlayerName: string;
  opponentId: string;
  opponentName: string;
  surface: string | null;
  tournamentName: string | null;
  marketOdds?: number | null; // decimal odds for the selected player (user-supplied, not engine output)
  /**
   * When the match is scheduled to start (UTC). Used to detect live/in-play state:
   * if `scheduledStart` is in the past, the match has already started and live odds
   * from the market reflect the current score, not a pre-match handicap assessment.
   * Omitting or null is treated as "commence time unknown — assume pre-match".
   */
  scheduledStart?: Date | null;
  /**
   * Backfill mode: when set, all historical_matches queries are gated to rows
   * with scheduled_start_at < asOfDate so no future data leaks into the score.
   * Layer 5 (live provider fetch) is skipped automatically — we never want API
   * calls or quota consumption during a historical backfill.
   * Live /validate calls never set this field.
   */
  asOfDate?: Date;
}

export interface FactorScore {
  key: string;
  label: string;
  score: number;             // 0–100; 50 = neutral; >50 favors selected player
  weight: number;            // spec-defined weight (0–1)
  status: "available" | "unavailable" | "limited";
  supportsSelected: boolean | null; // null when unavailable
  detail: string;
}

/**
 * Three distinct data states, each requiring different treatment:
 *   data_available    — ≥5 matches found (DB or live provider), real factor scores computable
 *   insufficient_data — 1–4 matches found, limited signal
 *   player_not_found  — 0 matches after all DB layers AND live provider search
 */
export type PlayerDataStatus = "data_available" | "insufficient_data" | "player_not_found";

export interface DataSourceDiagnostics {
  selectedPlayerStatus: PlayerDataStatus;
  opponentStatus: PlayerDataStatus;
  selectedPlayerMatchCount: number;
  opponentMatchCount: number;
  h2hMatchCount: number;
  /** How the selected player's ID/data was resolved. */
  selectedPlayerResolvedVia?: string;
  /** How the opponent's ID/data was resolved. */
  opponentResolvedVia?: string;
  /**
   * Provider-level diagnostics for the selected player's live fetch.
   * Populated in two cases:
   *   - The local DB had no data (all DB layers returned empty) and Layer 5 was attempted.
   *   - A DB cache hit was stale (< STALE_MIN_MATCH_COUNT rows OR most-recent match older
   *     than STALE_MAX_MATCH_AGE_DAYS days) and Layer 4b supplement was attempted.
   * When outcome is CACHE_HIT_SUPPLEMENTED, the provider returned fresh records that
   * replaced the stale DB rows for this request.
   */
  selectedPlayerProviderDiag?: LiveFetchDiagnostics;
  /**
   * Provider-level diagnostics for the opponent's live fetch.
   * Populated in the same two cases as selectedPlayerProviderDiag above.
   */
  opponentProviderDiag?: LiveFetchDiagnostics;
  /**
   * True when at least one player had 0 local rows AND the live-fetch returned
   * a no-data outcome (SOURCE_UNAVAILABLE, DATA_UNAVAILABLE, PLAYER_NOT_FOUND,
   * or NO_MATCH_HISTORY). A graded score from zero evidence is actively
   * misleading — the frontend must show DATA_UNAVAILABLE instead of a grade.
   */
  isProviderOutage?: boolean;
  /**
   * Machine-readable cause of the no-data condition. Allows the frontend to
   * show a cause-specific message rather than a generic "provider error".
   *
   *   provider-unreachable — SOURCE_UNAVAILABLE: providers timed out / errored
   *   not-configured       — DATA_UNAVAILABLE: no provider keys are set
   *   player-not-found     — PLAYER_NOT_FOUND: providers responded but don't know this player
   *   no-history           — NO_MATCH_HISTORY: player was identified but has 0 pro match records
   */
  noDataReason?: "provider-unreachable" | "not-configured" | "player-not-found" | "no-history";
  /** Set when data is available but limited; explains why scores may be low-confidence. */
  dataConfidenceNote?: string;
}

export interface BuilderResult {
  validationScore: number;   // 0–100
  riskScore: number;         // 0–100, higher = more risk
  matchupCloseness: number;  // 0–100, higher = more evenly matched; used as a risk floor
  reliabilityGrade: "A" | "B" | "C" | "D" | "F";
  parlayGrade: "Elite" | "Strong" | "Moderate" | "Weak" | "Reject";
  removalProbability: number; // 0–100%
  /**
   * KEEP / BORDERLINE / REMOVE — standard outcomes.
   * DATA_UNAVAILABLE — all providers unreachable; no grade should be displayed.
   */
  decision: "KEEP" | "BORDERLINE" | "REMOVE" | "DATA_UNAVAILABLE";
  reasons: string[];         // 3–6 evidence-based reasons
  criticalFlags: string[];
  dataCoverage: number;      // 0–100%, proportion of spec factor-weights that have real data
  sourceAgreement: number;   // 0–100%, proportion of OPINIONATED sources supporting selected
  sourcesAgreeing: number;   // count of factors that actively support the selection
  sourcesTotal: number;      // count of factors that took a side (supportsSelected !== null)
  factorScores: FactorScore[];
  dataSourceDiagnostics: DataSourceDiagnostics;
  builderVersion: string;
  /**
   * "pre-match" — match has not yet started; market odds reflect handicapping evidence.
   * "live"      — match is in progress (scheduledStart is in the past); market odds were
   *               frozen at the last known pre-match value or treated as absent (score 50)
   *               when no pre-match odds were ever captured.
   */
  matchStatus: "pre-match" | "live";
}

// ---------------------------------------------------------------------------
// Default weights (total = 1.00, per spec)
// ---------------------------------------------------------------------------

// Default weights (total = 1.00, per spec).
// ---------------------------------------------------------------------------
// Empirically derived via leave-one-out ablation on 3,031 resolved backfill legs
// (auditParlayFactorWeights.ts, 2026-08-01). Prior weights were hand-set.
//
// Key findings vs prior hand-set values:
//   - historicalVolatility had −4.1pp directional edge → reduced to near-zero (0.003)
//   - recentForm, surfaceRecord, Hard Court Advantage all show strong POSITIVE edge
//     (+5.8pp, +13.0pp, +13.2pp) — the prior "negative edge" finding was small-sample noise
//   - Normalization redistributes weight from low-coverage factors (marketConsensus,
//     travelFatigue, injuryRisk — all 0 live rows in backfill) to factors with real data
//   - Overall win rate improved from 53.3% baseline → 58.6% with new backfill data
//   - Held-out KEEP tier accuracy: 71.0%  (n=372 held-out legs)
// ---------------------------------------------------------------------------
const DEFAULT_WEIGHTS: Record<string, number> = {
  overallAdvantage:      0.182,  // +17.7pp edge (n=784) — strongest signal
  surfaceAdvantage:      0.101,  // +13.2pp edge (n=946)
  utr:                   0.100,  // no public API — unavailable (spec weight kept)
  surfaceRecord:         0.081,  // +13.0pp edge (n=990)
  recentForm:            0.068,  // +5.8pp edge (n=1154) — reduced from 0.10 by normalization
  serveAdvantage:        0.060,  // not in historical_matches — unavailable (spec weight kept)
  returnAdvantage:       0.060,  // not in historical_matches — unavailable (spec weight kept)
  sourceAgreement:       0.061,  // +10.0pp edge (n=2130) — meta-factor, consensus signal
  holdBreak:             0.050,  // not in historical_matches — unavailable (spec weight kept)
  strengthOfSchedule:    0.051,  // +9.3pp edge (n=707)
  rankingTrend:          0.041,  // +10.5pp edge (n=841)
  marketConsensus:       0.034,  // 0 live rows in backfill (temporal isolation); kept near prior
  headToHead:            0.020,  // +7.5pp edge (n=419) — high signal per row, low coverage
  travelFatigue:         0.020,  // 0 live rows in backfill; prior weight normalized down
  injuryRisk:            0.020,  // 0 live rows in backfill; prior weight normalized down
  historicalConsistency: 0.020,  // +8.0pp edge (n=632)
  tournamentExperience:  0.014,  // +6.9pp edge (n=490) — normalized down
  dataQuality:           0.014,  // non-directional by design — normalized down
  historicalVolatility:  0.003,  // −4.1pp edge (n=492) → near-zero; only confirmed negative factor
};

const STRUCTURALLY_UNAVAILABLE = new Set([
  "utr", "serveAdvantage", "returnAdvantage", "holdBreak",
  // injuryRisk removed: now computed via Gemini web research (Tier 5)
]);

// Sum of weights for factors that are permanently unavailable for ALL matches (no API or
// data source exists that could ever populate them). Used to normalise dataCoverage so the
// permanently-absent 27% doesn't cap every match at 73% and prevent Grade A.
// utr(0.10) + serveAdvantage(0.06) + returnAdvantage(0.06) + holdBreak(0.05) = 0.27
const STRUCTURAL_MAX_UNAVAIL_WEIGHT = Array.from(STRUCTURALLY_UNAVAILABLE).reduce(
  (sum, key) => sum + (DEFAULT_WEIGHTS[key] ?? 0),
  0,
);

// ---------------------------------------------------------------------------
// Per-factor validated predictive edge (pp) used for edge-weighted Agreement.
// Source: leave-one-out ablation from auditParlayFactorWeights.ts (n=9,366).
//
// Each opinionated factor's vote counts in proportion to its real predictive
// edge rather than as a flat +1. This stops weak or negative-edge factors from
// outvoting high-signal ones in the Agreement count.
//
// - historicalVolatility: 0.0  — confirmed near-zero / negative edge; excluded
// - live-only factors (never seen in backfill): conservative 5.0pp default
// - dataQuality, sourceAgreement: omitted — supportsSelected always null or
//   excluded from decisiveFacters, so they can never appear in opinionated set
// ---------------------------------------------------------------------------
const AGREEMENT_EDGE_WEIGHTS: Record<string, number> = {
  overallAdvantage:      17.7,
  surfaceAdvantage:      13.2,
  surfaceRecord:         13.0,
  rankingTrend:          10.5,
  strengthOfSchedule:     9.3,
  historicalConsistency:  8.0,
  headToHead:             7.5,
  tournamentExperience:   6.9,
  recentForm:             5.8,
  marketConsensus:        5.0,  // live-only in backfill — conservative default
  travelFatigue:          5.0,  // live-only in backfill — conservative default
  injuryRisk:             5.0,  // live-only in backfill — conservative default
  historicalVolatility:   0.0,  // −4.1pp at n=3,031 → −0.7pp at n=9,366 → excluded
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Convert a selected–opponent difference into a 0–100 factor score (50 = neutral). */
function diffScore(selVal: number, oppVal: number, scale: number): number {
  return Math.round(50 + clamp((selVal - oppVal) * scale, -50, 50));
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Agreement rate weighted by validated per-factor predictive edge.
 * Each factor's vote contributes its AGREEMENT_EDGE_WEIGHTS[key] rather than a flat 1.
 * Factors absent from the map get a conservative 5.0pp fallback (positive but low weight).
 * Returns 0.5 (neutral) when no opinionated factors are present.
 */
function edgeWeightedAgreementRate(opinionatedFactors: FactorScore[]): number {
  if (opinionatedFactors.length === 0) return 0.5;
  const FALLBACK_EDGE = 5.0;
  let agreeWeight = 0;
  let totalWeight = 0;
  for (const f of opinionatedFactors) {
    const w = Math.max(0, AGREEMENT_EDGE_WEIGHTS[f.key] ?? FALLBACK_EDGE);
    totalWeight += w;
    if (f.supportsSelected === true) agreeWeight += w;
  }
  return totalWeight > 0 ? agreeWeight / totalWeight : 0.5;
}

// ---------------------------------------------------------------------------
// Thin-data risk floor — smooth ramp replacing the previous hard cut at < 5.
//
// Walk-forward analysis (n=11,499 graded legs, see analyzeClosenessFloors.ts):
//
//   min matches across both players │   n   │  acc%  │ interpretation
//   ─────────────────────────────────┼───────┼────────┼────────────────────────────
//   0         (player not found)     │    67 │  65.7% │ small-sample artefact; floor=45
//   1–2       (very thin)            │  3024 │  54.7% │ near coin-flip — full floor=45
//   3         (thin, boundary)       │   891 │  58.2% │ some signal — partial floor=30
//   4         (thin, boundary)       │   650 │  61.5% │ ≈ 5–9 accuracy — light floor=15
//   5–9       (low)                  │  1592 │  59.9% │ no floor (reference band)
//   10–19     (moderate)             │   815 │  61.8% │ no floor
//   20+       (good)                 │  4460 │  62.9% │ no floor
//
// Finding: 4-match players (61.5%) perform nearly identically to 5-9-match
// players (59.9%).  The old hard threshold treated them identically to 0-match
// players, which was too aggressive.  The ramp reflects the real signal gradient.
// ---------------------------------------------------------------------------
export const THIN_DATA_RISK_FLOOR = 45;

// ---------------------------------------------------------------------------
// Closeness risk floor — smooth ramp replacing the old two-step cliff.
// At cs ≤ 50 the floor is 0.  Between 50 and 80 it ramps linearly from 0→40.
// Between 80 and 100 it continues at a shallower slope to a ceiling of 55.
// This eliminates the 40-point jump that appeared the moment cs crossed 65.
// ---------------------------------------------------------------------------
function closenessRiskFloor(cs: number): number {
  if (cs <= 50) return 0;
  if (cs <= 80) return Math.round(((cs - 50) / 30) * 40);   // 50→0 … 80→40
  return Math.round(40 + ((cs - 80) / 20) * 15);             // 80→40 … 100→55
}

// ---------------------------------------------------------------------------
// Thin-data risk floor — smooth ramp from minMatches=0 (full floor) to 5 (no floor).
//
// When data is sparse the true risk is unknown, not low.  Two players with
// 1 match each sharing equal win rates gives a closeness score of ~0 gap —
// that is absence-of-signal, not evidence of a safe pick.
//
// The ramp is keyed on the MINIMUM match count across both players:
//   n ≤ 2  →  45  (near coin-flip accuracy in walk-forward data; full floor)
//   n = 3  →  30  (partial floor; 58.2% acc vs 54.7% at n=1-2)
//   n = 4  →  15  (light floor;  61.5% acc ≈ 5-9 band at 59.9%)
//   n ≥ 5  →   0  (no floor)
//
// Linear formula for n ∈ [3,4]: floor = 45 × (5 − n) / 3
// ---------------------------------------------------------------------------
export function thinDataRiskFloor(minMatches: number): number {
  if (minMatches >= 5) return 0;
  if (minMatches <= 2) return THIN_DATA_RISK_FLOOR;          // 45 — near coin-flip zone
  // Linear ramp: (2 → 45) … (5 → 0)
  return Math.round(THIN_DATA_RISK_FLOOR * (5 - minMatches) / 3);
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface MatchRow {
  player1_id: string;
  player2_id: string;
  winner_id: string | null;
  player1_rank: number | null;
  player2_rank: number | null;
  surface: string | null;
  tournament_name: string | null;
  scheduled_start_at: Date | null;
  retired: boolean | null;
  walkover: boolean | null;
}

// ---------------------------------------------------------------------------
// Multi-source player ID resolution
// ---------------------------------------------------------------------------
//
// The builder previously queried historical_matches only by the raw player_key
// supplied by the fixture. If that key differed from what's stored (different
// provider namespace, fragmented alias, abbreviated name), it returned 0 rows
// and immediately flagged the player as "not found" — even when 50+ matches
// existed under a different key or name.
//
// This helper tries four progressively-broader layers before giving up:
//   1. Direct ID lookup   — fastest path, works when IDs match exactly
//   2. Identity index     — canonicalizes the ID and fetches all alias IDs,
//                           handles provider-fragmented IDs (e.g. API-Tennis
//                           vs MatchStat IDs for the same player)
//   3. Name via index     — resolves the supplied player name against the
//                           identity index; catches mismatched IDs where the
//                           name resolves cleanly
//   4. DB name search     — direct ILIKE on player1_name/player2_name with
//                           surname + initial filter; catches players absent
//                           from the index (single-appearance players)
//
// Rows are normalised so player1_id / player2_id / winner_id all use the
// resolved canonical ID, making computePlayerStats work correctly regardless
// of which layer found the data.

/** Normalise all alias IDs in a set of match rows to a single canonical value. */
function normalizeMatchRowIds(rows: MatchRow[], aliasSet: Set<string>, canonicalId: string): MatchRow[] {
  return rows.map(r => ({
    ...r,
    player1_id: aliasSet.has(r.player1_id) ? canonicalId : r.player1_id,
    player2_id: aliasSet.has(r.player2_id) ? canonicalId : r.player2_id,
    winner_id: r.winner_id != null && aliasSet.has(r.winner_id) ? canonicalId : r.winner_id,
  }));
}

/**
 * Build the 2-year history SELECT with a parameterised IN clause.
 *
 * When asOfDateParamIdx is provided the query is gated to:
 *   scheduled_start_at < $N          (exclude the target match and any after it)
 *   scheduled_start_at > $N - 2yr   (rolling 2-year window relative to asOfDate)
 * When omitted the window is relative to NOW() — live behaviour unchanged.
 */
function buildHistorySQL(idCount: number, startParam = 1, asOfDateParamIdx?: number): string {
  const ids = Array.from({ length: idCount }, (_, i) => `$${startParam + i}`).join(", ");
  const dateCond = asOfDateParamIdx != null
    ? `AND scheduled_start_at < $${asOfDateParamIdx}
       AND scheduled_start_at > $${asOfDateParamIdx} - INTERVAL '2 years'`
    : `AND scheduled_start_at > NOW() - INTERVAL '2 years'`;
  return `
    SELECT player1_id, player2_id, winner_id, player1_rank, player2_rank,
           surface, tournament_name, scheduled_start_at, retired, walkover
    FROM historical_matches
    WHERE (player1_id IN (${ids}) OR player2_id IN (${ids}))
      AND (cancelled IS NULL OR cancelled = false)
      AND (walkover IS NULL OR walkover = false)
      ${dateCond}
    ORDER BY scheduled_start_at DESC
    LIMIT 60
  `;
}

interface PlayerResolution {
  rows: MatchRow[];
  resolvedId: string;          // canonical ID to use for win/loss computation
  resolvedVia: "direct" | "identity-index" | "name-index" | "db-name-search" | "provider-fetch" | "cache-hit-supplemented" | "none";
  aliasIds: string[];          // all IDs that belong to this player in our DB
  liveFetchDiagnostics?: LiveFetchDiagnostics; // populated when Layer 5 or stale-supplement was attempted
}

// Exported for unit-test construction — never import in production code.
export type { MatchRow as __TEST_MatchRow, PlayerResolution as __TEST_PlayerResolution };

// ---------------------------------------------------------------------------
// Staleness detection — controls when a DB cache hit triggers a live supplement
// ---------------------------------------------------------------------------
//
// A player record in the DB is considered stale when either:
//   (a) fewer than STALE_MIN_MATCH_COUNT rows are present (thin data — the DB
//       may only have old ITF matches for a player now competing at WTA/ATP level),
//   (b) the most-recent match is older than STALE_MAX_MATCH_AGE_DAYS (inactive
//       period — the DB hasn't seen a recent match and providers likely have more).
//
// Staleness is only checked in live mode (asOfDate == null). Backfill scoring
// intentionally uses the DB snapshot at the time of the match.
//
export const STALE_MIN_MATCH_COUNT = 5;
export const STALE_MAX_MATCH_AGE_DAYS = 90;

function isStaleResult(rows: MatchRow[]): boolean {
  if (rows.length < STALE_MIN_MATCH_COUNT) return true;
  // rows are ORDER BY scheduled_start_at DESC — first row is most recent
  const mostRecent = rows[0]?.scheduled_start_at;
  if (!mostRecent) return true;
  const daysSince = (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > STALE_MAX_MATCH_AGE_DAYS;
}

/** Convert provider MatchRecord[] (player-perspective) into MatchRow[] for scoring. */
function matchRecordsToRows(records: import("../tennisData/types.js").MatchRecord[], playerId: string): MatchRow[] {
  return records.map(rec => ({
    player1_id: playerId,
    player2_id: rec.opponentId,
    winner_id: rec.result === "W" ? playerId : rec.opponentId,
    player1_rank: null,          // MatchRecord is player-perspective; own rank not returned
    player2_rank: rec.opponentRank,
    surface: rec.surface,
    tournament_name: rec.tournamentName,
    scheduled_start_at: rec.date ? new Date(rec.date) : null,
    retired: rec.retired,
    walkover: rec.walkover,
  }));
}

// ---------------------------------------------------------------------------
// Layer 4b: Staleness supplement (extracted for unit-test injection)
// ---------------------------------------------------------------------------
//
// Given a DB cache hit (`dbResult`), decides whether to invoke the live
// provider chain to refresh stale records, and returns the updated resolution.
//
// Rules:
//  - Skipped in backfill mode (asOfDate != null) — historical scoring uses
//    the DB snapshot at the time of the match; no live API calls allowed.
//  - Skipped when the DB result is fresh (isStaleResult returns false).
//  - When stale: calls fetchFn (defaults to fetchPlayerMatchesFromProviders).
//    On provider success: returns a new PlayerResolution with provider rows,
//    resolvedVia="cache-hit-supplemented", and outcome=CACHE_HIT_SUPPLEMENTED
//    in liveFetchDiagnostics.
//  - When provider returns empty: returns the original stale dbResult unchanged
//    (caller's thin-data floor handles the score impact).
//
// `fetchFn` is injectable for unit tests; production always uses the default.
//
async function applyStalenessSupplementIfNeeded(
  dbResult: PlayerResolution,
  playerName: string,
  asOfDate: Date | undefined,
  fetchFn: typeof fetchPlayerMatchesFromProviders = fetchPlayerMatchesFromProviders,
): Promise<PlayerResolution> {
  // Backfill mode: never call live providers.
  if (asOfDate != null) return dbResult;
  // Fresh DB data: no supplement needed.
  if (!isStaleResult(dbResult.rows)) return dbResult;

  const fetchResult = await fetchFn(playerName);
  if (fetchResult.records.length > 0 && fetchResult.resolvedPlayerId) {
    const freshRows = matchRecordsToRows(fetchResult.records, fetchResult.resolvedPlayerId);
    const supplementedDiag: LiveFetchDiagnostics = {
      ...fetchResult.diagnostics,
      outcome: "CACHE_HIT_SUPPLEMENTED",
    };
    return {
      rows: freshRows,
      resolvedId: fetchResult.resolvedPlayerId,
      // resolvedVia="cache-hit-supplemented" signals the supplement fired;
      // aliasIds merges DB and provider IDs so H2H queries cover both namespaces.
      resolvedVia: "cache-hit-supplemented",
      aliasIds: [...new Set([...dbResult.aliasIds, fetchResult.resolvedPlayerId])],
      liveFetchDiagnostics: supplementedDiag,
    };
  }

  // Provider returned nothing useful — return the stale DB rows unchanged.
  // The scoring engine will apply the thin-data risk floor as appropriate.
  return dbResult;
}

async function resolvePlayerMatchRows(
  rawId: string,
  playerName: string,
  index: PlayerIdentityIndex,
  asOfDate?: Date,
): Promise<PlayerResolution> {
  // ── Layers 1–4: DB-only resolution ───────────────────────────────────────
  //
  // We try four progressively broader DB layers and capture the FIRST successful
  // result in `dbResult` rather than returning immediately. This lets us run the
  // staleness supplement check (Layer 4b) as a single post-step after whichever
  // layer produced rows, without duplicating the supplement logic four times.

  let dbResult: PlayerResolution | null = null;

  // ── Layer 1: direct ID ────────────────────────────────────────────────────
  const asOfIdx1 = asOfDate != null ? 2 : undefined;
  const direct = await pool.query<MatchRow>(
    buildHistorySQL(1, 1, asOfIdx1),
    asOfDate != null ? [rawId, asOfDate] : [rawId],
  );
  if (direct.rows.length > 0) {
    dbResult = { rows: direct.rows, resolvedId: rawId, resolvedVia: "direct", aliasIds: [rawId] };
  }

  // ── Layer 2: identity index — canonical ID + all provider aliases ─────────
  if (!dbResult) {
    const canonical2 = canonicalizePlayerId(index, rawId, playerName);
    const aliases2 = getAliasIds(index, canonical2);
    const allIds2 = [...new Set([rawId, canonical2, ...aliases2])];
    // Only bother querying if we actually found aliases beyond the raw ID
    if (allIds2.length > 1) {
      const asOfIdx2 = asOfDate != null ? allIds2.length + 1 : undefined;
      const res2 = await pool.query<MatchRow>(
        buildHistorySQL(allIds2.length, 1, asOfIdx2),
        asOfDate != null ? [...allIds2, asOfDate] : allIds2,
      );
      if (res2.rows.length > 0) {
        const aliasSet2 = new Set(allIds2);
        dbResult = {
          rows: normalizeMatchRowIds(res2.rows, aliasSet2, canonical2),
          resolvedId: canonical2,
          resolvedVia: "identity-index",
          aliasIds: allIds2,
        };
      }
    }
  }

  // ── Layer 3: name resolution via identity index ───────────────────────────
  if (!dbResult) {
    const nameHit = resolvePlayerNameWithAmbiguity(index, playerName);
    if (nameHit && !nameHit.ambiguous) {
      const canonical3 = nameHit.id;
      const aliases3 = getAliasIds(index, canonical3);
      const allIds3 = [...new Set([canonical3, ...aliases3])];
      const asOfIdx3 = asOfDate != null ? allIds3.length + 1 : undefined;
      const res3 = await pool.query<MatchRow>(
        buildHistorySQL(allIds3.length, 1, asOfIdx3),
        asOfDate != null ? [...allIds3, asOfDate] : allIds3,
      );
      if (res3.rows.length > 0) {
        const aliasSet3 = new Set(allIds3);
        dbResult = {
          rows: normalizeMatchRowIds(res3.rows, aliasSet3, canonical3),
          resolvedId: canonical3,
          resolvedVia: "name-index",
          aliasIds: allIds3,
        };
      }
    }
  }

  // ── Layer 4: direct DB name search (surname + initial filter) ────────────
  // Handles players present in historical_matches but absent from the index
  // (e.g. players who appear only once — not enough sightings to be indexed).
  if (!dbResult) {
    const nameParts = playerName.trim().split(/\s+/);
    const surname = nameParts[nameParts.length - 1] ?? "";
    // Derive the first initial: handle "D. Singh" → "D" and "Devvrat Singh" → "D"
    const firstToken = nameParts[0] ?? "";
    const firstInitial = firstToken.replace(".", "").charAt(0).toUpperCase();

    if (surname.length >= 3) {
      interface NameRow { pid: string; pname: string; cnt: string }
      // In backfill mode gate the name search to the same temporal window.
      const nameSearchDateCond = asOfDate != null
        ? `AND scheduled_start_at < $2 AND scheduled_start_at > $2 - INTERVAL '2 years'`
        : `AND scheduled_start_at > NOW() - INTERVAL '2 years'`;
      const nameSearchParams: unknown[] = asOfDate != null ? [`%${surname}%`, asOfDate] : [`%${surname}%`];
      const nameRes = await pool.query<NameRow>(`
        SELECT pid, pname, COUNT(*) AS cnt FROM (
          SELECT player1_id AS pid, player1_name AS pname
          FROM historical_matches
          WHERE player1_name ILIKE $1
            ${nameSearchDateCond}
          UNION ALL
          SELECT player2_id AS pid, player2_name AS pname
          FROM historical_matches
          WHERE player2_name ILIKE $1
            ${nameSearchDateCond}
        ) t
        GROUP BY pid, pname
        ORDER BY cnt DESC
        LIMIT 10
      `, nameSearchParams);

      // Filter by initial match to avoid collisions (e.g. "Singh" returns both
      // "A. Singh" and "D. Singh" — only keep those whose first char matches)
      const filtered = nameRes.rows.filter(r => {
        const storedFirst = (r.pname ?? "").trim().charAt(0).toUpperCase();
        return storedFirst === firstInitial;
      });

      // Only proceed if exactly one canonical player is found (unambiguous)
      const filteredCanonicals = [...new Set(
        filtered.map(r => canonicalizePlayerId(index, r.pid, r.pname))
      )];

      if (filteredCanonicals.length === 1) {
        const canonical4 = filteredCanonicals[0];
        const aliases4 = getAliasIds(index, canonical4);
        const allIds4 = [...new Set([canonical4, ...aliases4])];
        const asOfIdx4 = asOfDate != null ? allIds4.length + 1 : undefined;
        const res4 = await pool.query<MatchRow>(
          buildHistorySQL(allIds4.length, 1, asOfIdx4),
          asOfDate != null ? [...allIds4, asOfDate] : allIds4,
        );
        if (res4.rows.length > 0) {
          const aliasSet4 = new Set(allIds4);
          dbResult = {
            rows: normalizeMatchRowIds(res4.rows, aliasSet4, canonical4),
            resolvedId: canonical4,
            resolvedVia: "db-name-search",
            aliasIds: allIds4,
          };
        }
      }
    }
  }

  // ── Layer 4b: staleness supplement ───────────────────────────────────────
  if (dbResult) {
    dbResult = await applyStalenessSupplementIfNeeded(dbResult, playerName, asOfDate);
    return dbResult;
  }

  // ── Layer 5: live provider fetch ─────────────────────────────────────────
  //
  // Skipped in backfill mode (asOfDate is set) — we never want API calls or
  // quota consumption when scoring historical matches.  A missing player just
  // returns 0 rows, which the scoring engine treats as "player_not_found".
  if (asOfDate != null) {
    return { rows: [], resolvedId: rawId, resolvedVia: "none", aliasIds: [rawId] };
  }

  // All four DB layers returned empty. The player is either absent from the
  // local cache or stored under an ID/name the index cannot cross-reference.
  // Query external providers directly using the submitted player name.
  //
  // On success the provider records are written to historical_matches
  // (non-blocking) so the NEXT request for the same player hits Layer 1.
  const fetchResult = await fetchPlayerMatchesFromProviders(playerName);
  if (fetchResult.records.length > 0 && fetchResult.resolvedPlayerId) {
    const rows = matchRecordsToRows(fetchResult.records, fetchResult.resolvedPlayerId);
    return {
      rows,
      resolvedId: fetchResult.resolvedPlayerId,
      resolvedVia: "provider-fetch",
      aliasIds: [fetchResult.resolvedPlayerId],
      liveFetchDiagnostics: fetchResult.diagnostics,
    };
  }

  // ── No data found after all 5 layers ─────────────────────────────────────
  return {
    rows: [],
    resolvedId: rawId,
    resolvedVia: "none",
    aliasIds: [rawId],
    liveFetchDiagnostics: fetchResult.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Player statistics (computed directly from historical_matches rows)
// ---------------------------------------------------------------------------

export interface PlayerStats {
  total: number;
  winRate: number;
  /** 0 at n=0, 1 at n≥10 — how much to trust winRate vs. the 0.5 prior */
  winRateConfidence: number;
  surfaceTotal: number;
  surfaceWinRate: number;
  /** 0 at n=0, 1 at n≥5 — how much to trust surfaceWinRate */
  surfaceWinRateConfidence: number;
  recentWinRate: number;     // last 10 matches
  /** 0 at n=0, 1 at n≥5 — how much to trust recentWinRate */
  recentWinRateConfidence: number;
  avgOppRank: number;        // SOS proxy (lower avg rank = tougher schedule)
  surfaceAvgOppRank: number;
  retirementRate: number;    // times player retired / total
  lastMatchDate: Date | null;
  currentRank: number | null;
  tournamentWinRate: number;
  tournamentTotal: number;
  quarterWinRates: number[]; // for consistency calculation
}

export function computePlayerStats(
  matches: MatchRow[],
  playerId: string,
  surface: string | null,
  tournamentName: string | null,
): PlayerStats {
  const total = matches.length;
  const wins = matches.filter(m => m.winner_id === playerId).length;
  const winRate = total > 0 ? wins / total : 0.5;

  const surfaceKey = surface?.toLowerCase() ?? null;
  const surfaceMatches = surfaceKey
    ? matches.filter(m => m.surface?.toLowerCase() === surfaceKey)
    : [];
  const surfaceWins = surfaceMatches.filter(m => m.winner_id === playerId).length;

  const recent10 = matches.slice(0, 10);
  const recent10Wins = recent10.filter(m => m.winner_id === playerId).length;

  // Avg opponent rank (strength of schedule)
  const getOppRank = (m: MatchRow) =>
    m.player1_id === playerId ? m.player2_rank : m.player1_rank;

  const rankedMatches = matches.filter(m => getOppRank(m) != null && (getOppRank(m) ?? 0) > 0);
  const avgOppRank = rankedMatches.length > 0
    ? rankedMatches.reduce((s, m) => s + (getOppRank(m) ?? 200), 0) / rankedMatches.length
    : 200;

  const surfaceRanked = surfaceMatches.filter(m => getOppRank(m) != null && (getOppRank(m) ?? 0) > 0);
  const surfaceAvgOppRank = surfaceRanked.length > 0
    ? surfaceRanked.reduce((s, m) => s + (getOppRank(m) ?? 200), 0) / surfaceRanked.length
    : avgOppRank;

  // Retirement rate (only when the player lost via retirement — opponent retired doesn't count)
  const retiredLosses = matches.filter(m => m.retired && m.winner_id !== playerId).length;
  const retirementRate = total > 0 ? retiredLosses / total : 0;

  const lastMatchDate = matches.length > 0 ? matches[0].scheduled_start_at : null;

  // Current rank: from most recent match
  const currentRank = matches.length > 0
    ? (matches[0].player1_id === playerId ? matches[0].player1_rank : matches[0].player2_rank)
    : null;

  // Tournament experience
  const tName = tournamentName?.toLowerCase().slice(0, 8) ?? null;
  const tournamentMatches = tName
    ? matches.filter(m => m.tournament_name?.toLowerCase().includes(tName))
    : [];
  const tournamentWins = tournamentMatches.filter(m => m.winner_id === playerId).length;

  // Win rates by quarter (for consistency)
  const qSize = Math.max(1, Math.floor(total / 4));
  const quarterWinRates: number[] = [];
  for (let i = 0; i < 4 && i * qSize < total; i++) {
    const chunk = matches.slice(i * qSize, (i + 1) * qSize);
    if (chunk.length >= 3) {
      quarterWinRates.push(chunk.filter(m => m.winner_id === playerId).length / chunk.length);
    }
  }

  return {
    total, winRate,
    winRateConfidence: Math.min(1, total / 10),
    surfaceTotal: surfaceMatches.length,
    surfaceWinRate: surfaceMatches.length > 0 ? surfaceWins / surfaceMatches.length : 0.5,
    surfaceWinRateConfidence: Math.min(1, surfaceMatches.length / 5),
    recentWinRate: recent10.length > 0 ? recent10Wins / recent10.length : 0.5,
    recentWinRateConfidence: Math.min(1, recent10.length / 5),
    avgOppRank, surfaceAvgOppRank,
    retirementRate, lastMatchDate, currentRank,
    tournamentWinRate: tournamentMatches.length > 0 ? tournamentWins / tournamentMatches.length : 0.5,
    tournamentTotal: tournamentMatches.length,
    quarterWinRates,
  };
}

// ---------------------------------------------------------------------------
// Grade assignment
// ---------------------------------------------------------------------------

function toReliabilityGrade(validationScore: number, coverage: number): "A" | "B" | "C" | "D" | "F" {
  // Coverage caps the maximum reliability grade (spec: Validation=92, Coverage=35% → NOT grade A).
  //
  // NOTE: coverage is now normalised against the achievable maximum (i.e. it excludes the
  // permanently-absent structural factors utr/serveAdvantage/returnAdvantage/holdBreak whose
  // combined 27% weight can never be populated).  Under the old raw formula every match was
  // hardcoded at 73%, which capped all grades at B.  Under the new formula a match with no
  // variable-data gaps reaches 100%.  The 80/65/50/35 band thresholds remain correct:
  //   ≥ 80 = only structural gaps + at most one minor variable gap → Grade A eligible
  //   65–79 = some variable data missing (e.g. no market odds AND thin surface history)
  //   50–64 = notable variable gaps
  //   35–49 = heavy variable gaps
  //   < 35  = nearly all variable factors absent
  const coverageCap: "A" | "B" | "C" | "D" | "F" =
    coverage >= 80 ? "A" :
    coverage >= 65 ? "B" :
    coverage >= 50 ? "C" :
    coverage >= 35 ? "D" : "F";

  const scoreGrade: "A" | "B" | "C" | "D" | "F" =
    validationScore >= 76 ? "A" :
    validationScore >= 63 ? "B" :
    validationScore >= 50 ? "C" :
    validationScore >= 38 ? "D" : "F";

  const ORDER = ["F", "D", "C", "B", "A"] as const;
  return ORDER[Math.min(ORDER.indexOf(coverageCap), ORDER.indexOf(scoreGrade))];
}

function toParlayGrade(validationScore: number, riskScore: number, grade: string): "Elite" | "Strong" | "Moderate" | "Weak" | "Reject" {
  const adj = validationScore - riskScore * 0.35;
  if (adj >= 52 && grade <= "B") return "Elite";
  if (adj >= 43 && grade <= "C") return "Strong";
  if (adj >= 34) return "Moderate";
  if (adj >= 22) return "Weak";
  return "Reject";
}

function toDecision(
  validationScore: number,
  riskScore: number,
  grade: string,
  coverage: number,
  criticalFlags: string[],
): "KEEP" | "BORDERLINE" | "REMOVE" {
  const hasCritical = criticalFlags.some(f =>
    f.includes("injury") || f.includes("retirement") || f.includes("market disagreement") ||
    f.includes("stale data") || f.includes("No match history")
  );

  if (grade === "F" || validationScore <= 33 || riskScore >= 70) return "REMOVE";
  if (hasCritical || coverage < 40) return "BORDERLINE";
  if (validationScore >= 58 && riskScore <= 44 && grade !== "D" && coverage >= 50) return "KEEP";
  return "BORDERLINE";
}

// ---------------------------------------------------------------------------
// Reason generation (evidence-based, non-generic)
// ---------------------------------------------------------------------------

function generateReasons(factors: FactorScore[], sel: PlayerStats, opp: PlayerStats, surface: string | null): string[] {
  const reasons: string[] = [];

  // Sort available factors by magnitude of deviation from neutral (strongest signal first)
  const available = factors
    .filter(f => f.status !== "unavailable" && f.detail)
    .sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50));

  for (const f of available) {
    if (f.detail && !reasons.includes(f.detail)) {
      reasons.push(f.detail);
    }
    if (reasons.length >= 5) break;
  }

  // Always have at least 3
  if (reasons.length < 3) {
    if (sel.total < 10) reasons.push("Limited match history available — validation confidence is reduced");
    if (surface && sel.surfaceTotal < 5) reasons.push(`Fewer than 5 ${surface} matches on record — surface analysis is limited`);
    if (reasons.length < 3) reasons.push("Insufficient historical data to make a high-confidence validation assessment");
  }

  return reasons.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function computeBuilderScore(snapshot: BuilderSnapshot): Promise<BuilderResult> {
  const {
    selectedPlayerId, selectedPlayerName, opponentId, opponentName, surface, tournamentName,
    marketOdds: suppliedMarketOdds, asOfDate,
  } = snapshot;

  // Detect live/in-play state. Once a match has started, betting market odds mechanically
  // reflect the current score rather than pre-match handicapping evidence. Feeding live odds
  // into marketConsensus, the risk adjustments, and the closeness signal would treat a
  // score artifact as if it were genuine pre-match disagreement.
  //
  // When scheduledStart is unknown (null/undefined) we conservatively assume pre-match so
  // that the lack of a commence time never silently disables market scoring.
  const scheduledStart = snapshot.scheduledStart ?? null;
  const matchIsLive = scheduledStart != null && new Date() > scheduledStart;

  // ── 1. Resolve both players' match history with multi-source fallback ────────
  //
  // The identity index + alias expansion + name search ensure that even when
  // the fixture's player_key differs from what's stored in historical_matches
  // (different provider namespace, abbreviated name, fragmented ID), we still
  // find the player's matches rather than returning an empty result set.
  //
  // Each layer is tried in order; the first one that returns rows wins:
  //   1. Direct ID exact match
  //   2. Identity-index canonical ID + all provider aliases  (IN clause)
  //   3. Name resolution via identity index                  (IN clause)
  //   4. Direct DB surname ILIKE search + initial filter
  //   5. Live provider fetch (skipped when asOfDate is set — backfill mode)
  const index = await getCachedPlayerIdentityIndex();

  // Resolve both players + kick off Tier 5 web research + live market odds in parallel.
  // Web research and odds fetching are both skipped in backfill mode (asOfDate set).
  // Market odds: selectedPlayerName is "player1" so quote.player1DecimalOdds is theirs directly.
  //
  // Live-match guard: when matchIsLive is true, skip the odds fetch entirely. The caller is
  // expected to supply the last-known pre-match odds via snapshot.marketOdds (frozen value).
  // If no pre-match odds were ever captured before the match went live, suppliedMarketOdds
  // will be null, fetchedMarketOdds will be null, and marketOdds falls through to the
  // existing "No market odds provided" neutral path (score 50) — never a live-score number.
  const [selResolution, oppResolution, webResearch, fetchedMarketOdds] = await Promise.all([
    resolvePlayerMatchRows(selectedPlayerId, selectedPlayerName, index, asOfDate),
    resolvePlayerMatchRows(opponentId, opponentName, index, asOfDate),
    asOfDate == null
      ? researchPlayerMatchup(selectedPlayerName, opponentName).catch(() => null)
      : Promise.resolve(null),
    // Skip when: (a) backfill mode, (b) user supplied odds, or (c) match has already started.
    (!matchIsLive && suppliedMarketOdds == null)
      ? attemptOddsApi(selectedPlayerName, opponentName, scheduledStart, asOfDate)
      : Promise.resolve(null),
  ]);

  // Use user-supplied odds when present; fall back to the live fetch result.
  // For a live match with no prior odds, both are null → neutral path applies.
  const marketOdds = suppliedMarketOdds ?? fetchedMarketOdds;

  const selResolvedId = selResolution.resolvedId;
  const oppResolvedId = oppResolution.resolvedId;
  const selMatches = selResolution.rows;
  const oppMatches = oppResolution.rows;

  // Matchstat enrichment — scraped aggregate surface/form data from matchstat.com.
  // Only attempted in live mode (not backfill) when a player has sparse match history.
  // Feeds surfaceAdvantage and recentForm factor fallbacks below.
  const MIN_FOR_MATCHSTAT = 5;
  const needsMatchstat =
    asOfDate == null &&
    (selMatches.length < MIN_FOR_MATCHSTAT || oppMatches.length < MIN_FOR_MATCHSTAT);
  const [selMatchstat, oppMatchstat]: [MatchstatPlayerData | null, MatchstatPlayerData | null] =
    needsMatchstat
      ? await Promise.all([
          scrapeMatchstatPlayer(selectedPlayerName).catch(() => null),
          scrapeMatchstatPlayer(opponentName).catch(() => null),
        ])
      : [null, null];

  // H2H: query using all known alias IDs for both players so we catch cross-
  // provider match records where one player is stored under a different key.
  const selH2hIds = selResolution.aliasIds;
  const oppH2hIds = oppResolution.aliasIds;
  const h2hParams = [...selH2hIds, ...oppH2hIds];
  const s = selH2hIds.length;
  const o = oppH2hIds.length;
  const selIN = selH2hIds.map((_, i) => `$${i + 1}`).join(", ");
  const oppIN = oppH2hIds.map((_, i) => `$${s + i + 1}`).join(", ");

  // In backfill mode exclude H2H matches on or after the target match date.
  const h2hDateParamIdx = asOfDate != null ? h2hParams.length + 1 : null;
  const h2hQueryParams: unknown[] = asOfDate != null ? [...h2hParams, asOfDate] : h2hParams;
  const h2hDateCond = h2hDateParamIdx != null ? `AND scheduled_start_at < $${h2hDateParamIdx}` : "";

  const h2hRawRes = await pool.query<MatchRow>(`
    SELECT player1_id, player2_id, winner_id, player1_rank, player2_rank,
           surface, tournament_name, scheduled_start_at, retired, walkover
    FROM historical_matches
    WHERE ((player1_id IN (${selIN}) AND player2_id IN (${oppIN}))
        OR (player1_id IN (${oppIN}) AND player2_id IN (${selIN})))
      AND (cancelled IS NULL OR cancelled = false)
      ${h2hDateCond}
    ORDER BY scheduled_start_at DESC
    LIMIT 15
  `, h2hQueryParams);

  // Normalise H2H winner_id so the H2H factor can check m.winner_id === selResolvedId
  const selAliasSet = new Set(selH2hIds);
  const oppAliasSet = new Set(oppH2hIds);
  const h2hMatches = h2hRawRes.rows.map(r => ({
    ...r,
    winner_id: r.winner_id == null ? null
      : selAliasSet.has(r.winner_id) ? selResolvedId
      : oppAliasSet.has(r.winner_id) ? oppResolvedId
      : r.winner_id,
  }));

  // ── No-evidence guard ────────────────────────────────────────────────────
  //
  // If a player is absent from the local DB AND the live-fetch returned a
  // no-data outcome, we have zero real evidence. Computing any grade from
  // zero matches is actively misleading — return DATA_UNAVAILABLE instead.
  //
  // No-data outcomes (in live mode only — backfill skips Layer 5 entirely
  // and intentionally scores thin-data rows to build calibration data):
  //   SOURCE_UNAVAILABLE  — providers timed out or errored
  //   DATA_UNAVAILABLE    — no provider API keys configured
  //   PLAYER_NOT_FOUND    — providers responded but don't know this player
  //   NO_MATCH_HISTORY    — player found; no completed pro match records

  const NO_EVIDENCE_OUTCOMES = new Set<ResolutionOutcome>([
    "SOURCE_UNAVAILABLE", "DATA_UNAVAILABLE", "PLAYER_NOT_FOUND", "NO_MATCH_HISTORY",
  ]);

  // Only applies in live mode (asOfDate = null); backfill mode never calls Layer 5.
  const isLiveMode = asOfDate == null;

  const selNoEvidenceOutcome = selResolution.liveFetchDiagnostics?.outcome;
  const oppNoEvidenceOutcome = oppResolution.liveFetchDiagnostics?.outcome;

  const selIsNoEvidence = isLiveMode && selMatches.length === 0 &&
    (selNoEvidenceOutcome == null || NO_EVIDENCE_OUTCOMES.has(selNoEvidenceOutcome));
  const oppIsNoEvidence = isLiveMode && oppMatches.length === 0 &&
    (oppNoEvidenceOutcome == null || NO_EVIDENCE_OUTCOMES.has(oppNoEvidenceOutcome));

  if (selIsNoEvidence || oppIsNoEvidence) {
    const noEvidencePlayers = [
      ...(selIsNoEvidence ? [selectedPlayerName] : []),
      ...(oppIsNoEvidence ? [opponentName] : []),
    ];

    // Pick the most specific cause for messaging (prefer the cause of the selected player,
    // then opponent, since we can only surface one primary note to the user).
    const primaryOutcome = selNoEvidenceOutcome ?? oppNoEvidenceOutcome;

    const noDataReason: DataSourceDiagnostics["noDataReason"] =
      primaryOutcome === "SOURCE_UNAVAILABLE" ? "provider-unreachable"
      : primaryOutcome === "DATA_UNAVAILABLE" ? "not-configured"
      : primaryOutcome === "PLAYER_NOT_FOUND" ? "player-not-found"
      : primaryOutcome === "NO_MATCH_HISTORY" ? "no-history"
      : "provider-unreachable"; // fallback (null outcome = Layer 5 skipped unexpectedly)

    const dataConfidenceNote =
      noDataReason === "provider-unreachable"
        ? `External data providers could not be reached for ${noEvidencePlayers.join(" and ")}. Validation is unavailable — try again when providers are online.`
        : noDataReason === "not-configured"
          ? `No data providers are configured for ${noEvidencePlayers.join(" and ")}. Check that API keys (API_TENNIS_KEY, X_RAPIDAPI_KEY) are set.`
          : noDataReason === "player-not-found"
            ? `${noEvidencePlayers.join(" and ")} could not be found in any configured data provider. Check spelling and try again.`
            : /* no-history */
              `${noEvidencePlayers.join(" and ")} was identified in provider records but has no completed professional match history. Cannot produce a meaningful grade.`;

    const criticalFlagMessage =
      noDataReason === "provider-unreachable"
        ? `Data unavailable — providers unreachable for: ${noEvidencePlayers.join(", ")}`
        : noDataReason === "not-configured"
          ? `Data unavailable — no provider keys configured for: ${noEvidencePlayers.join(", ")}`
          : noDataReason === "player-not-found"
            ? `Player not found in any provider — check name for: ${noEvidencePlayers.join(", ")}`
            : `No professional match records found for: ${noEvidencePlayers.join(", ")}`;

    const failureReasons =
      selResolution.liveFetchDiagnostics?.failureReasons.length
        ? selResolution.liveFetchDiagnostics.failureReasons
        : oppResolution.liveFetchDiagnostics?.failureReasons ?? [];

    const reasons = failureReasons.length > 0
      ? failureReasons
      : noDataReason === "provider-unreachable"
        ? ["All configured data providers were unreachable. No evidence could be gathered for this validation."]
        : noDataReason === "not-configured"
          ? ["No data provider API keys are configured. Set API_TENNIS_KEY or X_RAPIDAPI_KEY to enable live validation."]
          : noDataReason === "player-not-found"
            ? [`${noEvidencePlayers.join(" and ")} could not be found in any provider. Verify the player name and try again.`]
            : [`${noEvidencePlayers.join(" and ")} has no completed professional match records on file.`];

    const dataSourceDiagnostics: DataSourceDiagnostics = {
      selectedPlayerStatus: "player_not_found",
      opponentStatus: "player_not_found",
      selectedPlayerMatchCount: 0,
      opponentMatchCount: 0,
      h2hMatchCount: 0,
      isProviderOutage: true,
      noDataReason,
      selectedPlayerProviderDiag: selResolution.liveFetchDiagnostics,
      opponentProviderDiag: oppResolution.liveFetchDiagnostics,
      dataConfidenceNote,
    };

    return {
      validationScore: 0,
      riskScore: 0,
      matchupCloseness: 50,
      reliabilityGrade: "F",
      parlayGrade: "Reject",
      removalProbability: 0,
      decision: "DATA_UNAVAILABLE",
      reasons,
      criticalFlags: [criticalFlagMessage],
      dataCoverage: 0,
      sourceAgreement: 0,
      sourcesAgreeing: 0,
      sourcesTotal: 0,
      factorScores: [],
      dataSourceDiagnostics,
      builderVersion: BUILDER_VERSION,
      matchStatus: matchIsLive ? "live" : "pre-match",
    };
  }

  const sel = computePlayerStats(selMatches, selResolvedId, surface, tournamentName);
  const opp = computePlayerStats(oppMatches, oppResolvedId, surface, tournamentName);

  // ── 2. Compute factor scores ──────────────────────────────────────────────

  const factors: FactorScore[] = [];

  function addFactor(
    key: string,
    label: string,
    score: number,
    detail: string,
    limited = false,
  ): void {
    const status = limited ? "limited" : "available";
    factors.push({
      key, label, score,
      weight: DEFAULT_WEIGHTS[key] ?? 0.01,
      status,
      supportsSelected: score > 52 ? true : score < 48 ? false : null,
      detail,
    });
  }

  function addUnavailable(key: string, label: string): void {
    factors.push({
      key, label, score: 50,
      weight: DEFAULT_WEIGHTS[key] ?? 0.01,
      status: "unavailable",
      supportsSelected: null,
      detail: "",
    });
  }

  // Factor: Overall Advantage (rank-adjusted win rate, proxy for Elo)
  if (sel.total >= 5 && opp.total >= 5) {
    // Rank-adjust: lower avg opp rank (harder SOS) boosts win rate
    const sosBoostSel = sel.avgOppRank < 80 ? 0.04 : sel.avgOppRank < 150 ? 0.02 : 0;
    const sosBoostOpp = opp.avgOppRank < 80 ? 0.04 : opp.avgOppRank < 150 ? 0.02 : 0;
    const adjSel = sel.winRate + sosBoostSel;
    const adjOpp = opp.winRate + sosBoostOpp;
    const score = diffScore(adjSel, adjOpp, 100);
    const pctSel = Math.round(sel.winRate * 100);
    const pctOpp = Math.round(opp.winRate * 100);
    const adv = score > 55 ? "advantage" : score < 45 ? "disadvantage" : "neutral";
    addFactor("overallAdvantage", "Overall Win Rate",
      score,
      `Overall win rate: ${selectedPlayerName} ${pctSel}% vs ${opponentName} ${pctOpp}% — ${adv} based on ${sel.total + opp.total} total matches`
    );
  } else {
    addFactor("overallAdvantage", "Overall Win Rate", 50,
      `Insufficient match history (${selectedPlayerName}: ${sel.total}, ${opponentName}: ${opp.total} matches)`, true);
  }

  // Factor: Surface Advantage
  if (surface && sel.surfaceTotal >= 3 && opp.surfaceTotal >= 3) {
    const score = diffScore(sel.surfaceWinRate, opp.surfaceWinRate, 100);
    const pctSel = Math.round(sel.surfaceWinRate * 100);
    const pctOpp = Math.round(opp.surfaceWinRate * 100);
    const label = score > 55 ? "favors" : score < 45 ? "favors opponent on" : "neutral on";
    addFactor("surfaceAdvantage", `${surface} Court Advantage`,
      score,
      `${surface} court record: ${selectedPlayerName} ${pctSel}% (${sel.surfaceTotal} matches) vs ${opponentName} ${pctOpp}% (${opp.surfaceTotal} matches) — ${label} ${surface}`
    );
  } else {
    const limited = (surface && (sel.surfaceTotal < 3 || opp.surfaceTotal < 3));
    // Matchstat enrichment fallback — use scraped surface records when raw data is sparse
    const selMs = surface ? selMatchstat?.surfaceRecords[surface as keyof typeof selMatchstat.surfaceRecords] : null;
    const oppMs = surface ? oppMatchstat?.surfaceRecords[surface as keyof typeof oppMatchstat.surfaceRecords] : null;
    if (surface && selMs && oppMs && (selMs.wins + selMs.losses) >= 2 && (oppMs.wins + oppMs.losses) >= 2) {
      const selMsRate = selMs.wins / (selMs.wins + selMs.losses);
      const oppMsRate = oppMs.wins / (oppMs.wins + oppMs.losses);
      const msScore = diffScore(selMsRate, oppMsRate, 100);
      addFactor("surfaceAdvantage", `${surface} Court Advantage`,
        msScore,
        `${surface} record (Matchstat): ${selectedPlayerName} ${selMs.wins}-${selMs.losses} vs ${opponentName} ${oppMs.wins}-${oppMs.losses}`,
        true
      );
    } else {
      addFactor("surfaceAdvantage", `${surface ?? "Surface"} Advantage`, 50,
        `${limited ? `Limited ${surface} court data (${selectedPlayerName}: ${sel.surfaceTotal}, ${opponentName}: ${opp.surfaceTotal})` : "No surface specified"}`, !!limited);
    }
  }

  // Factor: UTR (unavailable)
  addUnavailable("utr", "UTR Rating");

  // Factor: Recent Form (last 10 matches)
  const recentScore = diffScore(sel.recentWinRate, opp.recentWinRate, 100);
  if (sel.recentWinRate > 0.5 || opp.recentWinRate > 0.5) {
    const selR = Math.round(sel.recentWinRate * 10);
    const oppR = Math.round(opp.recentWinRate * 10);
    addFactor("recentForm", "Recent Form",
      recentScore,
      `Recent form (last 10): ${selectedPlayerName} ${selR}/10 wins vs ${opponentName} ${oppR}/10 wins`
    );
  } else {
    // Matchstat enrichment fallback — use scraped recent record when match history is sparse
    const selMsR = selMatchstat?.recentRecord;
    const oppMsR = oppMatchstat?.recentRecord;
    if (selMsR && oppMsR && (selMsR.wins + selMsR.losses) >= 3 && (oppMsR.wins + oppMsR.losses) >= 3) {
      const selMsRate = selMsR.wins / (selMsR.wins + selMsR.losses);
      const oppMsRate = oppMsR.wins / (oppMsR.wins + oppMsR.losses);
      const msScore = diffScore(selMsRate, oppMsRate, 100);
      addFactor("recentForm", "Recent Form",
        msScore,
        `Recent form (Matchstat): ${selectedPlayerName} ${selMsR.wins}-${selMsR.losses} vs ${opponentName} ${oppMsR.wins}-${oppMsR.losses}`,
        true
      );
    } else {
      addFactor("recentForm", "Recent Form", 50, "Recent match history insufficient for form analysis", true);
    }
  }

  // Factor: Surface Record (broader surface performance)
  if (surface && (sel.surfaceTotal >= 5 || opp.surfaceTotal >= 5)) {
    const score = diffScore(sel.surfaceWinRate, opp.surfaceWinRate, 80);
    addFactor("surfaceRecord", `${surface} Surface Record`, score,
      `${surface} overall record supports ${score > 52 ? selectedPlayerName : score < 48 ? opponentName : "neither player"}`
    );
  } else {
    addFactor("surfaceRecord", "Surface Record", 50, "Insufficient surface data", true);
  }

  // Factors: Serve, Return, Hold/Break — no data
  addUnavailable("serveAdvantage", "Serve Advantage");
  addUnavailable("returnAdvantage", "Return Advantage");
  addUnavailable("holdBreak", "Hold/Break Statistics");

  // Factor: Strength of Schedule
  if (sel.total >= 10 && opp.total >= 10) {
    // Better SOS + higher win rate = more impressive record
    // If both beat top opponents at similar rates, the one who beat harder opponents is favored
    const selSOS = sel.avgOppRank > 0 ? 1 / sel.avgOppRank : 0;  // lower rank = harder = higher value
    const oppSOS = opp.avgOppRank > 0 ? 1 / opp.avgOppRank : 0;
    // Combine: if selected beats tougher opponents, that's positive
    const selAdj = sel.winRate * (1 + selSOS * 100);
    const oppAdj = opp.winRate * (1 + oppSOS * 100);
    const score = diffScore(selAdj, oppAdj, 30);
    addFactor("strengthOfSchedule", "Strength of Schedule",
      score,
      `Avg opponent ranking: ${selectedPlayerName} ${Math.round(sel.avgOppRank)} vs ${opponentName} ${Math.round(opp.avgOppRank)}`
    );
  } else {
    addFactor("strengthOfSchedule", "Strength of Schedule", 50, "Insufficient data for schedule analysis", true);
  }

  // Factor: Market Consensus
  if (marketOdds != null && marketOdds > 1) {
    const impliedProb = 1 / marketOdds;
    const score = Math.round(50 + clamp((impliedProb - 0.5) * 100, -50, 50));
    const pct = Math.round(impliedProb * 100);
    const direction = impliedProb > 0.55 ? "supports" : impliedProb < 0.45 ? "disagrees with" : "is neutral on";
    addFactor("marketConsensus", "Market Consensus",
      score,
      `Betting market implies ${pct}% probability — market ${direction} this selection (odds ${marketOdds})`
    );
  } else {
    addFactor("marketConsensus", "Market Consensus", 50, "No market odds provided", true);
  }

  // Factor: Ranking Trend (current rank vs recent form trend)
  const selRank = sel.currentRank;
  const oppRank = opp.currentRank;
  if (selRank != null && oppRank != null) {
    // Lower rank number = better ranked; score inverts
    const score = diffScore(oppRank, selRank, 0.5);
    addFactor("rankingTrend", "Current Ranking",
      score,
      `Rankings: ${selectedPlayerName} #${selRank} vs ${opponentName} #${oppRank} — ${score > 52 ? `${selectedPlayerName} is higher-ranked` : score < 48 ? `${opponentName} is higher-ranked` : "similar rankings"}`
    );
  } else if (selRank != null || oppRank != null) {
    const known = selRank != null ? selectedPlayerName : opponentName;
    addFactor("rankingTrend", "Current Ranking", 50, `Ranking only available for ${known}`, true);
  } else {
    addFactor("rankingTrend", "Current Ranking", 50, "No ranking data available in recent matches", true);
  }

  // Factor: Head-to-Head
  if (h2hMatches.length >= 2) {
    const h2hWins = h2hMatches.filter(m => m.winner_id === selResolvedId).length;
    const h2hTotal = h2hMatches.length;
    const h2hRate = h2hWins / h2hTotal;
    // Recency weight: more recent matches count more
    const recentH2h = h2hMatches.slice(0, 5);
    const recentWins = recentH2h.filter(m => m.winner_id === selResolvedId).length;
    const blended = (h2hRate * 0.4 + (recentWins / recentH2h.length) * 0.6);
    const score = diffScore(blended, 1 - blended, 80);
    addFactor("headToHead", "Head-to-Head",
      score,
      `H2H record: ${selectedPlayerName} ${h2hWins}–${h2hTotal - h2hWins} vs ${opponentName} (last ${h2hTotal} meetings)`
    );
  } else if (h2hMatches.length === 1) {
    const won = h2hMatches[0].winner_id === selResolvedId;
    addFactor("headToHead", "Head-to-Head",
      won ? 58 : 42,
      `Only 1 H2H meeting found — ${selectedPlayerName} ${won ? "won" : "lost"} that match`, true);
  } else {
    addFactor("headToHead", "Head-to-Head", 50, "No previous meetings on record", true);
  }

  // Factor: Travel / Fatigue
  const selDaysRest = sel.lastMatchDate
    ? Math.floor((Date.now() - sel.lastMatchDate.getTime()) / 86_400_000)
    : null;
  const oppDaysRest = opp.lastMatchDate
    ? Math.floor((Date.now() - opp.lastMatchDate.getTime()) / 86_400_000)
    : null;
  if (selDaysRest != null && oppDaysRest != null) {
    // 1-3 days rest = ideal, <1 = fatigued, >14 = rust concern
    const restScore = (d: number) => d < 1 ? 0.3 : d === 1 ? 0.7 : d <= 3 ? 1.0 : d <= 7 ? 0.9 : d <= 14 ? 0.7 : 0.5;
    const score = diffScore(restScore(selDaysRest), restScore(oppDaysRest), 60);
    addFactor("travelFatigue", "Rest & Fatigue",
      score,
      `Days since last match: ${selectedPlayerName} ${selDaysRest}d vs ${opponentName} ${oppDaysRest}d`
    );
  } else {
    addFactor("travelFatigue", "Rest & Fatigue", 50, "Match schedule data unavailable", true);
  }

  // Factor: Injury Risk — Tier 5 web research via Gemini Google Search grounding.
  // Skipped in backfill mode (webResearch is null when asOfDate is set).
  if (webResearch && webResearch.confidence >= 0.3) {
    const selFit = 100 - webResearch.selected.riskLevel;
    const oppFit = 100 - webResearch.opponent.riskLevel;
    const score = Math.round(clamp(50 + (selFit - oppFit) * 0.35, 20, 80));
    const parts: string[] = [];
    if (webResearch.selected.injuryStatus !== "unknown" && webResearch.selected.injuryStatus !== "fit") {
      parts.push(`${selectedPlayerName}: ${webResearch.selected.injuryDetail ?? webResearch.selected.injuryStatus}`);
    }
    if (webResearch.opponent.injuryStatus !== "unknown" && webResearch.opponent.injuryStatus !== "fit") {
      parts.push(`${opponentName}: ${webResearch.opponent.injuryDetail ?? webResearch.opponent.injuryStatus}`);
    }
    if (parts.length === 0) {
      parts.push(
        `No active injury concerns found — ${selectedPlayerName} risk: ${webResearch.selected.riskLevel}/100, ${opponentName} risk: ${webResearch.opponent.riskLevel}/100`,
      );
    }
    addFactor(
      "injuryRisk",
      "Injury & Fitness Risk",
      score,
      parts.join("; "),
      webResearch.confidence < 0.6,
    );
  } else {
    addFactor(
      "injuryRisk",
      "Injury & Fitness Risk",
      50,
      "No real-time injury data — web research returned no results or low confidence",
      true,
    );
  }

  // Factor: Tournament Experience
  if (tournamentName && (sel.tournamentTotal >= 2 || opp.tournamentTotal >= 2)) {
    const score = diffScore(
      sel.tournamentTotal > 0 ? sel.tournamentWinRate : 0.5,
      opp.tournamentTotal > 0 ? opp.tournamentWinRate : 0.5,
      80
    );
    addFactor("tournamentExperience", "Tournament Experience",
      score,
      `${tournamentName} experience: ${selectedPlayerName} ${sel.tournamentWinRate > 0 ? `${Math.round(sel.tournamentWinRate * 100)}% (${sel.tournamentTotal} matches)` : "no prior data"} vs ${opponentName} ${opp.tournamentTotal > 0 ? `${Math.round(opp.tournamentWinRate * 100)}% (${opp.tournamentTotal} matches)` : "no prior data"}`
    );
  } else {
    addFactor("tournamentExperience", "Tournament Experience", 50,
      tournamentName ? "Insufficient tournament history" : "No tournament specified", true);
  }

  // Factor: Historical Consistency (lower stddev in quarterly win rates = more consistent)
  const selStd = stddev(sel.quarterWinRates);
  const oppStd = stddev(opp.quarterWinRates);
  if (sel.quarterWinRates.length >= 2 && opp.quarterWinRates.length >= 2) {
    // Lower stddev = more consistent = favored (inverse relationship)
    const score = diffScore(oppStd, selStd, 150);
    addFactor("historicalConsistency", "Historical Consistency",
      score,
      `Performance consistency: ${selectedPlayerName} ${score > 52 ? "more consistent" : score < 48 ? "less consistent" : "similar"} to ${opponentName} over the past 2 years`
    );
  } else {
    addFactor("historicalConsistency", "Historical Consistency", 50, "Insufficient history for consistency analysis", true);
  }

  // Factor: Historical Volatility (retirement/walkover rate)
  if (sel.total >= 10 && opp.total >= 10) {
    // Lower retirement rate = lower volatility = favored
    const score = diffScore(opp.retirementRate, sel.retirementRate, 200);
    const selPct = Math.round(sel.retirementRate * 100);
    const oppPct = Math.round(opp.retirementRate * 100);
    addFactor("historicalVolatility", "Historical Volatility",
      score,
      `Retirement rate: ${selectedPlayerName} ${selPct}% vs ${opponentName} ${oppPct}% — ${score > 52 ? `${selectedPlayerName} has lower volatility` : score < 48 ? `${opponentName} is more reliable` : "similar retirement history"}`
    );
  } else {
    addFactor("historicalVolatility", "Historical Volatility", 50, "Insufficient data for volatility analysis", true);
  }

  // Factor: Data Quality (% of expected matches available)
  //
  // BUG A FIX: This factor measures the AVERAGE data coverage for BOTH players combined.
  // Swapping sel and opp produces an identical score — it is NOT a directional sel-vs-opp
  // comparison and must never vote in the agreement count. supportsSelected is always null
  // (data-quality gate, not a predictive signal). Using addFactor() here would silently set
  // supportsSelected=true whenever dqScore>52, injecting a phantom +1 into every matchup
  // regardless of which player is selected.
  const expectedMatches = 30;
  const selCoverage = Math.min(100, Math.round((sel.total / expectedMatches) * 100));
  const oppCoverage = Math.min(100, Math.round((opp.total / expectedMatches) * 100));
  const avgDataCoverage = (selCoverage + oppCoverage) / 2;
  const dqScore = clamp(Math.round(avgDataCoverage * 0.5 + 50 - 25), 20, 80);
  factors.push({
    key: "dataQuality",
    label: "Data Coverage Quality",
    score: dqScore,
    weight: DEFAULT_WEIGHTS.dataQuality ?? 0.02,
    status: "available",
    supportsSelected: null, // intentionally non-directional: measures combined coverage for BOTH players
    detail: `Data coverage: ${selectedPlayerName} ${selCoverage}%, ${opponentName} ${oppCoverage}% of expected match history available`,
  });

  // ── 3. Source Agreement (computed after all other factors) ────────────────
  //
  // IMPORTANT: only count factors that actively took a side (supportsSelected !== null).
  // Neutral factors (score ≈ 50, supportsSelected = null) are legitimately undecided —
  // including them in the denominator would make 0/13 appear when actually 0 factors had
  // enough data to form an opinion. The displayed "X of Y sources agree" should mean
  // "X of the Y factors that could take a side agree", not "X of all factors".

  const decisiveFacters = factors.filter(f => f.status !== "unavailable" && f.key !== "sourceAgreement");
  // Only opinionated factors (those that actually support or oppose) count in agreement math
  const opinionatedFactors = decisiveFacters.filter(f => f.supportsSelected !== null);
  const agreeing = opinionatedFactors.filter(f => f.supportsSelected === true).length;
  const available = opinionatedFactors.length;
  // Edge-weighted: each factor's vote counts in proportion to its validated predictive edge,
  // not as a flat +1. Weak/negative-edge factors (e.g. historicalVolatility) can no longer
  // outvote high-signal ones. Falls back to raw-count (0.5) when no factors are opinionated.
  const agreementRate = edgeWeightedAgreementRate(opinionatedFactors);
  const agreementScore = Math.round(agreementRate * 100);
  const saFactor: FactorScore = {
    key: "sourceAgreement",
    label: "Source Agreement",
    score: diffScore(agreementRate, 1 - agreementRate, 100),
    weight: DEFAULT_WEIGHTS.sourceAgreement,
    status: "available",
    supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null,
    detail: `${agreeing} of ${available} sources agree — ${agreementScore}% edge-weighted agreement`,
  };
  factors.push(saFactor);

  // ── 4. Compute Validation Score (weighted avg of available factors) ────────

  const availFactors = factors.filter(f => f.status !== "unavailable");
  const totalAvailWeight = availFactors.reduce((s, f) => s + f.weight, 0);
  const validationScore = Math.round(
    availFactors.reduce((s, f) => s + f.score * (f.weight / totalAvailWeight), 0)
  );

  // Coverage % normalised against achievable maximum.
  // Structurally-unavailable factors (utr, serveAdvantage, returnAdvantage, holdBreak) can
  // never have data regardless of match — their combined 27% weight must not suppress the
  // coverage ceiling.  dataCoverage = 100 when only structural gaps are missing; genuine
  // variable-data gaps (no market odds, thin history, etc.) still drag coverage down.
  const unavailWeight = factors.filter(f => f.status === "unavailable").reduce((s, f) => s + f.weight, 0);
  const variableUnavailWeight = Math.max(0, unavailWeight - STRUCTURAL_MAX_UNAVAIL_WEIGHT);
  const dataCoverage = clamp(
    Math.round((1 - variableUnavailWeight / (1 - STRUCTURAL_MAX_UNAVAIL_WEIGHT)) * 100),
    0, 100,
  );

  // ── 5. Risk Score (independent calculation) ───────────────────────────────

  let risk = 35; // baseline

  // Raise risk for negative signals — continuous versions replace the old binary on/off
  // switches so adjacent values (e.g. recentWinRate 0.39 vs 0.41) differ by ~1 point
  // of risk rather than a hard 12-point cliff.
  risk += Math.round(Math.max(0, (0.4 - sel.recentWinRate) / 0.4) * 12);
  if (surface && sel.surfaceTotal >= 5)
    risk += Math.round(Math.max(0, (0.4 - sel.surfaceWinRate) / 0.4) * 10);
  if (marketOdds != null && 1 / marketOdds < 0.42) risk += 18;
  // Same-day fatigue carries a higher penalty than same-day-previous: playing twice in one
  // day is meaningfully more risky than having played yesterday.  These are mutually exclusive
  // branches so the penalties don't stack.
  if (selDaysRest != null) {
    if (selDaysRest === 0) risk += 18;       // played today — same-day fatigue
    else if (selDaysRest <= 1) risk += 10;   // played yesterday
  }
  if (sel.retirementRate > 0.12) risk += 8;
  risk += Math.round(Math.max(0, (opp.recentWinRate - 0.7) / 0.3) * 8);
  // Data-scarcity penalty: 0 at n≥10, full 15 at n=0 — thin data is penalised
  // proportionally so a 1-match player differs meaningfully from a 9-match one.
  risk += Math.round((1 - Math.min(1, sel.total / 10)) * 15);
  risk += Math.round((1 - Math.min(1, opp.total / 10)) * 15);
  if (dataCoverage < 60) risk += 10;

  // Lower risk for positive signals
  if (sel.winRate > 0.65 && sel.total >= 15) risk -= 10;
  if (surface && sel.surfaceWinRate > 0.65 && sel.surfaceTotal >= 8) risk -= 10;
  if (agreementRate > 0.75 && available >= 5) risk -= 8;  // BUG C FIX: minimum sample gate
                                                           // (previously no floor — a 3/3 collapsed
                                                           // set got a stronger bonus than 7/8 full)
  if (marketOdds != null && 1 / marketOdds > 0.60) risk -= 12;
  if (selRank != null && oppRank != null && selRank < oppRank * 0.5) risk -= 8;

  const preClosenessRisk = clamp(Math.round(risk), 0, 100);

  // ── 5b. Matchup Closeness Floor ─────────────────────────────────────────
  //
  // Bug found 2026-07 (K. Day vs. M. Hontama, WTA 125 Vancouver): the risk formula above only
  // rewards "conventional favorite" stats (win rate, market odds, source agreement) and never
  // asks how far apart the two players actually are. A player can clear several of the
  // risk-reducing bonuses above and still be in a genuine coin-flip matchup, producing an
  // unearned near-zero risk score. This section computes an independent closeness signal from
  // data this service already has (win rate gap, surface win rate gap, market-implied
  // probability, ranking gap) and uses it as a FLOOR — not an offsettable addition — so a
  // genuinely close matchup can never be scored as low-risk no matter how favorable the other
  // signals look.
  //
  // Threshold constants validated 2026-07-31 against 1,500 graded backfill legs (2022–2026).
  // See src/scripts/analyzeClosenessFloors.ts for the full reproducible analysis.
  //
  //   Reconstructed closeness band │  n   │ accuracy │ verdict
  //   ─────────────────────────────┼──────┼──────────┼────────────────────────────────
  //   ≥ 80  (very close / c-flip)  │ 1404 │  52.9 %  │ riskFloor=55 ✓ (genuine coin-flip)
  //   65–79 (close)                │   44 │  56.8 %  │ riskFloor=40 ✓ (above coin-flip)
  //   50–64 (moderate separation)  │   47 │  57.4 %  │ no floor     ✓
  //   < 50  (clearly separated)    │    5 │  80.0 %  │ no floor     ✓
  //
  //   Floor impact (cs ≥ 80): 430 rows had pre-closeness risk < 55; the floor prevented
  //   those from being scored "moderate risk" on matchups that were genuinely near-50/50.
  //   No constant adjustment is required — thresholds are confirmed by graded outcomes.

  const closenessSignals: number[] = [];

  // Win rate gap: 0 gap = maximally close (100), 0.4+ gap = clearly separated (0).
  // ONLY included when both players have enough data for winRate to be meaningful —
  // a 0.5 vs 0.5 gap from two thin-data defaults is absence-of-signal, not a real
  // even matchup, and should not trigger the closeness floor.
  const winRateSignalConf = Math.min(sel.winRateConfidence, opp.winRateConfidence);
  if (winRateSignalConf > 0) {
    const winRateGap = Math.abs(sel.winRate - opp.winRate);
    const rawSignal = clamp(Math.round((1 - winRateGap / 0.4) * 100), 0, 100);
    closenessSignals.push(Math.round(rawSignal * winRateSignalConf));
  }

  // Surface win rate gap, only when both players have a real surface sample
  if (surface && sel.surfaceTotal >= 5 && opp.surfaceTotal >= 5) {
    const surfaceGap = Math.abs(sel.surfaceWinRate - opp.surfaceWinRate);
    closenessSignals.push(clamp(Math.round((1 - surfaceGap / 0.4) * 100), 0, 100));
  }

  // Market-implied probability distance from a coin flip: 50% implied = maximally close (100)
  if (marketOdds != null) {
    const impliedProb = 1 / marketOdds;
    closenessSignals.push(clamp(Math.round((1 - Math.abs(impliedProb - 0.5) * 2) * 100), 0, 100));
  }

  // Ranking gap, relative to the lower (better) rank so the scale is comparable across tiers
  if (selRank != null && oppRank != null) {
    const relGap = Math.abs(selRank - oppRank) / Math.max(selRank, oppRank);
    closenessSignals.push(clamp(Math.round((1 - relGap) * 100), 0, 100));
  }

  const closenessScore = closenessSignals.length > 0
    ? Math.round(closenessSignals.reduce((s, v) => s + v, 0) / closenessSignals.length)
    : 50; // no independent signals available — neutral, no floor applied beyond the default below

  const riskFloor = closenessRiskFloor(closenessScore);
  const postClosenessRisk = clamp(Math.max(preClosenessRisk, riskFloor), 0, 100);

  // ── 5c. Thin-data risk floor ──────────────────────────────────────────────
  //
  // When either player has < 5 matches the risk is fundamentally unknown — not
  // low.  Two players sharing identical sparse win rates produce a closeness
  // signal of ~0 gap, which the closeness floor translates to ~0 added risk.
  // That is absence-of-signal, not evidence of a safe pick.
  //
  // The floor is a smooth ramp keyed on the minimum match count across both
  // players (thinDataRiskFloor above).  See the comment on THIN_DATA_RISK_FLOOR
  // for the walk-forward data that justifies each level.
  const _thinDataMinMatches = Math.min(sel.total, opp.total);
  const _thinDataFloor = thinDataRiskFloor(_thinDataMinMatches);
  const _thinDataFloorFired = _thinDataFloor > 0 && postClosenessRisk < _thinDataFloor;
  const riskScore = _thinDataFloorFired ? _thinDataFloor : postClosenessRisk;

  // ── 6. Critical flags & data source diagnostics ──────────────────────────────
  //
  // Three distinct states that must NOT be conflated:
  //   player_not_found  — 0 DB rows; ID mismatch or player has no professional record
  //   insufficient_data — 1–4 rows; player IS in DB but with minimal history
  //   data_available    — ≥5 rows; enough to compute real factor scores
  //
  // "I don't know" (player_not_found) ≠ "this is a bad bet" (negative score).

  const toPlayerStatus = (total: number): PlayerDataStatus =>
    total === 0 ? "player_not_found" : total < 5 ? "insufficient_data" : "data_available";

  const dataSourceDiagnostics: DataSourceDiagnostics = {
    selectedPlayerStatus: toPlayerStatus(sel.total),
    opponentStatus: toPlayerStatus(opp.total),
    selectedPlayerMatchCount: sel.total,
    opponentMatchCount: opp.total,
    h2hMatchCount: h2hMatches.length,
    selectedPlayerResolvedVia: selResolution.resolvedVia !== "direct" ? selResolution.resolvedVia : undefined,
    opponentResolvedVia: oppResolution.resolvedVia !== "direct" ? oppResolution.resolvedVia : undefined,
    // Include live-fetch diagnostics when the DB had no data and providers were tried
    selectedPlayerProviderDiag: selResolution.liveFetchDiagnostics,
    opponentProviderDiag: oppResolution.liveFetchDiagnostics,
  };

  const criticalFlags: string[] = [];

  // Helper: build a provider-aware "not found" message based on what the
  // live fetch actually reported (no provider called at all vs. called but
  // returned nothing vs. searched but player not recognised).
  const notFoundMessage = (name: string, diag?: LiveFetchDiagnostics): string => {
    if (!diag || diag.outcome === "CACHE_MISS") {
      return `No match history found for ${name} in any configured source`;
    }
    if (diag.outcome === "PLAYER_NOT_FOUND") {
      return `${name} was not recognised by ${diag.sourcesAttempted.join(", ")} — name may differ in provider records`;
    }
    if (diag.outcome === "NO_MATCH_HISTORY") {
      return `${name} was found in ${diag.sourcesSuccessful.join(", ")} but has no completed professional match records`;
    }
    if (diag.outcome === "SOURCE_UNAVAILABLE") {
      return `${name} — provider(s) could not be reached (${diag.sourcesFailed.join(", ")})`;
    }
    return `No match history found for ${name} across all configured sources`;
  };

  // Helper: human-readable source annotation for thin-data critical flags.
  const resolvedViaSource = (via: PlayerResolution["resolvedVia"]): string => {
    if (via === "provider-fetch") return " (live provider)";
    if (via === "cache-hit-supplemented") return " (stale cache — refreshed from live provider)";
    return "";
  };

  if (sel.total === 0) {
    criticalFlags.push(notFoundMessage(selectedPlayerName, selResolution.liveFetchDiagnostics));
    dataSourceDiagnostics.dataConfidenceNote =
      "Match history could not be retrieved from any source. Validation scores are unreliable — verify player name and try again.";
  } else if (sel.total < 5) {
    criticalFlags.push(`Very limited match history for ${selectedPlayerName} — ${sel.total} match${sel.total !== 1 ? "es" : ""} found${resolvedViaSource(selResolution.resolvedVia)}`);
  } else if (selResolution.resolvedVia === "cache-hit-supplemented") {
    // Non-critical info: stale cache was replaced with fresh provider data.
    dataSourceDiagnostics.dataConfidenceNote =
      (dataSourceDiagnostics.dataConfidenceNote ?? "") +
      (dataSourceDiagnostics.dataConfidenceNote ? " " : "") +
      `${selectedPlayerName}: stale local cache refreshed from live provider (${selResolution.liveFetchDiagnostics?.sourcesSuccessful?.join(", ") ?? "provider"}).`;
  }

  if (opp.total === 0) {
    if (!criticalFlags.some(f => f.includes("No match history") || f.includes("was not recognised") || f.includes("no completed"))) {
      criticalFlags.push(notFoundMessage(opponentName, oppResolution.liveFetchDiagnostics));
    }
    if (!dataSourceDiagnostics.dataConfidenceNote) {
      dataSourceDiagnostics.dataConfidenceNote =
        "Match history could not be retrieved from any source. Validation scores are unreliable — verify player name and try again.";
    }
  } else if (opp.total < 5) {
    criticalFlags.push(`Very limited match history for ${opponentName} — ${opp.total} match${opp.total !== 1 ? "es" : ""} found${resolvedViaSource(oppResolution.resolvedVia)}`);
  } else if (oppResolution.resolvedVia === "cache-hit-supplemented") {
    dataSourceDiagnostics.dataConfidenceNote =
      (dataSourceDiagnostics.dataConfidenceNote ?? "") +
      (dataSourceDiagnostics.dataConfidenceNote ? " " : "") +
      `${opponentName}: stale local cache refreshed from live provider (${oppResolution.liveFetchDiagnostics?.sourcesSuccessful?.join(", ") ?? "provider"}).`;
  }

  // Log when the thin-data risk floor was applied so it's visible in the admin diagnostics panel.
  if (_thinDataFloorFired) {
    const thinPlayers = [
      ...(sel.total < 5 ? [selectedPlayerName] : []),
      ...(opp.total < 5 ? [opponentName] : []),
    ].join(" and ");
    criticalFlags.push(
      `Thin-data risk floor (min ${_thinDataFloor}): riskScore raised from ${postClosenessRisk} — risk is unknown, not low, when data is thin for ${thinPlayers}`,
    );
  }

  // Only flag missing surface data when the player IS found (not-found gets its own message)
  if (surface && sel.surfaceTotal === 0 && sel.total > 0) {
    criticalFlags.push(`No ${surface} court matches found for ${selectedPlayerName}`);
  }
  if (marketOdds != null && 1 / marketOdds < 0.38) {
    criticalFlags.push("Large market disagreement — market strongly favors opponent");
  }
  if (selDaysRest != null && selDaysRest === 0) {
    criticalFlags.push(`${selectedPlayerName} may have played today`);
  }

  // ── 7. Grades and decision ────────────────────────────────────────────────

  const reliabilityGrade = toReliabilityGrade(validationScore, dataCoverage);
  let parlayGrade = toParlayGrade(validationScore, riskScore, reliabilityGrade);
  const decision = toDecision(validationScore, riskScore, reliabilityGrade, dataCoverage, criticalFlags);
  const removalProbability = clamp(Math.round((100 - validationScore) * 0.55 + riskScore * 0.45), 0, 100);

  // ── 7b. Consistency guard ─────────────────────────────────────────────────
  //
  // Elite tier is structurally incompatible with missing or thin player data: Elite requires
  // genuine, well-supported evidence for a high-confidence directional pick. When any player
  // has player_not_found or insufficient_data status AND the tier resolved to Elite (possible
  // when thin data happens to collapse factors into a unanimous but tiny sample), force the
  // grade down and record the caught inconsistency in criticalFlags for the admin diagnostics
  // panel. Modelled on the prediction engine's finalConsistencyCheck.ts.
  const _hasDataGap =
    dataSourceDiagnostics.selectedPlayerStatus !== "data_available" ||
    dataSourceDiagnostics.opponentStatus !== "data_available";
  if (parlayGrade === "Elite" && _hasDataGap) {
    const _gapPlayers = [
      ...(dataSourceDiagnostics.selectedPlayerStatus !== "data_available" ? [selectedPlayerName] : []),
      ...(dataSourceDiagnostics.opponentStatus !== "data_available" ? [opponentName] : []),
    ].join(" and ");
    criticalFlags.push(
      `Consistency guard: Elite tier forced down to Strong — insufficient data for ${_gapPlayers} contradicts Elite-tier confidence` +
      (_thinDataFloorFired ? ` (thin-data risk floor ${THIN_DATA_RISK_FLOOR} also applied)` : ""),
    );
    parlayGrade = "Strong";
  }

  // ── 8. Reasons ────────────────────────────────────────────────────────────

  const reasons = generateReasons(factors, sel, opp, surface);

  return {
    validationScore,
    riskScore,
    matchupCloseness: closenessScore, // new -- surface this on the card so it's not a silent internal-only number
    reliabilityGrade,
    parlayGrade,
    removalProbability,
    decision,
    reasons,
    criticalFlags,
    dataCoverage,
    sourceAgreement: agreementScore,
    sourcesAgreeing: agreeing,
    sourcesTotal: available,
    factorScores: factors,
    dataSourceDiagnostics,
    builderVersion: BUILDER_VERSION,
    matchStatus: matchIsLive ? "live" : "pre-match",
  };
}

export function computeCrossEngineAgreement(
  builderDecision: BuilderResult["decision"],
): boolean | null {
  if (builderDecision === "KEEP" || builderDecision === "BORDERLINE") return true;
  if (builderDecision === "REMOVE") return false;
  return null;
}

// ---------------------------------------------------------------------------
// Test-only staleness helper export
// ---------------------------------------------------------------------------
//
// Exposed so the staleness unit tests can exercise `isStaleResult` directly
// without needing to mock the database pool or provider chain.
// @internal — never import in production code.

export { isStaleResult as __TEST_isStaleResult };
export { STALE_MIN_MATCH_COUNT as __TEST_STALE_MIN_MATCH_COUNT };
export { STALE_MAX_MATCH_AGE_DAYS as __TEST_STALE_MAX_MATCH_AGE_DAYS };
export { applyStalenessSupplementIfNeeded as __TEST_applyStalenessSupplementIfNeeded };

// ---------------------------------------------------------------------------
// Test-only pure scoring helper (no DB, no external APIs)
// ---------------------------------------------------------------------------
//
// Replicates the pure factor + agreement + risk + consistency computation from
// computeBuilderScore so unit tests can exercise the scoring logic directly from
// pre-built PlayerStats without mocking the database pool or provider chain.
//
// ALL bug fixes (A, B, C, consistency guard) are included here — this function
// is the canonical reference for what "correct scoring" looks like.
//
// @internal — never import this in production code.

export interface __TEST_ScoringResult {
  factors: FactorScore[];
  agreeing: number;
  available: number;
  agreementRate: number;
  validationScore: number;
  dataCoverage: number;
  riskScore: number;
  reliabilityGrade: "A" | "B" | "C" | "D" | "F";
  parlayGrade: "Elite" | "Strong" | "Moderate" | "Weak" | "Reject";
  /** Non-null only when the consistency guard fired (Elite + data gap → forced to Strong). */
  caughtInconsistency: string | null;
  /** "pre-match" when scheduledStart is future/absent; "live" when it is in the past. */
  matchStatus: "pre-match" | "live";
}

export function __TEST_computeScoring(
  sel: PlayerStats,
  opp: PlayerStats,
  opts: {
    selectedPlayerName?: string;
    opponentName?: string;
    selResolvedId?: string;
    oppResolvedId?: string;
    surface?: string | null;
    tournamentName?: string | null;
    marketOdds?: number | null;
    h2hMatches?: ReadonlyArray<{ winner_id: string | null }>;
    selectedPlayerStatus?: PlayerDataStatus;
    opponentStatus?: PlayerDataStatus;
    /**
     * Match commence time — same semantics as BuilderSnapshot.scheduledStart.
     * When in the past, matchStatus is "live" in the returned result.
     * The test function never fetches live odds (opts.marketOdds is used directly),
     * so this only affects the surfaced matchStatus — not the factor computation.
     */
    scheduledStart?: Date | null;
  } = {},
): __TEST_ScoringResult {
  const selectedPlayerName = opts.selectedPlayerName ?? "Selected";
  const opponentName       = opts.opponentName       ?? "Opponent";
  const selResolvedId      = opts.selResolvedId      ?? "sel-id";
  const surface            = opts.surface            ?? null;
  const tournamentName     = opts.tournamentName     ?? null;
  const marketOdds         = opts.marketOdds         ?? null;
  const h2hArr             = (opts.h2hMatches ?? []) as { winner_id: string | null }[];
  const scheduledStart     = opts.scheduledStart     ?? null;
  const matchIsLive        = scheduledStart != null && new Date() > scheduledStart;

  const selRank = sel.currentRank;
  const oppRank = opp.currentRank;

  const selDaysRest = sel.lastMatchDate
    ? Math.floor((Date.now() - sel.lastMatchDate.getTime()) / 86_400_000)
    : null;
  const oppDaysRest = opp.lastMatchDate
    ? Math.floor((Date.now() - opp.lastMatchDate.getTime()) / 86_400_000)
    : null;

  const factors: FactorScore[] = [];

  const _addFactor = (key: string, label: string, score: number, detail: string, limited = false): void => {
    factors.push({
      key, label, score,
      weight: DEFAULT_WEIGHTS[key] ?? 0.01,
      status: limited ? "limited" : "available",
      supportsSelected: score > 52 ? true : score < 48 ? false : null,
      detail,
    });
  };
  const _addUnavailable = (key: string, label: string): void => {
    factors.push({ key, label, score: 50, weight: DEFAULT_WEIGHTS[key] ?? 0.01, status: "unavailable", supportsSelected: null, detail: "" });
  };

  // Overall Advantage
  if (sel.total >= 5 && opp.total >= 5) {
    const sosBoostSel = sel.avgOppRank < 80 ? 0.04 : sel.avgOppRank < 150 ? 0.02 : 0;
    const sosBoostOpp = opp.avgOppRank < 80 ? 0.04 : opp.avgOppRank < 150 ? 0.02 : 0;
    _addFactor("overallAdvantage", "Overall Win Rate",
      diffScore(sel.winRate + sosBoostSel, opp.winRate + sosBoostOpp, 100),
      `Overall win rate: ${selectedPlayerName} ${Math.round(sel.winRate * 100)}% vs ${opponentName} ${Math.round(opp.winRate * 100)}%`);
  } else {
    _addFactor("overallAdvantage", "Overall Win Rate", 50, `Insufficient match history (${selectedPlayerName}: ${sel.total}, ${opponentName}: ${opp.total})`, true);
  }

  // Surface Advantage
  if (surface && sel.surfaceTotal >= 3 && opp.surfaceTotal >= 3) {
    _addFactor("surfaceAdvantage", `${surface} Court Advantage`,
      diffScore(sel.surfaceWinRate, opp.surfaceWinRate, 100),
      `${surface} record: ${selectedPlayerName} ${Math.round(sel.surfaceWinRate * 100)}% vs ${opponentName} ${Math.round(opp.surfaceWinRate * 100)}%`);
  } else {
    _addFactor("surfaceAdvantage", `${surface ?? "Surface"} Advantage`, 50, surface ? `Limited ${surface} data` : "No surface specified", !!surface);
  }

  _addUnavailable("utr", "UTR Rating");

  // Recent Form
  if (sel.recentWinRate > 0.5 || opp.recentWinRate > 0.5) {
    _addFactor("recentForm", "Recent Form",
      diffScore(sel.recentWinRate, opp.recentWinRate, 100),
      `Recent form: ${selectedPlayerName} ${Math.round(sel.recentWinRate * 10)}/10 wins vs ${opponentName} ${Math.round(opp.recentWinRate * 10)}/10`);
  } else {
    _addFactor("recentForm", "Recent Form", 50, "Recent match history insufficient", true);
  }

  // Surface Record
  if (surface && (sel.surfaceTotal >= 5 || opp.surfaceTotal >= 5)) {
    _addFactor("surfaceRecord", `${surface} Surface Record`, diffScore(sel.surfaceWinRate, opp.surfaceWinRate, 80), `${surface} overall record`);
  } else {
    _addFactor("surfaceRecord", "Surface Record", 50, "Insufficient surface data", true);
  }

  _addUnavailable("serveAdvantage", "Serve Advantage");
  _addUnavailable("returnAdvantage", "Return Advantage");
  _addUnavailable("holdBreak", "Hold/Break Statistics");

  // Strength of Schedule
  if (sel.total >= 10 && opp.total >= 10) {
    const selAdj = sel.winRate * (1 + (sel.avgOppRank > 0 ? 1 / sel.avgOppRank : 0) * 100);
    const oppAdj = opp.winRate * (1 + (opp.avgOppRank > 0 ? 1 / opp.avgOppRank : 0) * 100);
    _addFactor("strengthOfSchedule", "Strength of Schedule", diffScore(selAdj, oppAdj, 30),
      `Avg opp rank: ${selectedPlayerName} ${Math.round(sel.avgOppRank)} vs ${opponentName} ${Math.round(opp.avgOppRank)}`);
  } else {
    _addFactor("strengthOfSchedule", "Strength of Schedule", 50, "Insufficient data", true);
  }

  // Market Consensus
  if (marketOdds != null && marketOdds > 1) {
    const impliedProb = 1 / marketOdds;
    _addFactor("marketConsensus", "Market Consensus",
      Math.round(50 + clamp((impliedProb - 0.5) * 100, -50, 50)),
      `Market implies ${Math.round(impliedProb * 100)}% (odds ${marketOdds})`);
  } else {
    _addFactor("marketConsensus", "Market Consensus", 50, "No market odds provided", true);
  }

  // Ranking Trend
  if (selRank != null && oppRank != null) {
    _addFactor("rankingTrend", "Current Ranking", diffScore(oppRank, selRank, 0.5),
      `Rankings: ${selectedPlayerName} #${selRank} vs ${opponentName} #${oppRank}`);
  } else if (selRank != null || oppRank != null) {
    _addFactor("rankingTrend", "Current Ranking", 50, "Ranking only available for one player", true);
  } else {
    _addFactor("rankingTrend", "Current Ranking", 50, "No ranking data", true);
  }

  // Head-to-Head
  if (h2hArr.length >= 2) {
    const h2hWins = h2hArr.filter(m => m.winner_id === selResolvedId).length;
    const recentH2h = h2hArr.slice(0, 5);
    const recentWins = recentH2h.filter(m => m.winner_id === selResolvedId).length;
    const blended = (h2hWins / h2hArr.length) * 0.4 + (recentWins / recentH2h.length) * 0.6;
    _addFactor("headToHead", "Head-to-Head", diffScore(blended, 1 - blended, 80),
      `H2H: ${selectedPlayerName} ${h2hWins}–${h2hArr.length - h2hWins}`);
  } else if (h2hArr.length === 1) {
    const won = h2hArr[0].winner_id === selResolvedId;
    _addFactor("headToHead", "Head-to-Head", won ? 58 : 42, `1 H2H meeting — ${selectedPlayerName} ${won ? "won" : "lost"}`, true);
  } else {
    _addFactor("headToHead", "Head-to-Head", 50, "No previous meetings", true);
  }

  // Travel Fatigue
  if (selDaysRest != null && oppDaysRest != null) {
    const restScore = (d: number) => d < 1 ? 0.3 : d === 1 ? 0.7 : d <= 3 ? 1.0 : d <= 7 ? 0.9 : d <= 14 ? 0.7 : 0.5;
    _addFactor("travelFatigue", "Rest & Fatigue", diffScore(restScore(selDaysRest), restScore(oppDaysRest), 60),
      `Days rest: ${selectedPlayerName} ${selDaysRest}d vs ${opponentName} ${oppDaysRest}d`);
  } else {
    _addFactor("travelFatigue", "Rest & Fatigue", 50, "Schedule data unavailable", true);
  }

  // Injury Risk (no live web research in test mode)
  _addFactor("injuryRisk", "Injury & Fitness Risk", 50, "No real-time injury data", true);

  // Tournament Experience
  if (tournamentName && (sel.tournamentTotal >= 2 || opp.tournamentTotal >= 2)) {
    _addFactor("tournamentExperience", "Tournament Experience",
      diffScore(sel.tournamentTotal > 0 ? sel.tournamentWinRate : 0.5, opp.tournamentTotal > 0 ? opp.tournamentWinRate : 0.5, 80),
      `${tournamentName} experience`);
  } else {
    _addFactor("tournamentExperience", "Tournament Experience", 50, tournamentName ? "Insufficient tournament history" : "No tournament specified", true);
  }

  // Historical Consistency
  if (sel.quarterWinRates.length >= 2 && opp.quarterWinRates.length >= 2) {
    _addFactor("historicalConsistency", "Historical Consistency",
      diffScore(stddev(opp.quarterWinRates), stddev(sel.quarterWinRates), 150),
      "Performance consistency");
  } else {
    _addFactor("historicalConsistency", "Historical Consistency", 50, "Insufficient history", true);
  }

  // Historical Volatility
  if (sel.total >= 10 && opp.total >= 10) {
    _addFactor("historicalVolatility", "Historical Volatility",
      diffScore(opp.retirementRate, sel.retirementRate, 200),
      `Retirement rate: ${selectedPlayerName} ${Math.round(sel.retirementRate * 100)}% vs ${opponentName} ${Math.round(opp.retirementRate * 100)}%`);
  } else {
    _addFactor("historicalVolatility", "Historical Volatility", 50, "Insufficient data", true);
  }

  // Data Quality — Bug A fix: supportsSelected always null (non-directional)
  {
    const expectedMatches = 30;
    const selCov = Math.min(100, Math.round((sel.total / expectedMatches) * 100));
    const oppCov = Math.min(100, Math.round((opp.total / expectedMatches) * 100));
    const dq = clamp(Math.round(((selCov + oppCov) / 2) * 0.5 + 25), 20, 80);
    factors.push({
      key: "dataQuality", label: "Data Coverage Quality", score: dq,
      weight: DEFAULT_WEIGHTS.dataQuality ?? 0.02,
      status: "available",
      supportsSelected: null, // intentionally non-directional
      detail: `Data coverage: ${selectedPlayerName} ${selCov}%, ${opponentName} ${oppCov}%`,
    });
  }

  // Source Agreement
  const decisiveF    = factors.filter(f => f.status !== "unavailable" && f.key !== "sourceAgreement");
  const opinionatedF = decisiveF.filter(f => f.supportsSelected !== null);
  const agreeing      = opinionatedF.filter(f => f.supportsSelected === true).length;
  const available     = opinionatedF.length;
  const agreementRate = edgeWeightedAgreementRate(opinionatedF);
  factors.push({
    key: "sourceAgreement", label: "Source Agreement",
    score: diffScore(agreementRate, 1 - agreementRate, 100),
    weight: DEFAULT_WEIGHTS.sourceAgreement,
    status: "available",
    supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null,
    detail: `${agreeing} of ${available} sources agree — ${Math.round(agreementRate * 100)}% edge-weighted agreement`,
  });

  // Validation Score
  const availF = factors.filter(f => f.status !== "unavailable");
  const totalW = availF.reduce((s, f) => s + f.weight, 0);
  const validationScore = Math.round(availF.reduce((s, f) => s + f.score * (f.weight / totalW), 0));
  const unavailW = factors.filter(f => f.status === "unavailable").reduce((s, f) => s + f.weight, 0);
  // Normalise against achievable max — mirrors computeBuilderScore's dataCoverage formula.
  const variableUnavailW = Math.max(0, unavailW - STRUCTURAL_MAX_UNAVAIL_WEIGHT);
  const dataCoverage = clamp(
    Math.round((1 - variableUnavailW / (1 - STRUCTURAL_MAX_UNAVAIL_WEIGHT)) * 100),
    0, 100,
  );

  // Risk Score — Bug B + Bug C fixes applied; flat adders converted to continuous ramps
  let risk = 35;
  risk += Math.round(Math.max(0, (0.4 - sel.recentWinRate) / 0.4) * 12);
  if (surface && sel.surfaceTotal >= 5)
    risk += Math.round(Math.max(0, (0.4 - sel.surfaceWinRate) / 0.4) * 10);
  if (marketOdds != null && 1 / marketOdds < 0.42) risk += 18;
  if (selDaysRest != null) {
    if (selDaysRest === 0) risk += 18;       // played today — same-day fatigue
    else if (selDaysRest <= 1) risk += 10;   // played yesterday
  }
  if (sel.retirementRate > 0.12) risk += 8;
  risk += Math.round(Math.max(0, (opp.recentWinRate - 0.7) / 0.3) * 8);
  risk += Math.round((1 - Math.min(1, sel.total / 10)) * 15);
  risk += Math.round((1 - Math.min(1, opp.total / 10)) * 15);
  if (dataCoverage < 60) risk += 10;
  if (sel.winRate > 0.65 && sel.total >= 15) risk -= 10;
  if (surface && sel.surfaceWinRate > 0.65 && sel.surfaceTotal >= 8) risk -= 10;
  if (agreementRate > 0.75 && available >= 5) risk -= 8;  // Bug C fix
  if (marketOdds != null && 1 / marketOdds > 0.60) risk -= 12;
  if (selRank != null && oppRank != null && selRank < oppRank * 0.5) risk -= 8;

  // Closeness floor — smooth ramp replacing the old two-step cliff
  const closenessSignals: number[] = [];
  // Gate winRate signal by confidence — thin-data 0.5-vs-0.5 is not real closeness
  const winRateSignalConf = Math.min(sel.winRateConfidence, opp.winRateConfidence);
  if (winRateSignalConf > 0) {
    const rawSignal = clamp(Math.round((1 - Math.abs(sel.winRate - opp.winRate) / 0.4) * 100), 0, 100);
    closenessSignals.push(Math.round(rawSignal * winRateSignalConf));
  }
  if (surface && sel.surfaceTotal >= 5 && opp.surfaceTotal >= 5)
    closenessSignals.push(clamp(Math.round((1 - Math.abs(sel.surfaceWinRate - opp.surfaceWinRate) / 0.4) * 100), 0, 100));
  if (marketOdds != null)
    closenessSignals.push(clamp(Math.round((1 - Math.abs(1 / marketOdds - 0.5) * 2) * 100), 0, 100));
  if (selRank != null && oppRank != null)
    closenessSignals.push(clamp(Math.round((1 - Math.abs(selRank - oppRank) / Math.max(selRank, oppRank)) * 100), 0, 100));
  const closenessScore = closenessSignals.length > 0
    ? Math.round(closenessSignals.reduce((s, v) => s + v, 0) / closenessSignals.length) : 50;
  const postClosenessRisk = clamp(Math.max(Math.round(risk), closenessRiskFloor(closenessScore)), 0, 100);

  // Thin-data risk floor — mirrors the same ramp guard in computeBuilderScore
  const selectedPlayerStatus = opts.selectedPlayerStatus
    ?? (sel.total === 0 ? "player_not_found" : sel.total < 5 ? "insufficient_data" : "data_available");
  const opponentStatus = opts.opponentStatus
    ?? (opp.total === 0 ? "player_not_found" : opp.total < 5 ? "insufficient_data" : "data_available");
  const _thinMinMatches = Math.min(sel.total, opp.total);
  const _thinFloor = thinDataRiskFloor(_thinMinMatches);
  const thinDataFloorFired = _thinFloor > 0 && postClosenessRisk < _thinFloor;
  const riskScore = thinDataFloorFired ? _thinFloor : postClosenessRisk;

  // Grades
  const reliabilityGrade = toReliabilityGrade(validationScore, dataCoverage);
  let parlayGrade = toParlayGrade(validationScore, riskScore, reliabilityGrade);

  // Consistency guard — Bug D fix
  let caughtInconsistency: string | null = null;
  const hasDataGap = selectedPlayerStatus !== "data_available" || opponentStatus !== "data_available";
  if (parlayGrade === "Elite" && hasDataGap) {
    const gapPlayers = [
      ...(selectedPlayerStatus !== "data_available" ? [selectedPlayerName] : []),
      ...(opponentStatus       !== "data_available" ? [opponentName]       : []),
    ].join(" and ");
    caughtInconsistency =
      `Consistency guard: Elite tier forced down to Strong — insufficient data for ${gapPlayers}` +
      (thinDataFloorFired ? ` (thin-data risk floor ${_thinFloor} also applied)` : "");
    parlayGrade = "Strong";
  }

  return { factors, agreeing, available, agreementRate, validationScore, dataCoverage, riskScore, reliabilityGrade, parlayGrade, caughtInconsistency, matchStatus: matchIsLive ? "live" : "pre-match" };
}
