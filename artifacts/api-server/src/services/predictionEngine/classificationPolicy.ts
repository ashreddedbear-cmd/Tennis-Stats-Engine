/**
 * Centralized, versioned classification policy for Recommendation / Elite tier gating.
 *
 * Why this file exists (2026-08-13 confidence/recommendation classification fix): a 100-match
 * verified backtest (ground truth, not theory) found the prediction MATH is fine (predicted
 * winner unchanged), but the classification layer was gating on the wrong signals:
 *
 *  - The displayed final win probability barely separated wins from losses (73.6% avg on correct
 *    picks vs 70.5% on incorrect -- a 3pt gap), yet it was the ONLY thing driving Recommendation
 *    tiers and the Elite margin gate.
 *  - The raw surface-Elo point-gap between players separated wins from losses far better (63pts
 *    avg on correct picks vs 48pts on incorrect -- a 16pt gap), but was not used as a gate at all.
 *  - "Model Agreement" inside Elite carried no discriminating power: all 63 Elite picks in the
 *    backtest had 6/6 model agreement, unconditionally, by construction (Elite already required
 *    3-signal agreement) -- so agreement was measuring unanimity, not evidence strength. When the
 *    shared underlying signal was wrong, all 6 models agreed and were wrong together. Agreement
 *    cannot create Elite on its own, but High Disagreement can still veto it.
 *  - A 25-50pt Elo-gap band ("Caution") actively UNDERPERFORMED the 0-25pt ("Thin") band in the
 *    same backtest (53.6% vs 69.6%) -- a modest-looking gap that isn't real separation yet, but
 *    "looks favorite enough" to be mistaken for confidence.
 *
 * All thresholds below come from that 100-match diagnostic backtest. Per the project's own rule
 * (no threshold ships without holdout validation) these are STARTING VALUES, not final answers --
 * they are deliberately isolated in this one file so they can be re-backtested and retuned without
 * touching prediction math (surfaceElo.ts, ensemble.ts, calibration.ts, simulator.ts are untouched
 * by this fix). Bump CLASSIFICATION_POLICY_VERSION whenever any value below changes, so a stored
 * prediction's classification can always be traced back to the exact policy version that produced
 * it.
 */

export const CLASSIFICATION_POLICY_VERSION = "elo-gap-gate-2026-08-13.1";

/**
 * Elo-gap separation bands, keyed off the RAW surface-Elo rating-point gap between the two
 * players (`Math.abs(surfaceElo.eloDifference)` -- see `index.ts`'s `eloGapPoints`). This is
 * deliberately NOT a probability and NOT downstream of calibration, ensemble blending, specialist
 * weighting, or Monte Carlo -- it is computed purely from each player's surface Elo rating, before
 * any of those stages run, so it cannot be "just another mapping of final win probability" (the
 * flaw this fix found in the old matchupCloseness-as-gate approach -- see disagreement.ts's
 * `computeMatchupCloseness` doc, which stays probability-based and descriptive-only, and is never
 * used as an Elite/High-Confidence gate).
 */
export const ELO_GAP_BAND_BOUNDARIES = {
  /** Below this: "Thin" separation. 100-match backtest: 69.6% accuracy. */
  THIN_MAX: 25,
  /**
   * Below this (and >= THIN_MAX): "Caution" band. 100-match backtest: 53.6% accuracy -- WORSE
   * than the Thin band below it. Hard-blocked from Elite/High-Confidence, not merely
   * under-rewarded, until more data either confirms or overturns this finding (see module doc).
   */
  CAUTION_MAX: 50,
  /** Below this (and >= CAUTION_MAX): "Modest" separation -- minimum bar for HIGH_CONFIDENCE. */
  MODEST_MAX: 75,
  // >= MODEST_MAX: "Decisive" -- minimum bar for HIGHEST_CONFIDENCE / Elite tier.
} as const;

export type EloSeparationBand = "Thin" | "Caution" | "Modest" | "Decisive";

/** Classifies a raw (always non-negative) Elo point-gap into one of the four separation bands above. */
export function classifyEloSeparation(eloGapPoints: number): EloSeparationBand {
  const gap = Math.abs(eloGapPoints);
  if (gap < ELO_GAP_BAND_BOUNDARIES.THIN_MAX) return "Thin";
  if (gap < ELO_GAP_BAND_BOUNDARIES.CAUTION_MAX) return "Caution";
  if (gap < ELO_GAP_BAND_BOUNDARIES.MODEST_MAX) return "Modest";
  return "Decisive";
}

/**
 * Elite tier gates (see `eliteTier.ts`). `ELO_GAP_MIN_POINTS` is the new primary separation gate
 * from this fix: 100-match backtest found "final probability >=75% AND Elo gap >=75 AND Monte
 * Carlo >=65%" scored 85.0% (N=20), while "Elo gap >=75" ALONE already scored 83.3% (N=30) --
 * almost as good, so Elo gap is the dominant signal here, not the extra conditions.
 */
export const ELITE_GATE = {
  DATA_QUALITY_MIN: 55,
  MIN_CALIBRATED_MARGIN: 5,
  /** Requires the "Decisive" Elo-separation band (see `classifyEloSeparation`). */
  ELO_GAP_MIN_POINTS: ELO_GAP_BAND_BOUNDARIES.MODEST_MAX,
} as const;

/**
 * HIGH_CONFIDENCE now also requires real underlying separation -- at least the "Modest" band --
 * not just probability margin + model agreement. This is what fixes the tier-inversion bug (HIGH
 * scoring 58.3% vs MODERATE's 70.0% in the backtest): HIGH_CONFIDENCE picks were being awarded on
 * probability margin/agreement alone, with no floor on real player separation, letting thin-gap
 * matchups with a confident-looking blended number outrank genuinely separated ones.
 */
export const HIGH_CONFIDENCE_GATE = {
  /** Requires at least the "Modest" Elo-separation band -- blocks both "Thin" and "Caution". */
  ELO_GAP_MIN_POINTS: ELO_GAP_BAND_BOUNDARIES.CAUTION_MAX,
} as const;

/** Recommendation-tier probability-margin thresholds (unchanged from before this fix -- margin is
 * still a REQUIRED condition, just no longer a SUFFICIENT one for HIGH/HIGHEST; see recommendation.ts). */
export const RECOMMENDATION_MARGIN = {
  HIGHEST_PRIMARY: 35,
  HIGHEST_SECONDARY: 26,
  HIGH_STRONG: 20,
  HIGH_STRONG_OR_MODERATE: 12,
  HIGH_STRONG_MIN: 9,
  /** Guardrail floor: margin ≥ 40 is equivalent to a calibrated winner probability ≥ 90%. */
  HIGH_PROBABILITY_FLOOR: 40,
  MODERATE_MIN: 9,
  MIXED_REAL_LEAN_MIN: 12,
} as const;

export const INSUFFICIENT_EDGE_GATE = {
  DATA_QUALITY_MIN: 25,
  SMALL_LEAN_MAX_MARGIN: 8,
} as const;
