import { computeSurfaceEloModule } from "./surfaceElo";
import { computeServeReturnModule } from "./serveReturn";
import { computeRecentFormModule } from "./recentForm";
import { computeFatigueModule } from "./fatigue";
import { computeMatchLoadRecoveryModule } from "./matchLoadRecovery";
import { computeAvailabilityModule } from "./availability";
import { computeStyleMatchupModule } from "./styleMatchup";
import { computeHeadToHeadModule } from "./headToHead";
import { computeDataQuality, computeSurfaceSampleDepth, MODULE_IMPORTANCE, ENSEMBLE_WEIGHT_PRIOR, EXCLUDED_FROM_ENSEMBLE, EXCLUDED_FROM_DATA_QUALITY, CONFIDENCE_SHRINK, TOUR_RELIABILITY_DISCOUNT, LOW_SURFACE_SAMPLE_DISCOUNT } from "./dataQuality";
import { buildEnsemble, edgeToProbability, worseAgreement, type ModelVote } from "./ensemble";
import { computeWeightedDisagreement, computeMatchupCloseness, buildDisagreementNote, AGREEMENT_ORDER, type MatchupCloseness } from "./disagreement";
import { calibrateProbability } from "./calibration";
import { applyCalibration } from "../evaluation/calibration";
import { computeUpsetRisk, type UpsetRiskResult } from "./upsetRisk";
import { computeRecommendation } from "./recommendation";
import { deriveServicePointEstimate, runMatchSimulation, deriveMatchSeed, type MatchSimulationResult } from "./simulator";
import { applyTieBreaker } from "./tieBreakers";
import { computeEliteTier, voteFavorsPlayer1 } from "./eliteTier";
import { checkFinalConsistency } from "./finalConsistencyCheck";
import type { PredictionEngineInput } from "./types";
import type { WeatherConditions } from "./weather";

export interface EngineBreakdown {
  surfaceElo: ReturnType<typeof computeSurfaceEloModule>;
  serveReturn: ReturnType<typeof computeServeReturnModule>;
  recentForm: ReturnType<typeof computeRecentFormModule>;
  fatigue: ReturnType<typeof computeFatigueModule>;
  /** Task #93: live-wired went-the-distance recovery signal (see matchLoadRecovery.ts). Not present on predictions made before this field existed. */
  matchLoadRecovery: ReturnType<typeof computeMatchLoadRecoveryModule>;
  availability: ReturnType<typeof computeAvailabilityModule>;
  styleMatchup: ReturnType<typeof computeStyleMatchupModule>;
  headToHead: ReturnType<typeof computeHeadToHeadModule>;
  models: ModelVote[];
  modelAgreement: ReturnType<typeof buildEnsemble>["modelAgreement"];
  /** Always present when modelAgreement isn't "Strong" -- names the specific meaningfully-weighted models actually in conflict, their probabilities, and their weights (2026-07-13 disagreement recalibration, Part A.F). Null when modelAgreement is "Strong". See `./disagreement.ts`. */
  disagreementNote: string | null;
  /** How near the FINAL probability sits to a coin flip -- deliberately separate from modelAgreement: a match can be close while every model agrees (low disagreement), or genuinely disagree while the blend lands well away from 50 (2026-07-13 spec, Part A.E). Not present on predictions made before this field existed. */
  matchupCloseness: MatchupCloseness;
  reasons: string[];
  risks: string[];
  /**
   * Informational disclosures that are real, worth showing, but NOT evidence this specific match
   * is more upset-prone or lower-quality -- e.g. "no prior head-to-head meetings" (the normal case
   * for most matchups) or "not enough matches to tag a surface specialist" (a coverage gap, not a
   * red flag). Added by the 2026-07-13 "stop low-value signals" audit so this information keeps
   * showing up (never hidden) without being styled/counted like a real risk. Not present on
   * predictions made before this field existed.
   */
  disclosures: string[];
  warnings: string[];
  /**
   * Structural coverage gaps: data that is unavailable for structural reasons (a player has
   * no recorded match history, a venue isn't in our coverage, an external feed isn't connected)
   * rather than because the model evidence is thin. Unlike `warnings`, these don't increase
   * upset risk -- they explain WHY certain signals fall back to global defaults. Grouped by
   * root cause so one missing player doesn't produce a wall of identical-root bullets.
   * Absent on predictions made before this field existed.
   */
  coverageGaps: string[];
  availabilityNote: string;
  conditionsNote: string;
  weather: WeatherConditions | null;
  /** Segment key (e.g. "ATP-Clay") a specialist was evaluated for, or null when this match's tour isn't a Phase 6 candidate segment at all. */
  segmentKey: string | null;
  segmentLabel: string | null;
  /** True only when a segment specialist actually contributed to the blended probability below. */
  specialistApplied: boolean;
  /** Always present and always visible -- explains whether a specialist was applied, or exactly why the engine fell back to the general model. Never silent. */
  segmentNote: string;
  /** Phase 7: point-by-point Monte Carlo simulation output. Always computed and shown, regardless of whether it's been validated into the ensemble vote below. */
  simulation: MatchSimulationResult;
  /** True only when the simulator's own validated performance earned it a vote in calibratedProbability below. */
  simulatorApplied: boolean;
  /** Always present -- explains whether the simulator is voting, or exactly why not yet. Never silent. */
  simulatorNote: string;
  /**
   * True only when the final calibrated pick crosses the 50% line in the OPPOSITE direction from
   * the raw, reliability-weighted feature-module vote (surface Elo, serve/return, recent form,
   * fatigue, availability, head-to-head) -- i.e. calibration/specialist/simulator blending
   * overrode what the underlying evidence alone pointed to. This is disclosed, never suppressed:
   * calibration is a real, validated statistical process (fitted on actual graded outcomes), so
   * it is not blocked from overriding raw feature consensus, but the override itself is always
   * surfaced with an explanation of which stage flipped it and how each metric voted.
   */
  modelConflict: boolean;
  /** Concise, always-non-null-when-modelConflict-is-true explanation of which metrics favored the other side and which stage of the pipeline (general calibration, segment specialist, or simulator) flipped the final pick. Null when there's no conflict. */
  modelConflictNote: string | null;
  /**
   * True when the raw ensemble landed within `TIE_BAND` of a coin flip — signals a genuinely
   * close matchup. The old directional cascade (Serve & Return → Surface Elo → …) was removed
   * after validation showed every step performed at or below a coin flip in the tight-signal
   * regime (Task #5, 2026-07-15). When true, the raw ensemble probability flows through UNCHANGED
   * (no nudge), and `tieBreakerNote` carries an honest "close matchup" disclosure.
   * Not present on predictions made before this field existed.
   */
  tieBreakerApplied: boolean;
  /** Always null after Task #5's cascade removal. Kept for backward compatibility with stored predictions made before the fix. */
  tieBreakerDecidingStep: string | null;
  /** Always present when `tieBreakerApplied` is true -- explains that the match is genuinely close and no directional nudge was applied. Null otherwise. */
  tieBreakerNote: string | null;
  /** Module inputs that used a neutral no-data value at prediction time. */
  defaultedInputs: string[];
  /** True only when this prediction clears the Elite Prediction bar -- see `eliteTier.ts`. Not present on predictions made before this field existed. */
  isEliteTier: boolean;
  /** Always present -- explains why a prediction is or isn't elite tier. Never silent. */
  eliteTierReason: string;
  /** Recalibrated upset-risk breakdown (2026-07-13 disagreement/upset-risk spec, Part 2) -- see `upsetRisk.ts`. `EngineOutput.upsetRisk` stays the plain LOW/MODERATE/HIGH/EXTREME tier for existing API/DB consumers; this is the full auditable component breakdown behind it. Not present on predictions made before this field existed. */
  upsetRiskBreakdown: UpsetRiskResult;
  /** Per-matchup count of prior meetings/matches on the relevant surface for each player (same window `surfaceElo.ts` used), surfaced explicitly so a low-sample surface prediction is visibly flagged rather than silently blended in. Not present on predictions made before this field existed. */
  surfaceSampleDepth: ReturnType<typeof computeSurfaceSampleDepth>;
  /**
   * Task 56: output of the final-consistency guard (`finalConsistencyCheck.ts`), run as the very
   * last step before this EngineOutput is returned. Empty in the overwhelming common case --
   * every rule it checks already holds by construction elsewhere in this file. A non-empty array
   * means an upstream invariant broke (e.g. a future change reintroduced the original
   * Elite+HighDisagreement+"no model conflict" contradiction); when that happens, Elite tier is
   * force-withheld below and the violation is surfaced here rather than shown silently.
   */
  consistencyViolations: string[];
}

export interface EngineOutput {
  predictedWinnerId: string;
  predictedWinnerName: string;
  calibratedProbability: number; // for player 1, final -- Phase-4 fitted calibration when available, else the heuristic fallback
  /**
   * Final consistency guarantee: this is always the PREDICTED WINNER's own win probability
   * (>= 50, mirrored from `calibratedProbability` when player 2 is the pick), never player 1's
   * raw number mislabeled as the winner's confidence. `calibratedProbability` stays player-1-
   * relative because calibration fitting, model-conflict detection, and evaluation scoring all
   * depend on that fixed orientation -- this field exists so every display surface (match cards,
   * prediction log, ledger) can show a number that can never contradict the winner it sits next
   * to (e.g. a 44% figure next to the player the engine just called the favorite).
   */
  predictedWinnerProbability: number;
  /** Ensemble probability for player 1 before any calibration is applied -- kept for transparency and future calibration refitting. */
  rawEnsembleProbability: number;
  dataQuality: number;
  dataQualityLabel: ReturnType<typeof computeDataQuality>["label"];
  upsetRisk: UpsetRiskResult["upsetRisk"];
  recommendation: ReturnType<typeof computeRecommendation>;
  predictedSetScore: string;
  engine: EngineBreakdown;
  /** Task #32: full auditable trace of every intermediate pipeline stage and decision-chain rule. */
  decisionTrace: DecisionTrace;
  /** Populated asynchronously by the cross-engine agreement enrichment worker. */
  crossEngineAgreement: boolean | null;
}

// ---------------------------------------------------------------------------
// Task #32: Decision Trace types — full per-module and pipeline audit record
// ---------------------------------------------------------------------------

/** Raw edge value and ensemble contribution for a single module. */
export interface ModuleTrace {
  key: string;
  name: string;
  /** Raw player1Edge value fed into the ensemble (positive = favors player 1). */
  rawEdge: number;
  reliability: number;
  importance: number;
  weightPrior: number;
  /** Confidence shrink factor (1.0 if not applicable). */
  confidenceShrink: number;
  excludedFromEnsemble: boolean;
  excludedFromDataQuality: boolean;
  excludedByAblation: boolean;
  /** Player 1 win probability from this module; null if excluded from ensemble. */
  player1Probability: number | null;
  /** Weight actually used in the ensemble blend; null if excluded. */
  effectiveWeight: number | null;
  voteDirection: "player1" | "player2" | "tied" | null;
}

/** Full per-step pipeline + decision-chain trace; persisted to `decision_trace` JSONB column. */
export interface DecisionTrace {
  /** Player-1-relative probability (0-100) at each stage of the pipeline, in order. */
  pipeline: {
    rawEnsemble: number;
    tieBreakerApplied: boolean;
    afterTieBreaker: number;
    /** "fitted" = isotonic calibration from walk-forward; "fallback" = dataQuality-shrink heuristic. */
    calibrationMethod: "fitted" | "fallback";
    /** Shrink factor applied by the fallback (1.0 if fitted calibration was used instead). */
    fallbackShrinkFactor: number;
    afterCalibration: number;
    specialistWeight: number;
    afterSpecialist: number;
    reliabilityDiscount: number;
    afterReliabilityDiscount: number;
    simulatorScopeGap: number;
    simulatorScopeScale: number;
    simulatorWeight: number;
    afterSimulator: number;
  };
  /** All modules, including those excluded from the ensemble, with their raw edge values. */
  modules: ModuleTrace[];
  /** Every recommendation rule tested in order; the first `decided: true` entry is the winner. */
  recommendation: {
    result: string;
    margin: number;
    rulesChecked: Array<{ rule: string; matched: boolean; decided: boolean }>;
  };
  /** Pass/fail for every elite-tier gate. All must be true for isElite. */
  eliteTier: {
    isElite: boolean;
    gates: {
      dataQuality: { required: number; actual: number; passed: boolean };
      calibratedMargin: { required: number; actual: number; passed: boolean };
      allCoreModelsAgree: {
        surfaceEloFavorsP1: boolean;
        serveReturnFavorsP1: boolean;
        recentFormFavorsP1: boolean;
        passed: boolean;
      };
      specialistApplied: { passed: boolean };
      noModelConflict: { passed: boolean };
      notHighDisagreement: { actual: string; passed: boolean };
      upsetRiskAcceptable: { actual: string; passed: boolean };
      consistencyGuard: { passed: boolean; violations: string[] };
    };
  };
  computedAt: string;
}

/** Derive the dataQuality-shrink confidence factor (mirrors calibrateProbability internals). */
function getFallbackShrinkFactor(dq: number): number {
  if (dq < 20) return 0.4;
  if (dq < 55) return 0.4 + ((dq - 20) / 35) * (0.8 - 0.4);
  if (dq < 65) return 0.8;
  if (dq < 85) return 0.8 - ((dq - 65) / 20) * (0.8 - 0.52);
  return Math.max(0.4, 0.52 - ((dq - 85) / 15) * (0.52 - 0.4));
}

/** Trace every condition computeRecommendation tests, in order. */
function buildRecommendationTrace(
  calibratedProbability: number,
  dataQuality: number,
  dataQualityLabel: string,
  modelAgreement: string,
  result: string,
  tieBreakerApplied: boolean,
  coreSignalsAlign: boolean,
): DecisionTrace["recommendation"] {
  const margin = Math.abs(calibratedProbability - 50);
  const rules: Array<{ rule: string; matched: boolean; decided: boolean }> = [];

  const r1 = dataQualityLabel === "Poor" || dataQuality < 25;
  rules.push({ rule: `DQ < 25 or label "Poor" → INSUFFICIENT_EDGE (DQ=${dataQuality}, label="${dataQualityLabel}")`, matched: r1, decided: r1 });
  if (r1) return { result, margin, rulesChecked: rules };

  const r1b = tieBreakerApplied;
  rules.push({ rule: `tieBreakerApplied → INSUFFICIENT_EDGE (raw ensemble within TIE_BAND of 50, no validated directional edge)`, matched: r1b, decided: r1b });
  if (r1b) return { result, margin, rulesChecked: rules };

  const r2 = margin < 8 && (modelAgreement === "Mixed" || modelAgreement === "HighDisagreement");
  rules.push({ rule: `margin < 8 AND (Mixed|HighDisagreement) → INSUFFICIENT_EDGE (margin=${margin.toFixed(1)}, agreement="${modelAgreement}")`, matched: r2, decided: r2 });
  if (r2) return { result, margin, rulesChecked: rules };

  // DQ gate removed 2026-08-08 (Ticket 3): Limited DQ outperforms Excellent DQ on held-out data.
  const r3 = margin >= 35 && modelAgreement === "Strong" && coreSignalsAlign;
  rules.push({ rule: `margin ≥ 35 AND Strong AND coreSignalsAlign → HIGHEST_CONFIDENCE (margin=${margin.toFixed(1)}, coreSignalsAlign=${coreSignalsAlign}) [DQ gate removed — DQ=${dataQuality} logged only]`, matched: r3, decided: r3 });
  if (r3) return { result, margin, rulesChecked: rules };

  const r4 = margin >= 26 && modelAgreement === "Strong" && coreSignalsAlign;
  rules.push({ rule: `margin ≥ 26 AND Strong AND coreSignalsAlign → HIGHEST_CONFIDENCE (margin=${margin.toFixed(1)}, agreement="${modelAgreement}") [DQ gate removed — DQ=${dataQuality} logged only]`, matched: r4, decided: r4 });
  if (r4) return { result, margin, rulesChecked: rules };

  const r5 = margin >= 20 && modelAgreement === "Strong";
  rules.push({ rule: `margin ≥ 20 AND Strong → HIGH_CONFIDENCE (margin=${margin.toFixed(1)}, agreement="${modelAgreement}")`, matched: r5, decided: r5 });
  if (r5) return { result, margin, rulesChecked: rules };

  const r6 = margin >= 12 && (modelAgreement === "Strong" || modelAgreement === "Moderate");
  rules.push({ rule: `margin ≥ 12 AND (Strong|Moderate) → HIGH_CONFIDENCE (margin=${margin.toFixed(1)}, agreement="${modelAgreement}")`, matched: r6, decided: r6 });
  if (r6) return { result, margin, rulesChecked: rules };

  const r7 = margin >= 9 && modelAgreement === "Strong";
  rules.push({ rule: `margin ≥ 9 AND Strong → HIGH_CONFIDENCE (margin=${margin.toFixed(1)}, agreement="${modelAgreement}")`, matched: r7, decided: r7 });
  if (r7) return { result, margin, rulesChecked: rules };

  const r8 = margin >= 40 && modelAgreement !== "Mixed" && modelAgreement !== "HighDisagreement";
  rules.push({ rule: `margin ≥ 40 AND not Mixed/HighDisagreement → HIGH_CONFIDENCE (high-confidence guardrail, margin=${margin.toFixed(1)})`, matched: r8, decided: r8 });
  if (r8) return { result, margin, rulesChecked: rules };

  const r9 = margin >= 9 && modelAgreement === "Moderate";
  rules.push({ rule: `margin ≥ 9 AND Moderate → MODERATE_CONFIDENCE (margin=${margin.toFixed(1)})`, matched: r9, decided: r9 });
  if (r9) return { result, margin, rulesChecked: rules };

  const r10 = margin >= 12;
  rules.push({ rule: `margin ≥ 12 (Mixed|HighDisagreement with real margin) → MODERATE_CONFIDENCE (margin=${margin.toFixed(1)})`, matched: r10, decided: r10 });
  if (r10) return { result, margin, rulesChecked: rules };

  rules.push({ rule: `fallthrough → LOW_CONFIDENCE`, matched: true, decided: true });
  return { result, margin, rulesChecked: rules };
}

/**
 * Discloses exactly what availability data is real vs. missing for THIS match, rather than a
 * flat "not connected" disclaimer -- rest days and recent retirement come straight from verified
 * match records; travel distance depends on venue coverage; pre-match withdrawal (before either
 * player has struck a ball) has no verified feed connected at all (RAPIDAPI_KEY/API_SPORTS_KEY
 * checked live on 2026-07-11 -- neither resolves to a subscribed, working tennis data source) and
 * that gap is always named explicitly.
 */
function buildAvailabilityNote(availability: ReturnType<typeof computeAvailabilityModule>): string {
  const parts: string[] = [];

  const rest: string[] = [];
  if (availability.player1.daysSinceLastMatch !== null) rest.push(`P1 rested ${availability.player1.daysSinceLastMatch}d`);
  if (availability.player2.daysSinceLastMatch !== null) rest.push(`P2 rested ${availability.player2.daysSinceLastMatch}d`);
  if (rest.length > 0) parts.push(`Real rest days since last match: ${rest.join(", ")}.`);

  const travel: string[] = [];
  if (availability.player1.travelDistanceKm !== null) travel.push(`P1 traveled ~${availability.player1.travelDistanceKm}km since their last match`);
  if (availability.player2.travelDistanceKm !== null) travel.push(`P2 traveled ~${availability.player2.travelDistanceKm}km since their last match`);
  parts.push(travel.length > 0 ? `${travel.join(", ")}.` : "Travel distance unavailable for this match (venue coverage is limited to recognized tournaments).");

  if (availability.player1.recentRetirementOrWithdrawal) {
    parts.push(`P1 retired mid-match at ${availability.player1.recentRetirementTournament ?? "a recent tournament"} within the last 3 weeks -- a real recorded fact worth weighing, not a confirmed current injury.`);
  }
  if (availability.player2.recentRetirementOrWithdrawal) {
    parts.push(`P2 retired mid-match at ${availability.player2.recentRetirementTournament ?? "a recent tournament"} within the last 3 weeks -- a real recorded fact worth weighing, not a confirmed current injury.`);
  }

  parts.push(
    "No verified pre-match withdrawal/injury-status feed is connected -- this prediction cannot see an injury that hasn't yet caused a retirement or walkover in the match record.",
  );

  return parts.join(" ");
}

// LIVE BUG FIXED 2026-07-13 (found by the invariant-checking batch script + a user's direct
// challenge to "confirm this can't happen today"): `winnerSets`/`loserSets` here are already the
// PREDICTED WINNER's own set count and the loser's, in that fixed abstract sense -- they were
// never player1's or player2's number specifically. The old code nonetheless branched on
// `favorsPlayer1` and swapped which literal went first (`loserSets-winnerSets` when player 2 was
// the pick), which actually just re-encoded "player1's count first, player2's count second" --
// NOT "winner's count first" as the variable names and every caller (this function is always
// displayed directly under "PREDICTED WINNER" with no player labels, see PredictionResult.tsx)
// assumed. So any prediction favoring player 2 rendered a set score that looked like the winner
// lost (e.g. "0-2" next to the winner's own name). `favorsPlayer1` is intentionally unused now --
// the winner's own set count must always be shown first, independent of which player it is.
export function predictSetScore(matchFormat: "BestOf3" | "BestOf5", calibratedProbability: number): string {
  const margin = Math.abs(calibratedProbability - 50);
  const setsToWin = matchFormat === "BestOf5" ? 3 : 2;
  const decisive = margin >= 20;
  const winnerSets = setsToWin;
  const loserSets = decisive ? Math.max(0, setsToWin - 2) : setsToWin - 1;
  return `${winnerSets}-${loserSets}`;
}

export function runPredictionEngine(input: PredictionEngineInput): EngineOutput {
  const player1OpponentElo = input.player1OpponentElo ?? new Map();
  const player2OpponentElo = input.player2OpponentElo ?? new Map();

  const surfaceElo = computeSurfaceEloModule(
    input.player1Matches,
    input.player2Matches,
    input.surface,
    player1OpponentElo,
    player2OpponentElo,
    // Task #77: fallback-tracker attribution ids are only ever passed for run-scoped callers that
    // opt in via `trackEloFallback` (walk-forward/rebuild) -- never for live per-fixture traffic,
    // which has no run boundary to `reset()` the tracker and would otherwise grow it unbounded.
    input.trackEloFallback ? input.player1.id : undefined,
    input.trackEloFallback ? input.player2.id : undefined,
  );
  const serveReturn = computeServeReturnModule(input.player1Matches, input.player2Matches, input.surface, player1OpponentElo, player2OpponentElo);
  const recentForm = computeRecentFormModule(input.player1Matches, input.player2Matches, input.surface, player1OpponentElo, player2OpponentElo);
  const fatigue = computeFatigueModule(input.player1Matches, input.player2Matches, input.asOfDate);
  const matchLoadRecovery = computeMatchLoadRecoveryModule(input.player1Matches, input.player2Matches, input.asOfDate);
  const availability = computeAvailabilityModule(input.player1Matches, input.player2Matches, input.tournamentName ?? null, new Date(), input.webResearch ?? null);
  const styleMatchup = computeStyleMatchupModule(input.player1Matches, input.player2Matches);
  const headToHead = computeHeadToHeadModule(input.headToHead, input.surface);

  const excludedModels = input.excludedModels ?? null;

  // Conditional Form weight gate (docs/module-audit-recent-form-snr.md, 2026-07-18):
  // When Recent Form fires at >3pp edge in the OPPOSITE direction from Surface Elo (which has
  // its own >2pp edge), the ensemble historically follows Form 73% of the time and achieves
  // only 45.4% accuracy — below a coin flip. Following Elo instead in those cases achieves
  // 56.7%. This gate reduces Form's weight to near-zero in that specific anti-pattern while
  // leaving it unchanged everywhere else (Form is a +6pp confirmation signal when it agrees
  // with Elo). The 163 affected predictions per test corpus are a small but clean gain.
  const rawFormEdge = (recentForm.player1Form - recentForm.player2Form) / 2;
  const rawEloEdge = surfaceElo.eloDifference / 8;
  const formProbEdge = Math.abs(edgeToProbability(rawFormEdge) - 50);
  const eloProbEdge = Math.abs(edgeToProbability(rawEloEdge) - 50);
  const formEloConflict =
    formProbEdge > 3 &&
    eloProbEdge > 2 &&
    Math.sign(rawFormEdge) !== Math.sign(rawEloEdge);
  const formWeightPrior = formEloConflict ? 0.1 : ENSEMBLE_WEIGHT_PRIOR.recentForm;

  const moduleEdges = [
    {
      key: "surfaceElo" as const,
      name: "Surface Elo",
      player1Edge: rawEloEdge,
      reliability: surfaceElo.reliability,
      importance: MODULE_IMPORTANCE.surfaceElo,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.surfaceElo,
    },
    {
      key: "serveReturn" as const,
      name: "Serve & Return",
      player1Edge: serveReturn.player1ServeRating + serveReturn.player1ReturnRating - serveReturn.player2ServeRating - serveReturn.player2ReturnRating,
      reliability: serveReturn.reliability,
      importance: MODULE_IMPORTANCE.serveReturn,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.serveReturn,
      confidenceShrink: CONFIDENCE_SHRINK.serveReturn,
    },
    {
      key: "recentForm" as const,
      name: "Recent Form",
      player1Edge: rawFormEdge,
      reliability: recentForm.reliability,
      importance: MODULE_IMPORTANCE.recentForm,
      weightPrior: formWeightPrior,
      confidenceShrink: CONFIDENCE_SHRINK.recentForm,
    },
    {
      key: "fatigue" as const,
      name: "Fatigue",
      player1Edge: (fatigue.player2FatigueScore - fatigue.player1FatigueScore) / 2,
      reliability: fatigue.reliability,
      importance: MODULE_IMPORTANCE.fatigue,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.fatigue,
    },
    {
      key: "availability" as const,
      name: "Availability",
      player1Edge: (availability.player1AvailabilityScore - availability.player2AvailabilityScore) / 2,
      reliability: availability.reliability,
      importance: MODULE_IMPORTANCE.availability,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.availability,
    },
    {
      key: "headToHead" as const,
      name: "Head-to-Head",
      player1Edge: headToHead.player1Wins + headToHead.player2Wins > 0
        ? ((headToHead.player1Wins - headToHead.player2Wins) / (headToHead.player1Wins + headToHead.player2Wins)) * 25 + headToHead.weightedEdge * 15
        : 0,
      reliability: headToHead.reliability,
      importance: MODULE_IMPORTANCE.headToHead,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.headToHead,
    },
    {
      key: "matchLoadRecovery" as const,
      name: "Match Load Recovery",
      // Higher recoveryRiskScore = more likely to LOSE (validated Candidate B, went-distance-only
      // -- see docs/audit-fatigue-redesign-investigation.md), so the edge points toward whichever
      // player has the LOWER risk score, mirroring fatigue's own (player2 - player1) orientation.
      player1Edge: (matchLoadRecovery.player2RecoveryRiskScore - matchLoadRecovery.player1RecoveryRiskScore) / 2,
      reliability: matchLoadRecovery.reliability,
      importance: MODULE_IMPORTANCE.matchLoadRecovery,
      weightPrior: ENSEMBLE_WEIGHT_PRIOR.matchLoadRecovery,
    },
  ];

  // Market Consensus module — computed separately from the historical feature modules.
  //
  // The market module is NOT pushed into `moduleEdges` (whose element type is a closed literal
  // union over historical feature keys) because:
  //   (a) TypeScript infers the union from the array literal and would reject "marketOdds";
  //   (b) the market module is architecturally distinct — it is a live external signal, not a
  //       historical data feature, and is always excluded from the Data Quality blend.
  //
  // When absent (no odds configured, provider down, matchup not listed, or ablation override),
  // marketConsensusInput is null and the ensemble is identical to predictions without odds.
  // Absence does NOT synthesize a 50/50 neutral vote (that adds meaningless noise).
  //
  // Orientation: player1DecimalOdds / player2DecimalOdds are player-1-relative (same convention
  // as every other engine input), so normP1 maps directly to player1Edge without name-matching.
  //
  // Task #21 (2026-07-31): excluded from the ensemble pending the ≥200 paper_trade paired-row
  // reliability bar. The 2026-07-31 ablation run produced n=180 paper_trade pairs (just short of
  // the required 200). Directional signals are promising — Δacc +0.5pp, Δlog-loss −0.014, market
  // correct 69.6% when it disagrees with the model — but the sample is too small to declare a
  // confirmed net positive. "marketOdds" is in EXCLUDED_FROM_ENSEMBLE until re-validated at ≥200.
  // See docs/audit-market-consensus-ablation.md and scripts/auditMarketConsensusAblation.ts.
  let marketConsensusInput: { name: string; player1Edge: number; reliability: number; weightPrior: number } | null = null;
  // Task #21: honor the global EXCLUDED_FROM_ENSEMBLE gate for "marketOdds" whenever no explicit
  // per-call ablation set is provided (i.e. every live, paper-trade, and non-ablation call). An
  // explicitly-provided `excludedModels` (even an empty Set) signals ablation mode — the caller
  // takes responsibility for which modules are active, so the global gate is bypassed for that
  // call only. This lets the dedicated market-odds ablation script test both "with odds" and
  // "without odds" arms independently via `excludedModels`, while standard live calls always
  // respect the global exclusion.
  const marketGloballyExcluded = excludedModels == null && EXCLUDED_FROM_ENSEMBLE.has("marketOdds");
  if (
    input.marketOdds != null &&
    !marketGloballyExcluded &&
    !excludedModels?.has("marketOdds") &&
    input.marketOdds.player1DecimalOdds > 1 &&
    input.marketOdds.player2DecimalOdds > 1
  ) {
    const rawP1 = 1 / input.marketOdds.player1DecimalOdds;
    const rawP2 = 1 / input.marketOdds.player2DecimalOdds;
    const totalImplied = rawP1 + rawP2;
    // Vig-normalize: remove the bookmaker's over-round so the two sides sum to 1.
    const normP1 = totalImplied > 0 ? rawP1 / totalImplied : 0.5;
    // Inverse of edgeToProbability(edge) = 1 / (1 + exp(-edge/12)) * 100.
    // Solved: edge = 12 * ln(normP1 / (1 - normP1)), with normP1 in [0, 1].
    const marketEdge = normP1 > 0 && normP1 < 1 ? 12 * Math.log(normP1 / (1 - normP1)) : 0;
    marketConsensusInput = {
      name: "Market Consensus",
      player1Edge: marketEdge,
      reliability: 80,
      weightPrior: 0.5, // modest supplemental vote; below the three core signal modules
    };
  }

  // Task #111 root-cause fix: the Data Quality blend must draw from every module NOT in
  // `EXCLUDED_FROM_DATA_QUALITY` (currently just Head-to-Head), independent of which modules are
  // excluded from the ensemble VOTE. Before this fix, `moduleEdges` below was pre-filtered by
  // `EXCLUDED_FROM_ENSEMBLE` for the ensemble build, and the Data Quality blend was reading from
  // that SAME already-filtered array -- so Availability/Fatigue/Match Load Recovery silently
  // never reached `computeDataQuality` at all, despite `MODULE_IMPORTANCE` documenting real
  // weights (0.9/0.7/0.4) and rationale for including them. A 4,111-row walk-forward audit
  // (docs/audit-task111-dq-degradation-above-55.md) traced the calibration reversal above DQ~55
  // directly to this: with only Surface Elo/Serve & Return/Recent Form actually contributing (all
  // three saturate once both players are well-logged tour regulars), DQ had nothing to dampen its
  // score for exactly the matchups where extensive history correlates with deeper, more
  // competitive -- and so structurally harder-to-call -- draws. Restoring the documented modules
  // shrank the worst-miscalibrated (DQ 85-100) segment from n=422 to n=96 in that audit. Excluded
  // models from an ablation run (`excludedModels`) are still honored here -- an ablation run that
  // turns a module off should not silently keep counting toward Data Quality either.
  const allModuleEdgesForDataQuality = moduleEdges.filter((m) => !excludedModels?.has(m.key) && !EXCLUDED_FROM_DATA_QUALITY.has(m.key));

  const ensembleModuleEdges = [
    ...moduleEdges.filter((m) => !excludedModels?.has(m.key) && !EXCLUDED_FROM_ENSEMBLE.has(m.key)),
    // Market Consensus is excluded from EXCLUDED_FROM_DATA_QUALITY but NOT from the ensemble vote —
    // add it here (after the feature-module filter) only when real odds are present.
    ...(marketConsensusInput ? [marketConsensusInput] : []),
  ];
  const { models: featureModels, ensembleProbability: rawEnsembleProbability, modelAgreement: featureAgreement } = buildEnsemble(ensembleModuleEdges);
  // Recomputed (pure, deterministic) so we keep the full weighted-disagreement breakdown --
  // stddev/support/conflicting models -- for the disagreement explanation below, not just the
  // category buildEnsemble already returned.
  let governingDisagreement = computeWeightedDisagreement(featureModels);

  // Requirement 6/7 of the fix-the-engine spec: when the core signals are genuinely close to a
  // coin flip, use an explicit priority cascade instead of just accepting an uninformative ~50/50
  // average -- always surface a real (if modest) lean when evidence supports one, never inflate
  // beyond a small fixed nudge, and only stay at exactly 50/50 when every tie-break step is also
  // silent (a genuine coin-flip matchup).
  const defaultedInputs = [
    surfaceElo.defaulted ? "Surface Elo" : null,
    serveReturn.defaulted ? "Serve & Return" : null,
    recentForm.defaulted ? "Recent Form" : null,
    headToHead.defaulted ? "Head-to-Head" : null,
  ].filter((value): value is string => value !== null);

  const tieBreaker = applyTieBreaker(rawEnsembleProbability, {
    surfaceElo,
    serveReturn,
    recentForm,
    fatigue,
    headToHead,
    player1: input.player1,
    player2: input.player2,
    player1Matches: input.player1Matches,
    player2Matches: input.player2Matches,
    surface: input.surface,
    defaultedInputs,
  });
  const ensembleProbability = tieBreaker.applied ? tieBreaker.adjustedProbability : rawEnsembleProbability;

  // Availability/Fatigue/Match Load Recovery are excluded from the ensemble VOTE (see
  // `EXCLUDED_FROM_ENSEMBLE`'s rationale -- each failed its own leave-one-out/ablation bar for
  // voting accuracy) but, per Task #111, DO still count toward the Data Quality blend via
  // `allModuleEdgesForDataQuality` above, matching `MODULE_IMPORTANCE`'s documented weights/
  // rationale for them. Head-to-Head remains excluded from the Data Quality blend specifically
  // (it still votes in the ensemble above) -- see `EXCLUDED_FROM_DATA_QUALITY`'s rationale: the
  // common "no prior meetings" case isn't a fixable data gap, so it shouldn't be able to drag the
  // score down.
  // Detect zero-history players before the DQ blend -- needed both for the structural-gap
  // floor below and for the warning-grouping pass later.
  const p1ZeroHistory = input.player1Matches.length === 0;
  const p2ZeroHistory = input.player2Matches.length === 0;

  // Structural gap floor: when a player has zero recorded match history, surfaceElo, recentForm,
  // and serveReturn all collapse to their individual reliability floors (~0-10) for the SAME root
  // cause, compounding into a catastrophic DQ score (e.g. 24%) even when the opponent is
  // well-documented and the engine still has a valid opinion from rankings/tour context. Cap the
  // combined drag by flooring each of those three modules at ZERO_HISTORY_MODULE_FLOOR so one
  // structural data gap doesn't count five times in the weighted blend.
  const ZERO_HISTORY_MODULE_FLOOR = 40;
  const { score: dataQuality, label: dataQualityLabel } = computeDataQuality(
    allModuleEdgesForDataQuality.map((m) => {
      let reliability = m.reliability;
      if (
        (p1ZeroHistory || p2ZeroHistory) &&
        (m.key === "surfaceElo" || m.key === "recentForm" || m.key === "serveReturn")
      ) {
        reliability = Math.max(reliability, ZERO_HISTORY_MODULE_FLOOR);
      }
      return { reliability, importance: m.importance };
    }),
  );

  // Requirement 2 of this phase: expose the surface sample-depth count that `surfaceElo.ts`
  // already tracks internally, so a low-sample surface matchup is visibly flagged rather than
  // silently blended into a single probability number.
  const surfaceSampleDepth = computeSurfaceSampleDepth(surfaceElo.sampleSizePlayer1, surfaceElo.sampleSizePlayer2);

  // Phase 7: point-by-point Monte Carlo simulation, always computed for display/transparency.
  // Seeded deterministically from match identity (see simulator.ts) so re-predicting the exact
  // same match (quick-start, custom match, or a plain re-run) always simulates the same outcome
  // instead of drifting between calls -- this is what let same-match duplicates disagree on
  // predicted winner and slip past the ledger's duplicate detector.
  const servicePointEstimate = deriveServicePointEstimate(surfaceElo, serveReturn);
  const simulatorSeed = deriveMatchSeed(input.player1.id, input.player2.id, input.surface, input.matchFormat);
  const simulation = runMatchSimulation(servicePointEstimate, input.matchFormat, { seed: simulatorSeed });

  // Prefer the real, Phase-4-fitted isotonic calibration (learned from actual walk-forward
  // validation outcomes) whenever one exists. Only fall back to the hand-tuned dataQuality-shrink
  // heuristic before any evaluation run has ever produced a fitted model -- that heuristic is a
  // documented stand-in, not the validated calibration this engine should prefer.
  // Ablation-only: "generalEnsemble" removed means skip the calibration transform entirely and
  // use the raw, reliability-weighted ensemble probability as the blend base below -- there is no
  // other honest stand-in for "the general model didn't vote".
  const generalEnsembleExcluded = !!excludedModels?.has("generalEnsemble");
  const generalProbability = generalEnsembleExcluded
    ? ensembleProbability
    : input.activeCalibration && input.activeCalibration.length > 0
      ? Math.round(applyCalibration(input.activeCalibration, ensembleProbability / 100) * 1000) / 10
      : calibrateProbability(ensembleProbability, dataQuality);

  // Phase 6: blend in a tour/surface segment specialist -- literally the same ensemble
  // probability run through a SEGMENT-ONLY isotonic calibration instead of the pooled one -- when
  // (and only when) that segment has cleared its own data-sufficiency thresholds. Everything else
  // falls back to the general model alone, with a visible reason why (never silently).
  // Ablation-only: "segmentSpecialist" removed forces the specialist off regardless of `segment`.
  const segment = excludedModels?.has("segmentSpecialist") ? null : (input.segment ?? null);
  const specialistApplied = !!(segment?.meetsThreshold && segment.calibrationMapping && segment.calibrationMapping.length > 0 && typeof segment.weight === "number");

  let specialistProbability: number | null = null;
  let specialistWeight = 0;
  if (specialistApplied && segment) {
    specialistProbability = Math.round(applyCalibration(segment.calibrationMapping!, ensembleProbability / 100) * 1000) / 10;
    specialistWeight = segment.weight!;
  }

  const blendedProbability = specialistApplied && specialistProbability !== null
    ? Math.round((specialistWeight * specialistProbability + (1 - specialistWeight) * generalProbability) * 10) / 10
    : generalProbability;

  // Task #151: neither discount below applies once a real segment specialist has actually voted
  // (`specialistApplied`) -- that's already a genuine, data-fit correction for this exact
  // tour/surface, so a coarse fallback discount on top of it would double-correct. Only kicks in
  // for the segments the 2026-07-13 ablation report flagged as genuinely underperforming their
  // stated confidence with no specialist available to fix it directly yet -- see
  // `TOUR_RELIABILITY_DISCOUNT`/`LOW_SURFACE_SAMPLE_DISCOUNT` in `dataQuality.ts` for the exact
  // evidence and sizing. Multiplicative when both apply (e.g. an ATP match that's also thin on
  // this surface) rather than additive, so the combined shrink never overshoots past either
  // factor alone.
  //
  // Task #33: the tour-reliability discount (e.g. ATP ×0.63) was sized BEFORE the pooled isotonic
  // calibration existed. The calibration is trained on raw_probability → actual_outcome across the
  // full corpus (all tours) and already bakes in tour-level accuracy differences through its knots.
  // Applying the tour discount ON TOP of a real fitted calibration is a double-correction:
  // calibration maps raw→actual (correctly), then the discount pulls it back below the true rate.
  // Paper-trade data (n=520 graded) confirms 17-pt underconfidence in the 60-70% tier when the
  // discount fires. When the real calibration is active, skip the tour discount; keep only the
  // surface-sample-depth noise discount (which guards against per-match data sparsity, not
  // systematic accuracy bias, and is not captured by pooled calibration knots).
  const usingRealCalibration = !generalEnsembleExcluded && (input.activeCalibration?.length ?? 0) > 0;
  const segmentTour = segment?.segmentKey.split("-")[0] ?? null;
  const tourDiscount = !specialistApplied && !usingRealCalibration && segmentTour ? TOUR_RELIABILITY_DISCOUNT[segmentTour] ?? 1 : 1;
  // Task #33: also skip the surface-sample noise discount when real isotonic calibration is active —
  // the pooled calibration knots are fitted on raw_probability → actual_outcome across the full
  // corpus and already account for per-match data sparsity at scale. Applying the ×0.75 shrink on
  // top double-corrects and contributes to systematic underconfidence in low-sample-surface matches.
  const surfaceSampleDiscount = !specialistApplied && !usingRealCalibration && surfaceSampleDepth.label === "Low" ? LOW_SURFACE_SAMPLE_DISCOUNT : 1;
  const reliabilityDiscount = Math.round(tourDiscount * surfaceSampleDiscount * 1000) / 1000;
  const preSimulatorProbability = reliabilityDiscount < 1
    ? Math.round((50 + (blendedProbability - 50) * reliabilityDiscount) * 10) / 10
    : blendedProbability;

  // Phase 7: only blend the simulator's own vote into the final probability once it has been
  // validated (against real historical/live outcomes) to actually earn one -- see
  // services/evaluation/simulatorValidation.ts. Until then it stays supplementary/display-only,
  // with an honest note explaining exactly why.
  const simulatorAdoption = input.simulatorAdoption ?? null;
  const simulatorAdoptedGlobally = !!(simulatorAdoption?.adopted && typeof simulatorAdoption.weight === "number");

  // Task #61: the simulator's blend weight above is validated purely on AVERAGE logLoss across
  // every graded match -- it says nothing about matches where its two visible signals (Surface
  // Elo, Serve & Return) are much less reliable than the signals it structurally cannot see
  // (Recent Form, Fatigue, Availability, Head-to-Head, Match Load Recovery, the Segment
  // Specialist/General Model blend). See ../evaluation/SIMULATOR_VS_ENSEMBLE_DISAGREEMENT.md for
  // two reproduced real cases where that scope mismatch alone swings the simulator's number up to
  // 40 points away from -- even to the opposite side of -- the card's final probability. A
  // simulator that is valid on average must not still get outsized influence on the specific
  // matches where it is blind to whatever is actually deciding the ensemble's vote, so its
  // per-match weight is scaled down (never up) by how far its own reliability trails the most
  // reliable signal it can't see.
  const excludedSignalReliabilities = featureModels
    .filter((m) => m.modelName !== "Surface Elo" && m.modelName !== "Serve & Return")
    .map((m) => m.reliability);
  const specialistReliability = specialistApplied && segment
    ? Math.min(100, Math.round((segment.validationSampleSize / segment.minValidationSamples) * 50))
    : null;
  if (specialistReliability !== null) excludedSignalReliabilities.push(specialistReliability);
  excludedSignalReliabilities.push(dataQuality); // the General Model's own reliability -- also outside the simulator's scope
  const maxExcludedSignalReliability = excludedSignalReliabilities.length > 0 ? Math.max(...excludedSignalReliabilities) : 0;
  // Positive only when a signal the simulator can't see is measurably MORE reliable than the
  // simulator's own two-signal reliability floor -- a genuine scope mismatch, not routine noise.
  const simulatorScopeGap = Math.max(0, maxExcludedSignalReliability - simulation.inputReliability);
  // Linear falloff over a 0-100 reliability-point gap: no gap (or the simulator's own signals are
  // at least as reliable as everything it can't see) leaves the globally-validated weight
  // untouched; a full 100-point gap zeros the simulator's vote out entirely for this match.
  const simulatorScopeScale = Math.max(0, 1 - simulatorScopeGap / 100);

  const simulatorWeight = simulatorAdoptedGlobally ? Math.round(simulatorAdoption!.weight! * simulatorScopeScale * 1000) / 1000 : 0;
  const simulatorApplied = simulatorWeight > 0;

  const calibratedProbabilityRaw = simulatorApplied
    ? Math.round((simulatorWeight * simulation.player1WinProbability + (1 - simulatorWeight) * preSimulatorProbability) * 10) / 10
    : preSimulatorProbability;
  // Hard gate: the engine can never claim 0 % or 100 % certainty.
  // Bounds are [0.6, 99.4] so that the downstream toFixed(0) display (used for the
  // "WIN PROBABILITY" headline) rounds to at most "99%" in both directions:
  //   player1 wins → calibratedProbability → toFixed(0) ≤ 99
  //   player2 wins → 100 - calibratedProbability ≤ 99.4 → toFixed(0) ≤ 99
  // This also guards the path where simulatorApplied=false and preSimulatorProbability
  // is extreme, which the simulator's own safeRate clamp cannot reach.
  const calibratedProbability = Math.max(0.6, Math.min(99.4, calibratedProbabilityRaw));

  const models: ModelVote[] = [...featureModels];
  models.push({
    modelName: "General Model",
    player1Probability: generalProbability,
    weightUsed: specialistApplied ? Math.round((1 - specialistWeight) * 1000) / 1000 : 1,
    reliability: dataQuality,
  });
  let modelAgreement = featureAgreement;
  if (specialistApplied && specialistProbability !== null && segment) {
    models.push({
      modelName: `Segment Specialist (${segment.label})`,
      player1Probability: specialistProbability,
      weightUsed: Math.round(specialistWeight * 1000) / 1000,
      // Reliability scales with the validation sample the specialist was actually measured on,
      // capped at 100 -- a specialist barely over threshold is voted on, but not trusted blindly.
      reliability: Math.min(100, Math.round((segment.validationSampleSize / segment.minValidationSamples) * 50)),
    });
    // Weighted the same way as the level-1 feature vote (see disagreement.ts) using the actual
    // general/specialist blend weights as effective weight, instead of a flat two-way spread.
    const generalVsSpecialistDisagreement = computeWeightedDisagreement([
      { modelName: "General Model", player1Probability: generalProbability, weightUsed: 1 - specialistWeight },
      { modelName: `Segment Specialist (${segment.label})`, player1Probability: specialistProbability, weightUsed: specialistWeight },
    ]);
    if (AGREEMENT_ORDER.indexOf(generalVsSpecialistDisagreement.modelAgreement) > AGREEMENT_ORDER.indexOf(governingDisagreement.modelAgreement)) {
      governingDisagreement = generalVsSpecialistDisagreement;
    }
    modelAgreement = worseAgreement(featureAgreement, generalVsSpecialistDisagreement.modelAgreement);
  }

  if (simulatorApplied) {
    models.push({
      modelName: "Monte Carlo Simulator",
      player1Probability: simulation.player1WinProbability,
      weightUsed: Math.round(simulatorWeight * 1000) / 1000,
      reliability: simulation.inputReliability,
    });
    const preSimulatorVsSimulatorDisagreement = computeWeightedDisagreement([
      { modelName: "Pre-Simulator Blend", player1Probability: preSimulatorProbability, weightUsed: 1 - simulatorWeight },
      { modelName: "Monte Carlo Simulator", player1Probability: simulation.player1WinProbability, weightUsed: simulatorWeight },
    ]);
    if (AGREEMENT_ORDER.indexOf(preSimulatorVsSimulatorDisagreement.modelAgreement) > AGREEMENT_ORDER.indexOf(governingDisagreement.modelAgreement)) {
      governingDisagreement = preSimulatorVsSimulatorDisagreement;
    }
    modelAgreement = worseAgreement(modelAgreement, preSimulatorVsSimulatorDisagreement.modelAgreement);
  }

  const disagreementNote = buildDisagreementNote(governingDisagreement, input.player1.name, input.player2.name);
  const matchupCloseness = computeMatchupCloseness(calibratedProbability);

  let simulatorNote: string;
  if (!simulatorAdoption) {
    simulatorNote = `The Monte Carlo simulator has not been validated against enough real graded outcomes yet (needs a minimum sample; see the evaluation dashboard) -- shown for transparency only and not yet voted into the final probability.`;
  } else if (!simulatorAdoptedGlobally) {
    simulatorNote = simulatorAdoption.note;
  } else if (!simulatorApplied) {
    simulatorNote = `${simulatorAdoption.note} For this specific match, though, its vote was scoped out entirely: its own reliability (${simulation.inputReliability}) is far below the reliability of a signal it structurally can't see (up to ${maxExcludedSignalReliability}), so it is blind to whatever is actually deciding this match's ensemble vote (see SIMULATOR_VS_ENSEMBLE_DISAGREEMENT.md).`;
  } else if (simulatorScopeScale < 1) {
    simulatorNote = `${simulatorAdoption.note} Its blend weight was reduced from ${Math.round(simulatorAdoption.weight! * 100)}% to ${Math.round(simulatorWeight * 100)}% for this specific match because a signal it can't see is considerably more reliable here (see SIMULATOR_VS_ENSEMBLE_DISAGREEMENT.md).`;
  } else {
    simulatorNote = simulatorAdoption.note;
  }

  let segmentNote: string;
  if (!segment) {
    segmentNote = "This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only.";
  } else if (specialistApplied) {
    segmentNote = `Segment specialist for ${segment.label} applied (blend weight ${Math.round(specialistWeight * 100)}%), measured on ${segment.validationSampleSize} validation-segment predictions across ${segment.historicalMatchCount} real historical ${segment.label} matches.`;
  } else {
    segmentNote = `No segment specialist for ${segment.label} yet -- only ${segment.historicalMatchCount} historical match(es) and ${segment.validationSampleSize} validation prediction(s) recorded so far (needs at least ${segment.minHistoricalMatches} matches and ${segment.minValidationSamples} validation predictions). Using the general model only.`;
  }

  // Model Conflict: compare the final pick against the raw, reliability-weighted vote of the
  // underlying evidence modules alone (ensembleProbability, before any calibration/specialist/
  // simulator blending). If calibration flips which side of 50% the pick lands on, that's a real,
  // disclosable event -- never silently absorbed into a single probability number.
  const rawFavorsPlayer1 = ensembleProbability >= 50;
  const finalFavorsPlayer1 = calibratedProbability >= 50;
  const modelConflict = rawFavorsPlayer1 !== finalFavorsPlayer1;

  let modelConflictNote: string | null = null;
  if (modelConflict) {
    const metricVotes = featureModels
      .map((m) => `${m.modelName} \u2192 ${m.player1Probability >= 50 ? input.player1.name : input.player2.name} (${m.player1Probability.toFixed(0)}%, weight ${m.weightUsed.toFixed(2)})`)
      .join("; ");

    let flipStage = "an unidentified stage";
    if ((generalProbability >= 50) !== rawFavorsPlayer1) {
      flipStage = "the fitted probability calibration (isotonic mapping learned from real graded outcomes)";
    } else if (specialistApplied && (preSimulatorProbability >= 50) !== (generalProbability >= 50)) {
      flipStage = `the ${segment?.label ?? "segment"} specialist blend`;
    } else if (simulatorApplied && (calibratedProbability >= 50) !== (preSimulatorProbability >= 50)) {
      flipStage = "the Monte Carlo simulator blend";
    }

    modelConflictNote = `The raw, reliability-weighted evidence (${metricVotes}) favored ${rawFavorsPlayer1 ? input.player1.name : input.player2.name}, but ${flipStage} shifted the final pick to ${finalFavorsPlayer1 ? input.player1.name : input.player2.name}. This is a real statistical adjustment, not an error -- but treat the edge with extra caution.`;
  }

  // Uncertainty warnings feeding the upset-risk `uncertainty` component -- deliberately excludes:
  // - surfaceElo.warnings (already counted once, in the `sampleDepth` component)
  // - headToHead.warnings (a missing/thin H2H is the common case for most matchups, not a real
  //   outlier signal -- same reasoning `dataQuality.ts`'s exclusion already applies)
  // - availability.warnings (travel distance / venue-lookup gaps -- these track venue-coverage
  //   limits, not a genuine per-match upset signal; 2026-07-13 "stop low-value signals" audit)
  // - styleMatchup.warnings (thin-sample surface-specialist / indoor-outdoor split -- same
  //   reasoning: a coverage gap, not evidence this specific match is more upset-prone)
  // Player-identity warnings (`buildPlayerProfileWarnings`) are appended by callers AFTER this
  // function returns, so they aren't visible here yet -- an honest gap, not a fabricated count.
  const upsetRiskUncertaintyWarnings = [...serveReturn.warnings, ...fatigue.warnings];
  const upsetRiskBreakdown = computeUpsetRisk({
    calibratedProbability,
    disagreement: governingDisagreement,
    rawVsCalibratedConflict: modelConflict,
    uncertaintyWarningCount: upsetRiskUncertaintyWarnings.length,
    minSurfaceSampleSize: Math.min(surfaceElo.sampleSizePlayer1, surfaceElo.sampleSizePlayer2),
    tournamentLevel: input.tournamentLevel ?? null,
  });
  const upsetRisk = upsetRiskBreakdown.upsetRisk;

  // Compute the three core-signal vote directions here so we can:
  //  1. Derive coreSignalsAlign for computeRecommendation (the same bar Elite tier uses)
  //  2. Reuse the extracted values inside computeEliteTier below (avoids calling
  //     voteFavorsPlayer1 a second time for the same three signals at lines ~838-840)
  //  3. Re-use them again in the decisionTrace eliteTier gates assembly at lines ~1024-1027
  const surfaceEloFavorsP1 = voteFavorsPlayer1(featureModels, "Surface Elo");
  const serveReturnFavorsP1 = voteFavorsPlayer1(featureModels, "Serve & Return");
  const recentFormFavorsP1 = voteFavorsPlayer1(featureModels, "Recent Form");
  const coreSignalsAlign = surfaceEloFavorsP1 === serveReturnFavorsP1 && serveReturnFavorsP1 === recentFormFavorsP1;

  const recommendation = computeRecommendation(calibratedProbability, dataQuality, dataQualityLabel, modelAgreement, tieBreaker.applied, coreSignalsAlign, tieBreaker.dataIncomplete);

  const favorsPlayer1 = calibratedProbability >= 50;
  const predictedWinnerId = favorsPlayer1 ? input.player1.id : input.player2.id;
  const predictedWinnerName = favorsPlayer1 ? input.player1.name : input.player2.name;
  // Guardrail (final consistency check): the predicted winner's own probability, mirrored from
  // player 1's when player 2 is the pick. By construction this can never read below 50 next to
  // the player the engine just named the favorite -- see the field doc on EngineOutput.
  // Belt-and-suspenders: cap at 99.4 so toFixed(0) can never produce "100%" regardless of
  // floating-point edge cases upstream (the primary gate is the calibratedProbability clamp above).
  const predictedWinnerProbability = Math.min(99.4,
    Math.round((favorsPlayer1 ? calibratedProbability : 100 - calibratedProbability) * 10) / 10,
  );
  const predictedSetScore = predictSetScore(input.matchFormat, calibratedProbability);

  const reasons: string[] = [];
  const risks: string[] = [];
  const disclosures: string[] = [];

  if (surfaceElo.sampleSizePlayer1 >= 3 && surfaceElo.sampleSizePlayer2 >= 3) {
    reasons.push(
      `Surface Elo favors ${surfaceElo.eloDifference >= 0 ? input.player1.name : input.player2.name} on ${input.surface} (${surfaceElo.player1SurfaceElo} vs ${surfaceElo.player2SurfaceElo}).`,
    );
  } else {
    risks.push(`Limited ${input.surface} match history for one or both players -- surface Elo reliability is low.`);
  }

  if (recentForm.player1Trend === "declining" || recentForm.player2Trend === "declining") {
    risks.push(
      `${recentForm.player1Trend === "declining" ? input.player1.name : input.player2.name} is trending down in recent form.`,
    );
  }

  if (headToHead.player1Wins + headToHead.player2Wins > 0) {
    if (headToHead.player1Wins === headToHead.player2Wins) {
      reasons.push(`Head-to-head is tied ${headToHead.player1Wins}-${headToHead.player2Wins}.`);
    } else {
      const leader = headToHead.player1Wins > headToHead.player2Wins ? input.player1.name : input.player2.name;
      reasons.push(
        `Head-to-head: ${leader} leads ${Math.max(headToHead.player1Wins, headToHead.player2Wins)}-${Math.min(headToHead.player1Wins, headToHead.player2Wins)}.`,
      );
    }
  }
  // A missing or thin head-to-head record is the NORMAL case for most matchups (first rounds,
  // lower tiers) -- real information worth disclosing, but not evidence this specific match is
  // riskier, so it's a plain disclosure rather than a risk (see `EngineBreakdown.disclosures`).
  disclosures.push(...headToHead.warnings);

  // Task #151: never a silent adjustment -- disclose exactly which reliability discount(s) fired
  // and why, mirroring how every other confidence-affecting stage in this file explains itself.
  if (reliabilityDiscount < 1) {
    const discountReasons: string[] = [];
    if (tourDiscount < 1) discountReasons.push(`${segmentTour} tour predictions have shown a real, validated accuracy gap with no segment specialist yet available to correct for it directly`);
    if (surfaceSampleDiscount < 1) discountReasons.push(`this matchup's surface sample depth is Low (fewer than 5 prior ${input.surface} matches for the thinner-sampled player)`);
    disclosures.push(
      `Confidence was shrunk an additional ${Math.round((1 - reliabilityDiscount) * 100)}% toward a coin flip because ${discountReasons.join(" and ")} (see the Data Quality methodology notes).`,
    );
  }

  if (disagreementNote) {
    risks.push(disagreementNote);
  }

  if (recommendation === "INSUFFICIENT_EDGE") {
    risks.push("Available evidence does not support a reliable directional edge for this matchup — this may be due to thin data, conflicted models, or a probability close to a coin flip.");
  }

  // Auditable upset-risk explanation (2026-07-13 spec, Part 2D) -- named top contributors, never
  // a silent tier label. Shown whenever the tier is above LOW.
  if (upsetRisk !== "LOW") {
    risks.push(upsetRiskBreakdown.note);
  }

  if (modelConflict && modelConflictNote) {
    risks.unshift(`MODEL CONFLICT: ${modelConflictNote}`);
  }

  // Requirement 8 of the fix-the-engine spec: a strictly narrower "Elite Prediction" tier -- see
  // `eliteTier.ts` for the exact gating conditions. Extended by the 2026-07-13 spec's Elite-vs-
  // risk consistency guardrail (Part 2E): Elite additionally requires modelAgreement not to be
  // High Disagreement and upsetRisk not to be High/Extreme.
  const { isEliteTier: eliteTierBeforeGuard, reason: eliteTierReasonBeforeGuard } = computeEliteTier({
    dataQuality,
    calibratedProbability,
    // Reuse the vars extracted earlier for the recommendation computation — avoids calling
    // voteFavorsPlayer1 again for the same three signals.
    surfaceEloFavorsPlayer1: surfaceEloFavorsP1,
    serveReturnFavorsPlayer1: serveReturnFavorsP1,
    recentFormFavorsPlayer1: recentFormFavorsP1,
    specialistApplied,
    segmentLabel: segment?.label ?? null,
    modelConflict,
    modelAgreement,
    upsetRisk,
  });

  // A thin-sample surface-specialist tag is a coverage gap (not enough matches yet to tag a
  // style), not evidence of real risk in this specific match -- disclosed, not risk-styled.
  disclosures.push(...styleMatchup.warnings);

  // Zero-history structural gap: when a player has no recorded matches every signal module
  // independently reports low reliability for the same root cause, producing a wall of
  // identical-root warnings. Detect the root cause once and emit ONE grouped coverageGap note;
  // suppress the individual module bullets that trace to zero match history.
  const isZeroHistoryWarning = (w: string): boolean =>
    w.includes("0 match") || w.includes("no prior match history") || w.includes("blended 100%");

  const coverageGaps: string[] = [];
  if (p1ZeroHistory || p2ZeroHistory) {
    const noHistoryNames = [
      p1ZeroHistory ? input.player1.name : null,
      p2ZeroHistory ? input.player2.name : null,
    ].filter((n): n is string => n !== null);
    const them = noHistoryNames.length === 1 ? "this player" : "these players";
    coverageGaps.push(
      `${noHistoryNames.join(" and ")} ${noHistoryNames.length === 1 ? "has" : "have"} no recorded match history in our database — surface Elo, recent form, serve/return, and travel distance all fall back to global baselines for ${them}.`,
    );
  }

  const warnings = [
    ...surfaceElo.warnings,
    ...serveReturn.warnings,
    ...recentForm.warnings,
    ...fatigue.warnings,
    ...availability.warnings,
  ].filter((w) => !(p1ZeroHistory || p2ZeroHistory) || !isZeroHistoryWarning(w));

  const weather = input.weather ?? null;

  // Task 56: final-consistency guard, run against the pre-guard Elite verdict. Checked BEFORE
  // isEliteTier is fixed for real, so a violation can force it false rather than ship it.
  const { violations: consistencyViolations } = checkFinalConsistency({
    player1Id: input.player1.id,
    player2Id: input.player2.id,
    calibratedProbability,
    predictedWinnerId,
    predictedWinnerProbability,
    isEliteTier: eliteTierBeforeGuard,
    eliteTierReason: eliteTierReasonBeforeGuard,
    modelAgreement,
    upsetRisk,
    upsetRiskBreakdownTier: upsetRiskBreakdown.upsetRisk,
    recommendation,
    modelConflict,
    disagreementNote,
    modelConflictNote,
    upsetRiskNote: upsetRiskBreakdown.note,
    predictedSetScore,
    dataQuality,
    dataQualityLabel,
    simulationPlayer1WinProbability: simulation.player1WinProbability,
    tieBreakerApplied: tieBreaker.applied,
    coreSignalsAlign,
  });
  const isEliteTier = consistencyViolations.length === 0 && eliteTierBeforeGuard;
  const eliteTierReason =
    consistencyViolations.length === 0
      ? eliteTierReasonBeforeGuard
      : `Not elite tier -- final-consistency guard caught an invariant violation and withheld Elite regardless of the underlying gates: ${consistencyViolations.join(" ")}`;
  if (consistencyViolations.length > 0) {
    risks.unshift(`CONSISTENCY GUARD: ${consistencyViolations.join(" ")}`);
  }

  const engine: EngineBreakdown = {
    surfaceElo,
    serveReturn,
    recentForm,
    fatigue,
    matchLoadRecovery,
    availability,
    styleMatchup,
    headToHead,
    models,
    modelAgreement,
    disagreementNote,
    matchupCloseness,
    reasons,
    risks,
    disclosures,
    warnings,
    coverageGaps,
    availabilityNote: buildAvailabilityNote(availability),
    conditionsNote: weather
      ? `Forecast conditions for ${weather.venueName}: ${weather.temperatureC}°C, wind ${weather.windSpeedKph} km/h, ${weather.precipitationProbability}% chance of precipitation. ${weather.note}`
      : "Live weather and court-speed conditions are not connected for this matchup -- either the fixture isn't a genuinely upcoming one with a known venue/date, or it's beyond the forecast horizon.",
    weather,
    segmentKey: segment?.segmentKey ?? null,
    segmentLabel: segment?.label ?? null,
    specialistApplied,
    segmentNote,
    simulation,
    simulatorApplied,
    simulatorNote,
    modelConflict,
    modelConflictNote,
    tieBreakerApplied: tieBreaker.applied,
    tieBreakerDecidingStep: tieBreaker.decidingStep,
    tieBreakerNote: tieBreaker.note,
    defaultedInputs,
    isEliteTier,
    eliteTierReason,
    upsetRiskBreakdown,
    surfaceSampleDepth,
    consistencyViolations,
  };

  // ---------------------------------------------------------------------------
  // Task #32: Build the full decision trace before returning.
  // All intermediate variables (rawEnsembleProbability, tieBreaker, generalProbability,
  // blendedProbability, preSimulatorProbability, simulatorScopeGap, etc.) are captured here so
  // the DB row carries a complete audit trail of every pipeline stage and decision-chain rule.
  // ---------------------------------------------------------------------------
  const calibrationMethod: "fitted" | "fallback" =
    input.activeCalibration && input.activeCalibration.length > 0 ? "fitted" : "fallback";
  const fallbackShrinkFactor = calibrationMethod === "fallback" ? getFallbackShrinkFactor(dataQuality) : 1.0;

  // Build a name→ModelVote lookup from ensemble contributors so we can enrich each moduleEdge.
  const featureModelByName = new Map(featureModels.map((m) => [m.modelName, m]));

  const moduleTraces: ModuleTrace[] = moduleEdges.map((m) => {
    const vote = featureModelByName.get(m.name);
    const excludedFromEnsemble = EXCLUDED_FROM_ENSEMBLE.has(m.key);
    const excludedByAblation = excludedModels?.has(m.key) ?? false;
    const effectivelyContributes = !excludedFromEnsemble && !excludedByAblation;
    const voteDirection: "player1" | "player2" | "tied" | null = vote
      ? vote.player1Probability > 50 ? "player1" : vote.player1Probability < 50 ? "player2" : "tied"
      : null;
    return {
      key: m.key,
      name: m.name,
      rawEdge: Math.round(m.player1Edge * 1000) / 1000,
      reliability: m.reliability,
      importance: m.importance,
      weightPrior: m.weightPrior,
      confidenceShrink: (m as { confidenceShrink?: number }).confidenceShrink ?? 1.0,
      excludedFromEnsemble,
      excludedFromDataQuality: EXCLUDED_FROM_DATA_QUALITY.has(m.key),
      excludedByAblation,
      player1Probability: effectivelyContributes && vote ? vote.player1Probability : null,
      effectiveWeight: effectivelyContributes && vote ? vote.weightUsed : null,
      voteDirection: effectivelyContributes ? voteDirection : null,
    };
  });

  // Append the market consensus module trace when it voted.
  if (marketConsensusInput) {
    const marketVote = featureModelByName.get("Market Consensus");
    const marketAblated = excludedModels?.has("marketOdds") ?? false;
    const marketVoteDir: "player1" | "player2" | "tied" | null = marketVote
      ? marketVote.player1Probability > 50 ? "player1" : marketVote.player1Probability < 50 ? "player2" : "tied"
      : null;
    moduleTraces.push({
      key: "marketOdds",
      name: "Market Consensus",
      rawEdge: Math.round(marketConsensusInput.player1Edge * 1000) / 1000,
      reliability: marketConsensusInput.reliability,
      importance: 0.5, // excluded from DQ blend; value is informational only
      weightPrior: marketConsensusInput.weightPrior,
      confidenceShrink: 1.0,
      excludedFromEnsemble: false,
      excludedFromDataQuality: true,
      excludedByAblation: marketAblated,
      player1Probability: !marketAblated && marketVote ? marketVote.player1Probability : null,
      effectiveWeight: !marketAblated && marketVote ? marketVote.weightUsed : null,
      voteDirection: !marketAblated ? marketVoteDir : null,
    });
  }

  const calibratedMarginForTrace = Math.abs(calibratedProbability - 50);
  // surfaceEloFavorsP1, serveReturnFavorsP1, recentFormFavorsP1 are computed earlier near the
  // recommendation call — they're already in scope, no need to recompute here.

  const decisionTrace: DecisionTrace = {
    pipeline: {
      rawEnsemble: rawEnsembleProbability,
      tieBreakerApplied: tieBreaker.applied,
      afterTieBreaker: ensembleProbability,
      calibrationMethod,
      fallbackShrinkFactor,
      afterCalibration: generalProbability,
      specialistWeight,
      afterSpecialist: blendedProbability,
      reliabilityDiscount,
      afterReliabilityDiscount: preSimulatorProbability,
      simulatorScopeGap: Math.round(simulatorScopeGap * 1000) / 1000,
      simulatorScopeScale: Math.round(simulatorScopeScale * 1000) / 1000,
      simulatorWeight: Math.round(simulatorWeight * 1000) / 1000,
      afterSimulator: calibratedProbability,
    },
    modules: moduleTraces,
    recommendation: buildRecommendationTrace(calibratedProbability, dataQuality, dataQualityLabel, modelAgreement, recommendation, tieBreaker.applied, coreSignalsAlign),
    eliteTier: {
      isElite: isEliteTier,
      gates: {
        dataQuality: { required: 55, actual: dataQuality, passed: dataQuality >= 55 },
        calibratedMargin: { required: 5, actual: Math.round(calibratedMarginForTrace * 10) / 10, passed: calibratedMarginForTrace >= 5 },
        allCoreModelsAgree: {
          surfaceEloFavorsP1,
          serveReturnFavorsP1,
          recentFormFavorsP1,
          passed: surfaceEloFavorsP1 === serveReturnFavorsP1 && serveReturnFavorsP1 === recentFormFavorsP1,
        },
        specialistApplied: { passed: specialistApplied },
        noModelConflict: { passed: !modelConflict },
        notHighDisagreement: { actual: modelAgreement, passed: modelAgreement !== "HighDisagreement" },
        upsetRiskAcceptable: { actual: upsetRisk, passed: upsetRisk === "LOW" || upsetRisk === "MODERATE" },
        consistencyGuard: { passed: consistencyViolations.length === 0, violations: consistencyViolations },
      },
    },
    computedAt: new Date().toISOString(),
  };

  return {
    predictedWinnerId,
    predictedWinnerName,
    calibratedProbability,
    predictedWinnerProbability,
    rawEnsembleProbability: ensembleProbability,
    dataQuality,
    dataQualityLabel,
    upsetRisk,
    recommendation,
    predictedSetScore,
    engine,
    decisionTrace,
    crossEngineAgreement: null,
  };
}
