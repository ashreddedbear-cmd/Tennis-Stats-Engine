import type { ModelAgreement } from "./disagreement";
import type { UpsetRisk } from "./upsetRisk";
import type { DataQualityLabel } from "./dataQuality";
import { computeRecommendation } from "./recommendation";

/**
 * Defense-in-depth guard applied as the LAST step inside `runPredictionEngine`, before
 * `EngineOutput` is returned (Task 56, Part C). Every rule below is already guaranteed
 * structurally by the code that builds each field -- `eliteTier.ts`'s 2026-07-13 Part 2E
 * guardrail already withholds Elite whenever modelAgreement is HighDisagreement or upsetRisk is
 * HIGH/EXTREME, and `predictedWinnerProbability` is already constructed by mirroring
 * `calibratedProbability` (see the field doc on `EngineOutput`). This module does not re-fix the
 * root cause (already fixed) -- it exists so a FUTURE change to any of those call sites can never
 * silently reintroduce the original bug report's exact failure mode (a prediction simultaneously
 * shown as Elite, High Disagreement, and "no model conflict") without at least a visible,
 * queryable violation being recorded.
 *
 * Never throws: a violation here means an upstream invariant broke, which is a signal to
 * withhold the confident claim (Elite tier) and surface the inconsistency, not to 500 a live
 * prediction request.
 */
export interface FinalConsistencyInput {
  player1Id: string;
  player2Id: string;
  /** Player-1-relative, pre-mirroring win probability (0-100). */
  calibratedProbability: number;
  predictedWinnerId: string;
  /** Must always be the predicted winner's own probability, mirrored from calibratedProbability. */
  predictedWinnerProbability: number;
  isEliteTier: boolean;
  eliteTierReason: string;
  /** The single governing disagreement reading used everywhere else in this same EngineOutput. */
  modelAgreement: ModelAgreement;
  /** The single governing upset-risk tier used everywhere else in this same EngineOutput. */
  upsetRisk: UpsetRisk;
  /** The upset-risk tier as recorded on the detailed breakdown object -- checked against `upsetRisk` above to catch the two ever silently diverging (rule 5, "single source of truth"). */
  upsetRiskBreakdownTier: UpsetRisk;
  /** "HIGHEST_CONFIDENCE" | "HIGH_CONFIDENCE" | "MODERATE_CONFIDENCE" | "LOW_CONFIDENCE" | "INSUFFICIENT_EDGE" from recommendation.ts (or legacy values for stored rows predating the rename). Typed loosely here to avoid a circular import; validated as a plain string. */
  recommendation: string;
  /**
   * True when all three primary signals — Surface Elo, Serve & Return, and Recent Form —
   * independently point at the same player. Must be forwarded to `computeRecommendation` in
   * Rule 10 so the freshness check uses the same inputs the original call used. Absent on rows
   * that predate the coreSignalsAlign parameter — default false so those rows are not flagged.
   */
  coreSignalsAlign?: boolean;
  /** True when calibration/specialist/simulator blending flipped the pick away from the raw evidence vote (index.ts's `modelConflict`). */
  modelConflict: boolean;
  /** Non-null only when modelAgreement isn't "Strong" (disagreement.ts's `buildDisagreementNote` contract). */
  disagreementNote: string | null;
  /** Non-null only when `modelConflict` is true (index.ts's `modelConflictNote` construction). */
  modelConflictNote: string | null;
  /** The upset-risk breakdown's own auditable note (upsetRisk.ts's `buildUpsetRiskNote`). */
  upsetRiskNote: string;
  /** "W-L" set-count string for the predicted winner (e.g. "2-0"), as shown to users. */
  predictedSetScore: string;
  /** The same 0-100 Data Quality score `computeRecommendation` was actually given when `recommendation` was produced. */
  dataQuality: number;
  /** The same Data Quality label `computeRecommendation` was actually given when `recommendation` was produced. */
  dataQualityLabel: DataQualityLabel;
  /**
   * Whether the raw ensemble sat within TIE_BAND of 50 when this prediction was made.
   * Must be forwarded to `computeRecommendation` in Rule 10 so the freshness check produces the
   * same result as the original call. Absent on pre-Task#7 predictions — default false so those
   * rows are not retroactively flagged as stale.
   */
  tieBreakerApplied?: boolean;
  /**
   * The Monte Carlo simulator's raw, player-1-relative win probability (0-100) from
   * `EngineBreakdown.simulation.player1WinProbability` -- the same stored field
   * `PredictionResult.tsx`'s `deriveMonteCarloHeadline` mirrors to the predicted winner's side.
   * Null/undefined when this row predates Phase 7's simulator (no simulation was ever computed
   * for it) -- rule 11 below can't check a value that was never stored, so it stays silent rather
   * than treating an absent field as a violation.
   */
  simulationPlayer1WinProbability?: number | null;
}

export interface FinalConsistencyResult {
  /** Empty in the overwhelming common case -- every rule already holds by construction. */
  violations: string[];
}

const PROBABILITY_EPSILON = 0.15;

/**
 * Rules 1-5 are the original five consistency rules from the Task 56 spec; rules 6-10 were added
 * by later phases (Strong Recommendation, Elite-vs-recommendation, note consistency, set score,
 * and recommendation freshness); rules 11-12 (Task 87) guard the Monte Carlo headline-binding
 * pattern and the recommendation margin 8-10 catch-all gap specifically, independent of whatever
 * `computeRecommendation`/`deriveMonteCarloHeadline` currently do, so a regression in either of
 * those functions can't slip past its own recomputed-and-therefore-matching check.
 *  1. The predicted winner must be whichever player calibratedProbability actually favors.
 *  2. predictedWinnerProbability must be a valid, meaningful favorite probability (50-100).
 *  3. predictedWinnerProbability must be the exact mirrored complement of calibratedProbability
 *     -- never an independently-computed number that could drift from it.
 *  4. The Elite-tier reason string must never claim "no model conflict" while the governing
 *     disagreement/upset-risk reading says otherwise (the original bug report's exact shape).
 *  5. The plain upsetRisk tier and the detailed breakdown's own tier must be the same value --
 *     there is exactly one upset-risk reading per prediction, never two that could disagree.
 */
export function checkFinalConsistency(input: FinalConsistencyInput): FinalConsistencyResult {
  const violations: string[] = [];
  const favorsPlayer1 = input.calibratedProbability >= 50;
  const expectedWinnerId = favorsPlayer1 ? input.player1Id : input.player2Id;

  if (input.predictedWinnerId !== expectedWinnerId) {
    violations.push(
      `Rule 1 (winner/probability agreement): predictedWinnerId (${input.predictedWinnerId}) does not match the player calibratedProbability=${input.calibratedProbability} favors (${expectedWinnerId}).`,
    );
  }

  if (input.predictedWinnerProbability < 50 || input.predictedWinnerProbability > 100) {
    violations.push(`Rule 2 (probability bounds): predictedWinnerProbability ${input.predictedWinnerProbability} is outside the valid [50,100] range for a named favorite.`);
  }

  const expectedWinnerProbability = Math.round((favorsPlayer1 ? input.calibratedProbability : 100 - input.calibratedProbability) * 10) / 10;
  if (Math.abs(input.predictedWinnerProbability - expectedWinnerProbability) > PROBABILITY_EPSILON) {
    violations.push(
      `Rule 3 (complementary opponent probability): predictedWinnerProbability ${input.predictedWinnerProbability} is not the mirrored complement of calibratedProbability ${input.calibratedProbability} (expected ${expectedWinnerProbability}).`,
    );
  }

  const structurallyConflicted = input.modelAgreement === "HighDisagreement" || input.upsetRisk === "HIGH" || input.upsetRisk === "EXTREME";
  const claimsNoConflict = /no model conflict/i.test(input.eliteTierReason);
  if (claimsNoConflict && structurallyConflicted) {
    violations.push(
      `Rule 4 (Elite wording vs. risk): eliteTierReason claims "no model conflict" while modelAgreement=${input.modelAgreement} and upsetRisk=${input.upsetRisk}.`,
    );
  }
  if (input.isEliteTier && structurallyConflicted) {
    violations.push(
      `Rule 4 (Elite gate vs. risk): isEliteTier is true while modelAgreement=${input.modelAgreement} and upsetRisk=${input.upsetRisk} -- Elite and High Disagreement/High-or-Extreme upset risk can never both be true for the same prediction.`,
    );
  }

  if (input.upsetRisk !== input.upsetRiskBreakdownTier) {
    violations.push(
      `Rule 5 (single source of truth): top-level upsetRisk (${input.upsetRisk}) disagrees with the detailed breakdown's own tier (${input.upsetRiskBreakdownTier}).`,
    );
  }

  // Rule 6: HIGHEST_CONFIDENCE is the engine's top tier — it requires Strong model agreement by
  // construction (`recommendation.ts` gates it on modelAgreement === "Strong"). Upset risk is NOT
  // checked here because upset risk is no longer an input to computeRecommendation; it is a
  // separate, independent signal. This rule guards only the model-agreement invariant.
  if (input.recommendation === "HIGHEST_CONFIDENCE") {
    if (input.modelAgreement === "Mixed" || input.modelAgreement === "HighDisagreement") {
      violations.push(`Rule 6 (Highest Confidence vs. model agreement): recommendation is HIGHEST_CONFIDENCE while modelAgreement is ${input.modelAgreement} -- HIGHEST_CONFIDENCE requires Strong model agreement.`);
    }
  }

  // Rule 7: Elite tier is a strictly narrower, MORE demanding bar than any confident recommendation
  // (eliteTier.ts's doc comment) -- it can never be true at the same time as INSUFFICIENT_EDGE
  // ("available evidence does not support a reliable directional pick", recommendation.ts). Also
  // preserves backward-compat for the old tier names stored in pre-rename rows.
  if (
    input.isEliteTier &&
    (input.recommendation === "INSUFFICIENT_EDGE" ||
      input.recommendation === "NO_STRONG_SIGNAL" ||
      input.recommendation === "DO_NOT_RECOMMEND")
  ) {
    violations.push(`Rule 7 (Elite vs. recommendation): isEliteTier is true while recommendation is ${input.recommendation} -- Elite requires a real, well-supported lean.`);
  }

  // Rule 8: the auditable explanation notes must never claim a disagreement/conflict exists when
  // the flag that gates them is false, or omit one that does exist -- e.g. the upsetRisk.ts bug
  // where a note said "the core models disagree on direction" while modelAgreement wasn't even
  // HighDisagreement (coreModelsConflict can only be true when modelAgreement is HighDisagreement,
  // see disagreement.ts's OR condition, so this check needs no extra flag beyond modelAgreement).
  if (input.modelAgreement === "Strong" && input.disagreementNote !== null) {
    violations.push(`Rule 8 (disagreement note vs. flag): disagreementNote is present while modelAgreement is Strong (buildDisagreementNote's contract says null exactly when Strong).`);
  }
  if (input.modelAgreement !== "Strong" && input.disagreementNote === null) {
    violations.push(`Rule 8 (disagreement note vs. flag): disagreementNote is null while modelAgreement is ${input.modelAgreement} -- a real disagreement must never go unexplained.`);
  }
  if (!input.modelConflict && input.modelConflictNote !== null) {
    violations.push(`Rule 8 (model-conflict note vs. flag): modelConflictNote is present while modelConflict is false.`);
  }
  if (input.modelConflict && input.modelConflictNote === null) {
    violations.push(`Rule 8 (model-conflict note vs. flag): modelConflictNote is null while modelConflict is true -- a real conflict must never go unexplained.`);
  }
  if (/core models disagree on direction/i.test(input.upsetRiskNote) && input.modelAgreement !== "HighDisagreement") {
    violations.push(
      `Rule 8 (upset-risk note vs. flag): upsetRiskNote claims "the core models disagree on direction" while modelAgreement is ${input.modelAgreement} -- that claim is only ever true when a genuine coreModelsConflict exists, which requires modelAgreement to be HighDisagreement.`,
    );
  }

  // Rule 9: the predicted winner's own projected set score must never imply they lose the match
  // (more sets for the opponent than for the winner). Parsed as plain "W-L" digits, winner first.
  const setScoreMatch = input.predictedSetScore.match(/^(\d+)-(\d+)$/);
  if (!setScoreMatch) {
    violations.push(`Rule 9 (set score format): predictedSetScore "${input.predictedSetScore}" is not a valid "W-L" set-count string.`);
  } else {
    const [, winnerSets, loserSets] = setScoreMatch.map(Number) as unknown as [number, number, number];
    if (winnerSets <= loserSets) {
      violations.push(`Rule 9 (set score vs. winner): predictedSetScore "${input.predictedSetScore}" does not show the predicted winner (listed first) taking more sets than the opponent.`);
    }
  }

  // Rule 10: the stored `recommendation` must always equal what `computeRecommendation` actually
  // produces for the same governing inputs (calibratedProbability, dataQuality/label, upsetRisk,
  // modelAgreement) -- there is exactly one recommendation-computing function, and this reading
  // must never be allowed to drift from it. This guards two different failure modes at once:
  //  - a bug in `recommendation.ts` itself (e.g. the margin 8-10 catch-all gap) shows up
  //    immediately on every NEW prediction, not just ones a human happens to eyeball;
  //  - a STALE recommendation -- a row whose `recommendation` was computed and stored under an
  //    older version of `computeRecommendation`'s logic and never recomputed -- is flagged the
  //    moment `checkFinalConsistency` is re-run against it (e.g. via the live-ledger batch scan),
  //    even though nothing about that specific bug's root cause needs to be known in advance.
  // upsetRisk is intentionally NOT passed to computeRecommendation — it is a separate, independent
  // signal that is no longer an input to the recommendation function (see recommendation.ts).
  const expectedRecommendation = computeRecommendation(
    input.calibratedProbability,
    input.dataQuality,
    input.dataQualityLabel,
    input.modelAgreement,
    input.tieBreakerApplied ?? false,
    input.coreSignalsAlign ?? false,
  );
  // IMPORTANT: rows stored before the v2 rename keep their original recommendation value
  // (STRONG_RECOMMENDATION, MODERATE_LEAN, etc.). Rule 10 exists to catch staleness in LIVE
  // calls, not to retroactively flag every historical row. We skip the freshness check for any
  // row whose stored recommendation is a legacy name — those should be audited via the
  // recommendation-calibration shadow replay, not flagged as live violations on every read.
  const legacyRecommendationValues = new Set([
    "STRONG_RECOMMENDATION",
    "MODERATE_LEAN",
    "HIGH_RISK",
    "NO_STRONG_SIGNAL",
    "DO_NOT_RECOMMEND",
  ]);
  if (!legacyRecommendationValues.has(input.recommendation) && input.recommendation !== expectedRecommendation) {
    violations.push(
      `Rule 10 (recommendation freshness): stored recommendation "${input.recommendation}" does not match what computeRecommendation currently produces ("${expectedRecommendation}") for calibratedProbability=${input.calibratedProbability}, dataQuality=${input.dataQuality}, dataQualityLabel=${input.dataQualityLabel}, modelAgreement=${input.modelAgreement}, tieBreakerApplied=${input.tieBreakerApplied ?? false}, coreSignalsAlign=${input.coreSignalsAlign ?? false} -- this recommendation is stale and was not recomputed under the current logic.`,
    );
  }

  // Rule 11 (Monte Carlo headline-binding): the simulator only ever stores a player-1-relative
  // `simulation.player1WinProbability` -- every display surface (currently
  // `PredictionResult.tsx`'s `deriveMonteCarloHeadline`) must mirror it to the predicted winner's
  // own side (100 - x when the winner is stored as player2) before showing it as "the winner's
  // win probability". This re-implements that exact derivation as a plain, typed, backend-only
  // check -- it does NOT call any UI/render code -- so a future change to `deriveMonteCarloHeadline`
  // (or any other future call site that reads this same stored field) can never again silently
  // rebind the simulator's number to a fixed player slot instead of the predicted winner. Skipped
  // entirely when no simulation was ever stored for this row (pre-Phase-7 legacy rows) -- there is
  // nothing to check, not a violation.
  if (input.simulationPlayer1WinProbability !== null && input.simulationPlayer1WinProbability !== undefined) {
    const raw = input.simulationPlayer1WinProbability;
    let resolvedWinnerProbability: number | null = null;
    if (input.predictedWinnerId === input.player1Id) {
      resolvedWinnerProbability = raw;
    } else if (input.predictedWinnerId === input.player2Id) {
      resolvedWinnerProbability = 100 - raw;
    }
    // predictedWinnerId matching neither stored player id is already independently caught by
    // Rule 1 above (winner/probability agreement) -- this rule only adds the extra requirement
    // that, once resolved, the mirrored number must itself be a finite, valid [0,100] probability.
    if (
      resolvedWinnerProbability === null ||
      !Number.isFinite(resolvedWinnerProbability) ||
      resolvedWinnerProbability < 0 ||
      resolvedWinnerProbability > 100
    ) {
      violations.push(
        `Rule 11 (Monte Carlo headline binding): the predicted winner's simulation-derived win probability could not be resolved to a valid [0,100] value from simulation.player1WinProbability=${raw}, player1Id=${input.player1Id}, player2Id=${input.player2Id}, predictedWinnerId=${input.predictedWinnerId} (resolved=${resolvedWinnerProbability}) -- a future binding bug could show the wrong player's (or an invalid) simulated win probability.`,
      );
    }
  }

  // Rule 12 (recommendation catch-all-gap): re-checks, independently of `computeRecommendation`,
  // that margin 9-12 with Strong agreement never falls through to LOW_CONFIDENCE. Deliberately
  // hardcodes the expected outcome rather than calling `computeRecommendation` (that's Rule 10's
  // job): if a FUTURE change reopens this exact branch inside `computeRecommendation` itself,
  // Rule 10 alone could not catch it — it would just recompute the same newly-buggy value and
  // "match". This rule stands guard independently, regardless of whatever the current
  // `computeRecommendation` implementation does. upsetRisk is intentionally NOT checked here
  // because it is no longer an input to computeRecommendation.
  const catchAllGapMargin = Math.abs(input.calibratedProbability - 50);
  if (
    catchAllGapMargin >= 9 &&
    catchAllGapMargin < 12 &&
    input.modelAgreement === "Strong" &&
    input.recommendation === "LOW_CONFIDENCE"
  ) {
    violations.push(
      `Rule 12 (recommendation catch-all gap): recommendation is LOW_CONFIDENCE for a margin-${catchAllGapMargin.toFixed(1)} pick (calibratedProbability=${input.calibratedProbability}) with modelAgreement=${input.modelAgreement} -- a real lean with Strong model agreement and margin ≥ 9 must be at least HIGH_CONFIDENCE, not LOW_CONFIDENCE.`,
    );
  }

  return { violations };
}
