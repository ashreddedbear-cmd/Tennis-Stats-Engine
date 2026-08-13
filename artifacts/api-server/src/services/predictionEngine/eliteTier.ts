import type { ModelVote } from "./ensemble";
import type { ModelAgreement } from "./disagreement";
import type { UpsetRisk } from "./upsetRisk";
import { ELITE_GATE, classifyEloSeparation } from "./classificationPolicy";

/**
 * Task #75 re-validation: this floor was originally set to 65 (the "Strong" data-quality label
 * floor) on the assumption that higher Data Quality means a more trustworthy prediction. After
 * Task #68 excluded Head-to-Head from the Data Quality blend (pushing most real scores higher), a
 * fresh walk-forward re-run plus the live ledger (n=4,111 graded rows,
 * docs/audit-task75-dq-threshold-revalidation.md) shows that assumption no longer holds: isolating
 * Data Quality's effect from every other Elite gate (all-3-signals-agree + margin>=5, n=3,014),
 * the DQ>=65 slice is WORSE calibrated (-5.6pt overconfidence gap, log loss 0.691) than the DQ<65
 * slice (-1.1pt gap, log loss 0.670) -- and the effect gets monotonically worse the higher Data
 * Quality climbs (65-85: -4.6pt gap; 85-100: -10.7pt gap, worse than a coin-flip's log loss). The
 * best-calibrated band in the whole distribution is actually 45-55. Raising this threshold further
 * would only select a more overconfident group; lowered to 55 (matching Data Quality's own
 * "Acceptable" floor) so Elite tier stops privileging exactly the regime the evidence says is
 * least trustworthy, while still requiring more than the weakest end of the distribution.
 */
const ELITE_DATA_QUALITY_THRESHOLD = ELITE_GATE.DATA_QUALITY_MIN;

/**
 * Task #66 ("Fix overconfident predictions in the near-Elite group"): the original three-signal
 * "all agree" gate checks DIRECTION only (`voteFavorsPlayer1` is true the instant a signal crosses
 * 50%, whether by 0.1 point or 40) -- so it lets in matches where Surface Elo/Serve & Return/
 * Recent Form all lean the same way by a hair, which "agree" on paper but are collectively barely
 * more informative than a coin flip. A real-data investigation of the near-Elite backtest cohort
 * (see NEAR_ELITE_ECE_INVESTIGATION.md) found this dominated the group by volume (55% of it sat in
 * the 50-55% confidence band) and was the main driver of its calibration error. Requiring the
 * FINAL calibrated pick to clear a minimum margin from a coin flip -- not just each signal's
 * direction -- filters out that noise-dominated slice; 5 points was the smallest threshold that
 * produced a clean, non-marginal ECE improvement on the real backtest data while keeping the
 * sample far above `ELITE_TIER_BACKTEST_MIN_SAMPLE_SIZE`.
 */
const ELITE_MIN_CALIBRATED_MARGIN = ELITE_GATE.MIN_CALIBRATED_MARGIN;

export interface EliteTierInputs {
  dataQuality: number;
  /** Final calibrated probability for player1 (0-100) -- used only for the minimum-margin gate below. */
  calibratedProbability: number;
  /** Sign (favors player1 when true) of each of the three primary signals. */
  surfaceEloFavorsPlayer1: boolean;
  serveReturnFavorsPlayer1: boolean;
  recentFormFavorsPlayer1: boolean;
  /** True only when a segment specialist (real historical accuracy for this exact tour/surface) actually contributed. */
  specialistApplied: boolean;
  segmentLabel: string | null;
  /**
   * True only when the final calibrated pick agrees with the raw, reliability-weighted evidence
   * vote (see `modelConflict` in `index.ts`) -- i.e. calibration/specialist/simulator blending
   * didn't need to override the underlying signal. This is the "calibration passing" check: it's
   * computable identically whether the probability came from a live fitted calibration curve or
   * a walk-forward fold's own validation-fit mapping, unlike checking for a specific active
   * calibration row (which is a live-request-only concept and would make Elite tier impossible
   * to ever earn during backtesting).
   */
  modelConflict: boolean;
  /**
   * Elite-vs-risk consistency guardrail (2026-07-13 disagreement/upset-risk spec, Part 2E): a
   * prediction cannot be Elite while the governing disagreement reading is High Disagreement, or
   * while the recalibrated upset risk is High/Extreme -- "top-tier confidence" and "genuine
   * conflict/upset danger" are contradictory claims about the same prediction. The risk label
   * itself is never suppressed when this fires -- only the Elite badge is withheld, with a
   * visible reason (see the "not elite" branch below).
   */
  modelAgreement: ModelAgreement;
  upsetRisk: UpsetRisk;
  /**
   * Raw (non-negative) surface-Elo rating-point gap between the two players --
   * `Math.abs(surfaceElo.eloDifference)`, computed BEFORE calibration/ensemble/specialist/Monte
   * Carlo blending (see `classificationPolicy.ts`'s module doc for why final probability alone is
   * not a reliable Elite gate: a 100-match backtest found this raw gap separates wins from losses
   * far better than the final blended probability does). This is now the PRIMARY separation gate
   * for Elite -- the 3-signal agreement check above still applies, but agreement alone can no
   * longer manufacture Elite status without a real underlying gap to back it up.
   */
  eloGapPoints: number;
}

export interface EliteTierResult {
  isEliteTier: boolean;
  reason: string;
}

export interface NearEliteTierResult {
  isNearEliteTier: boolean;
  reason: string;
}

/**
 * "Elite Prediction" tier (see the fix-the-engine spec, requirement 8): a strictly narrower, more
 * demanding bar than STRONG_RECOMMENDATION, gated on ALL of:
 *  - High data quality (>=65, the engine's own "Strong" floor).
 *  - The three primary signals (Surface Elo, Serve & Return, Recent Form) all agreeing on the
 *    same player -- not just a weighted average that happens to lean one way.
 *  - The final calibrated probability clearing a minimum margin from a coin flip
 *    (`ELITE_MIN_CALIBRATED_MARGIN`) -- signal agreement on direction alone doesn't require any of
 *    the signals to have a real edge, so a match where three signals each barely lean the same way
 *    should not earn the same badge as one with genuine separation (see that constant's doc).
 *  - Real historical accuracy for this exact tour/surface segment supporting the confidence (a
 *    segment specialist that has actually cleared its data-sufficiency threshold and voted).
 *  - Calibration passing: the probability comes from the real fitted isotonic calibration (learned
 *    from actual graded outcomes), not the pre-fit heuristic fallback, and there's no model
 *    conflict between the raw evidence and the final pick.
 *  - A genuine surface-Elo point-gap between the players ("Decisive" separation band, see
 *    `classificationPolicy.ts`) -- added 2026-08-13 after a 100-match backtest found the final
 *    probability + model agreement alone could not tell Elite wins from Elite losses (agreement
 *    was 6/6 unanimous on every Elite pick, win or lose), while the raw Elo gap cleanly could.
 *    Agreement cannot create Elite on its own, but High Disagreement can still veto it.
 */
export function computeEliteTier(input: EliteTierInputs): EliteTierResult {
  const reasons: string[] = [];
  if (input.dataQuality < ELITE_DATA_QUALITY_THRESHOLD) reasons.push(`data quality ${input.dataQuality} is below the ${ELITE_DATA_QUALITY_THRESHOLD} floor`);

  const signals = [input.surfaceEloFavorsPlayer1, input.serveReturnFavorsPlayer1, input.recentFormFavorsPlayer1];
  const allAgree = signals.every((s) => s === signals[0]);
  if (!allAgree) reasons.push("Surface Elo, Serve & Return, and Recent Form don't all agree on the same player");

  const calibratedMargin = Math.abs(input.calibratedProbability - 50);
  if (calibratedMargin < ELITE_MIN_CALIBRATED_MARGIN) {
    reasons.push(
      `the final calibrated probability (${input.calibratedProbability.toFixed(1)}%) is only ${calibratedMargin.toFixed(1)} points from a coin flip -- the three signals agreeing on DIRECTION isn't enough on its own, the pick needs a genuine margin (>=${ELITE_MIN_CALIBRATED_MARGIN})`,
    );
  }

  // Root cause #1/#2 fix (2026-08-13 classification audit): the final blended probability barely
  // separated wins from losses in the 100-match backtest (3pt gap), while the raw Elo-rating-point
  // gap between players separated them cleanly (16pt gap). 3-signal agreement above measures
  // consensus, not evidence strength -- in that same backtest EVERY Elite pick had 6/6 model
  // agreement by construction, so agreement could never have discriminated a win from a loss. This
  // gate requires genuine underlying separation (the "Decisive" Elo-gap band) as an independent,
  // non-probability precondition -- consensus and margin can no longer manufacture Elite on their own.
  const eloSeparationBand = classifyEloSeparation(input.eloGapPoints);
  if (Math.abs(input.eloGapPoints) < ELITE_GATE.ELO_GAP_MIN_POINTS) {
    reasons.push(
      `the surface-Elo point-gap between the players (${Math.abs(input.eloGapPoints).toFixed(0)}) is below the ${ELITE_GATE.ELO_GAP_MIN_POINTS}-point floor ("${eloSeparationBand}" separation band) -- a confident-looking calibrated probability or full model agreement is not enough without a genuine underlying gap between the players`,
    );
  }

  if (!input.specialistApplied) reasons.push(`no validated segment specialist${input.segmentLabel ? ` for ${input.segmentLabel}` : ""} is backing this prediction with real historical accuracy`);

  if (input.modelConflict) reasons.push("calibration/specialist blending flipped the pick away from the raw evidence (model conflict) -- calibration did not pass");

  if (input.modelAgreement === "HighDisagreement") reasons.push("model agreement is High Disagreement -- agreement cannot create Elite on its own, but High Disagreement can still veto it; the risk label is not suppressed, only the Elite badge is withheld");
  if (input.upsetRisk === "HIGH" || input.upsetRisk === "EXTREME") reasons.push(`upset risk is ${input.upsetRisk} -- the risk label is not suppressed, only the Elite badge is withheld`);

  if (reasons.length === 0) {
    return {
      isEliteTier: true,
      reason: `Elite: high data quality, Surface Elo/Serve & Return/Recent Form all agree with a genuine margin (${calibratedMargin.toFixed(1)} points from a coin flip), a ${Math.abs(input.eloGapPoints).toFixed(0)}-point surface-Elo gap between the players ("Decisive" separation), a validated segment specialist backs the call, and the calibrated pick agrees with the raw evidence (no model conflict). Elite is the engine's most selective bar, not a proven track record -- see the Accuracy dashboard's Elite Tier Backtest for real-world performance so far.`,
    };
  }
  return { isEliteTier: false, reason: `Not elite tier -- ${reasons.join("; ")}.` };
}

/** True when a ModelVote list's per-model votes for a given model name favor player1. */
export function voteFavorsPlayer1(models: ModelVote[], modelName: string): boolean {
  const vote = models.find((m) => m.modelName === modelName);
  return vote ? vote.player1Probability >= 50 : false;
}

/**
 * "Near-Elite" (backtest-only, task 46): identical to `computeEliteTier` except the segment-
 * specialist requirement is relaxed to "satisfied" rather than checked. This exists to catch
 * matches that clear every other Elite gate but land in a tour/surface segment with no validated
 * specialist yet -- e.g. a segment still below `MIN_HISTORICAL_MATCHES_FOR_SEGMENT` /
 * `MIN_VALIDATION_SAMPLES_FOR_SEGMENT`, or (since Task #65) a historical_test row scored before
 * any specialist had ever been fit for its segment. Since Task #65, historical walk-forward
 * scoring (`historicalScoring.ts`) DOES apply a real segment specialist when one exists -- the
 * PREVIOUS run's persisted fit, never the run's own (see the doc on
 * `HistoricalScoringContext.specialistRowsBySegmentKey`), so real Elite tier can genuinely be
 * earned by a historical_test row now. Near-Elite remains as the honest fallback for rows/segments
 * where no real specialist backing was available to check.
 *
 * Never used to decide what tier is shown in the live/paper-trade prediction UI -- only to
 * classify already-graded rows for the Elite tier backtest (`eliteTierBacktest.ts`). A row that is
 * genuinely Elite tier (real `computeEliteTier` says so) is never double-counted as "near-Elite" by
 * that classifier.
 */
export function computeNearEliteTier(input: EliteTierInputs): NearEliteTierResult {
  const { isEliteTier, reason } = computeEliteTier({ ...input, specialistApplied: true });
  if (isEliteTier) {
    return {
      isNearEliteTier: true,
      reason:
        "Near-Elite (backtest only): every Elite gate except segment-specialist support is met -- specialist support can't be honestly evaluated in this scoring context (see computeNearEliteTier doc).",
    };
  }
  return { isNearEliteTier: false, reason };
}
