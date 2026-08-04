import type { HistoricalMatchRow, SpecialistModelRow } from "@workspace/db";
import { runPredictionEngine } from "../predictionEngine";
import { resolveOpponentStrengthFromIndex, type EloHistoryIndex } from "../predictionEngine/opponentStrength";
import { reconstructHeadToHead, reconstructPlayerMatchHistory, type MatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { resolveSegmentSpecialistInputSync } from "./specialistWeights";
import { LIVE_MODEL_VERSION, type LiveFeatureSnapshot, type CalibrationKnot } from "./types";
import type { MatchFormat, PlayerProfile, Surface } from "../tennisData/types";
import type { PlayerIdentityIndex } from "../tennisData/playerIdentity";
import { extractFallbackInstrumentation, type FallbackSource } from "./fallbackInstrumentation";

/**
 * Everything `scoreHistoricalMatch` needs that's shared across every match in a walk-forward
 * run, preloaded ONCE by the caller (see `walkForward.ts`) instead of re-queried per match --
 * the corpus is small enough (tens of thousands of rows) to hold entirely in memory, and a full
 * run scores thousands of matches, so a per-match DB round-trip for match history/H2H/opponent
 * Elo would turn a run that should take seconds into one that takes hours.
 */
export interface HistoricalScoringContext {
  matchHistory: MatchHistoryIndex;
  eloHistory: EloHistoryIndex;
  /**
   * Task #77: whole-corpus canonical player-identity index, built ONCE per run (see
   * `walkForward.ts`) and passed through here so opponent resolution can canonicalize aliased
   * ids/name variants -- must be the SAME index used to build `eloHistory` (via
   * `buildEloHistoryIndex(identityIndex)`), or a fragmented opponent's history would be
   * canonicalized here but never actually merged in the index itself.
   */
  identityIndex: PlayerIdentityIndex;
  /**
   * Task #65: the tour/surface specialist state as it stood BEFORE this walk-forward run's own
   * fold scoring -- i.e. whatever the PREVIOUS run's `computeAndStoreSpecialistSegments` last
   * persisted (see `walkForward.ts`, which loads this once, before its own end-of-run refit
   * overwrites the table). Applying that prior fit here lets `specialistApplied` genuinely be
   * true for historical_test rows without circularity: a cycle's specialists are fit FROM this
   * cycle's own validation output, so they must never be applied back to this SAME cycle's rows.
   */
  specialistRowsBySegmentKey: ReadonlyMap<string, SpecialistModelRow>;
  /**
   * Set to `true` by shadow replay (`shadowReplay.ts`) to signal that this scoring call is a
   * point-in-time historical evaluation.  When true, the segment specialist is suppressed:
   * specialist calibration mappings in `specialistRowsBySegmentKey` are always from TODAY's DB
   * state (the previous run's persisted fit), never from the mapping that was in force as of the
   * match's own `cutoffAt`, so applying them alongside a historical general-calibration override
   * mixes two incompatible time-points and partially defeats the override.
   *
   * Walk-forward leaves this undefined/false: it legitimately uses the previous cycle's specialist
   * fit (pre-circular by design), so suppression is wrong there.
   *
   * Do NOT gate this on whether `activeCalibrationOverride` was supplied by the caller — that
   * would be a "caller-supplied-or-not" signal the calibration-architecture doc explicitly forbids,
   * because the override can be null even in a shadow replay run (no calibration history before
   * that match's date) while still needing consistent specialist treatment throughout the replay.
   */
  isPointInTimeReplay?: boolean;
}

function minimalProfile(id: string, name: string): PlayerProfile {
  // A historical match row carries only the two player ids/names it was imported with -- rank,
  // country, age, and playing hand are live-standings concepts this row never captured. Every
  // engine module that would use them (e.g. buildPlayerProfileWarnings) already treats an
  // absent field as "unknown", never a fabricated default.
  return { id, name, countryCode: null, currentRank: null, tour: null, age: null, plays: null, fullName: null };
}

/**
 * Scores a historical match by running the exact same live ensemble (`runPredictionEngine`)
 * real paper-trading/live predictions use, fed with real match history reconstructed from
 * Phase 3's leak-proof historical store -- strictly bounded to this match's own frozen
 * `cutoffAt`, so nothing timestamped at or after that instant can leak in.
 *
 * This replaces the earlier, deliberately reduced Elo/form/game-share reconstruction (see the
 * legacy `HistoricalFeatureSnapshot` type in `./types.ts`): walk-forward accuracy now describes
 * the actual model users see when they run a live prediction, not a simplified stand-in for it.
 *
 * The Phase 7 simulator's adoption vote, live calibration, and weather are always omitted
 * (null/undefined) here -- they are either themselves *outputs* of THIS SAME evaluation run
 * (simulator adoption/live calibration are fit FROM this run's walk-forward results, so feeding
 * them back in would be circular) or have no honest historical reconstruction (no archived
 * weather data). This mirrors the engine's own "absent, not faked" contract.
 *
 * Segment specialists are the one exception (Task #65): `context.specialistRowsBySegmentKey` is
 * the PREVIOUS run's persisted fit, not this run's own, so applying it here is not circular --
 * see the doc on `HistoricalScoringContext.specialistRowsBySegmentKey`.
 *
 * `activeCalibrationOverride` is a second, narrower exception, used ONLY by the shadow-mode
 * replay (`shadowReplay.ts`), never by walk-forward: unlike walk-forward's fold-fit mapping
 * (which IS an output of that same run, so applying it here would be circular), the shadow replay
 * reuses whichever calibration mapping was ALREADY genuinely active as of THIS match's own
 * `cutoffAt` (Task #160) -- a real, already-fitted prior artifact, not something this call is
 * fitting -- so passing it through is not circular. Callers resolve this per-match from their own
 * fitted-calibration history (see `shadowReplay.ts`'s `getCalibrationMappingAsOf`), not a single
 * value reused across every match in a run. Left undefined/null by every other caller, which
 * keeps their calibratedProbability equal to rawProbability, exactly as before.
 *
 * Returns null when either player has zero prior recorded matches, or this match's own
 * surface/format weren't resolved at import time -- there is no honest probability to produce in
 * either case, so the caller must treat it as "insufficient data" rather than a fabricated guess.
 */
export function scoreHistoricalMatch(
  match: HistoricalMatchRow,
  context: HistoricalScoringContext,
  activeCalibrationOverride?: CalibrationKnot[] | null,
): {
  rawProbability: number;
  calibratedProbability: number;
  snapshot: LiveFeatureSnapshot;
  modelAgreement: string;
  upsetRiskTier: string;
  usedFallback: boolean | null;
  fallbackSources: FallbackSource[] | null;
} | null {
  if (!match.surface || !match.matchFormat) return null;
  const surface = match.surface as Surface;
  const matchFormat = match.matchFormat as MatchFormat;

  const player1Matches = reconstructPlayerMatchHistory(context.matchHistory, match.player1Id, match.cutoffAt);
  const player2Matches = reconstructPlayerMatchHistory(context.matchHistory, match.player2Id, match.cutoffAt);
  if (player1Matches.length === 0 || player2Matches.length === 0) return null;

  const player1OpponentStrength = resolveOpponentStrengthFromIndex(player1Matches, context.eloHistory, context.identityIndex);
  const player2OpponentStrength = resolveOpponentStrengthFromIndex(player2Matches, context.eloHistory, context.identityIndex);
  const headToHead = reconstructHeadToHead(context.matchHistory, match.player1Id, match.player2Id, match.cutoffAt);
  // Task #65: previous-cycle specialist fit, never this cycle's own -- see the doc on
  // `HistoricalScoringContext.specialistRowsBySegmentKey`.
  // Shadow replay sets `context.isPointInTimeReplay = true` to suppress the specialist:
  // specialist calibration is always today's DB state, never the mapping in force at the match's
  // own cutoffAt, so mixing it with a per-match historical general calibration produces
  // inconsistent results. Walk-forward leaves isPointInTimeReplay false/undefined and continues
  // to apply the previous cycle's specialist fit (non-circular by design).
  //
  // NOTE: this intentionally does NOT gate on whether `activeCalibrationOverride` was supplied.
  // The shadow replay always suppresses specialists regardless of whether a calibration override
  // was resolved for a given match (the override can be null when no prior calibration artifact
  // predates that match's cutoffAt). Gating on the override presence would let specialist
  // behaviour silently diverge within a single replay run -- the pattern the
  // predictionengine-calibration-architecture.md doc explicitly forbids.
  const segment = context.isPointInTimeReplay
    ? null
    : resolveSegmentSpecialistInputSync(match.tour, surface, context.specialistRowsBySegmentKey);

  const output = runPredictionEngine({
    player1: minimalProfile(match.player1Id, match.player1Name),
    player2: minimalProfile(match.player2Id, match.player2Name),
    player1Matches,
    player2Matches,
    headToHead,
    surface,
    matchFormat,
    player1OpponentElo: player1OpponentStrength.lookup,
    player2OpponentElo: player2OpponentStrength.lookup,
    tournamentName: match.tournamentName,
    weather: null,
    segment,
    simulatorAdoption: null,
    activeCalibration: activeCalibrationOverride ?? null,
    // Task #77: this is the walk-forward evaluation's own run-scoped scoring path -- the caller
    // (`walkForward.ts`) resets the fallback tracker once at the start of each run, so it's safe
    // to attribute events here. Live/paper-trading/ablation callers must NOT set this (see
    // `PredictionEngineInput.trackEloFallback`'s doc).
    trackEloFallback: true,
    // 2026-07-14 Fatigue asOfDate fix: measure Fatigue's 3/7/14-day windows against this match's
    // own frozen cutoffAt, not today's wall-clock time -- see `PredictionEngineInput.asOfDate`.
    asOfDate: match.cutoffAt,
  });

  const snapshot: LiveFeatureSnapshot = {
    modelVersion: LIVE_MODEL_VERSION,
    engine: output.engine,
    preCalibrationProbability: output.rawEnsembleProbability,
    dataQuality: output.dataQuality,
    isEliteTier: output.engine.isEliteTier,
  };
  const fallback = extractFallbackInstrumentation({
    engine: output.engine,
    decisionTrace: output.decisionTrace,
  });

  return {
    rawProbability: output.rawEnsembleProbability / 100,
    // Equal to rawProbability for every existing caller (no override passed): unchanged
    // behavior. Only differs when `activeCalibrationOverride` is supplied (shadow replay).
    calibratedProbability: output.calibratedProbability / 100,
    snapshot,
    modelAgreement: output.engine.modelAgreement,
    upsetRiskTier: output.upsetRisk,
    usedFallback: fallback.usedFallback,
    fallbackSources: fallback.fallbackSources,
  };
}
