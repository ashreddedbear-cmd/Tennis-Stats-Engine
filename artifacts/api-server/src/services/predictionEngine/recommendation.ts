import type { DataQualityLabel } from "./dataQuality";
import type { ModelAgreement } from "./ensemble";
import { HIGH_CONFIDENCE_GATE, RECOMMENDATION_MARGIN, INSUFFICIENT_EDGE_GATE, classifyEloSeparation } from "./classificationPolicy";

export type Recommendation =
  | "HIGHEST_CONFIDENCE"
  | "HIGH_CONFIDENCE"
  | "MODERATE_CONFIDENCE"
  | "LOW_CONFIDENCE"
  | "INSUFFICIENT_EDGE"
  | "DATA_INCOMPLETE";

/**
 * Floor used by the "very high confidence" guardrail below.
 * margin ≥ 40 is equivalent to a calibrated winner probability ≥ 90%.
 */
const HIGH_PROBABILITY_MARGIN_FLOOR = RECOMMENDATION_MARGIN.HIGH_PROBABILITY_FLOOR;

/**
 * Recommendation measures how strongly the total available evidence supports
 * the predicted winner — NOT how likely an upset is or how risky the match is.
 * Upset Risk is a separate, independent signal that answers a different question
 * ("how volatile is this match?"). These two signals are intentionally decoupled:
 * a prediction may validly show HIGH_CONFIDENCE + MODERATE Upset Risk, or
 * LOW_CONFIDENCE + LOW Upset Risk. Forcing them to match produces a redundant,
 * confusing badge (the old HIGH_RISK fallthrough said "risky" while Upset Risk
 * already said "Extreme" — two labels for one claim).
 *
 * Tier meanings:
 *   HIGHEST_CONFIDENCE  — strong, reliable, consistent evidence across several
 *                         independent signals; all three core signals agree.
 *   HIGH_CONFIDENCE     — clear model-supported advantage; doesn't satisfy every
 *                         HIGHEST_CONFIDENCE requirement, but well-supported.
 *   MODERATE_CONFIDENCE — meaningful advantage, but evidence is mixed, incomplete,
 *                         or contested (mixed models or modest margin).
 *   LOW_CONFIDENCE      — projected winner, but the advantage is fragile, narrow,
 *                         or heavily affected by uncertainty.
 *   INSUFFICIENT_EDGE   — pass / abstain: evidence doesn't reliably separate the
 *                         players; not a forced confident pick.
 *
 * INSUFFICIENT_EDGE is distinct from LOW_CONFIDENCE: INSUFFICIENT_EDGE means the
 * engine has no reliable directional lean at all (coin-flip range, conflicted
 * models on a thin margin, or data too poor to trust), while LOW_CONFIDENCE means
 * the engine does identify a lean but the supporting evidence is fragile.
 */
export function computeRecommendation(
  calibratedProbability: number,
  dataQuality: number,
  dataQualityLabel: DataQualityLabel,
  modelAgreement: ModelAgreement,
  /**
   * Pass `tieBreaker.applied` from the engine output. When true the raw ensemble
   * sat within TIE_BAND of 50 — no validated signal provides a reliable
   * directional edge in that range. Routes to INSUFFICIENT_EDGE, consistent with
   * the UI's "Too close to call" treatment.
   * Defaults to false so call sites that predate this parameter are unchanged.
   */
  tieBreakerApplied = false,
  /**
   * True when all three primary signals — Surface Elo, Serve & Return, and
   * Recent Form — independently point at the same player. This is the same
   * corroboration check the Elite tier gate uses (eliteTier.ts) and is the
   * cleanest proxy for "evidence agreement across independent streams". Required
   * for HIGHEST_CONFIDENCE: modelAgreement (the weighted-vote consensus) can be
   * "Strong" even when the three core signals split 2-vs-1 on direction; requiring
   * all three to independently agree is a meaningfully higher bar.
   * Defaults to false so call sites that predate this parameter continue producing
   * the same output they always did.
   */
  coreSignalsAlign = false,
  dataIncomplete = false,
  /**
   * Raw (non-negative) surface-Elo rating-point gap between the two players --
   * `Math.abs(surfaceElo.eloDifference)`, computed independently of calibration/ensemble/
   * specialist/Monte Carlo blending. Added 2026-08-13: a 100-match backtest found this raw gap
   * separates wins from losses far better than the final calibrated probability's margin does
   * (16pt gap between correct/incorrect picks vs only 3pt for the final probability), so it is now
   * a REQUIRED (not just confirmatory) condition for HIGH_CONFIDENCE/HIGHEST_CONFIDENCE -- see
   * `classificationPolicy.ts`. Defaults to `Infinity` (always "Decisive") so call sites that
   * predate this parameter are unaffected.
   */
  eloGapPoints = Infinity,
): Recommendation {
  const margin = Math.abs(calibratedProbability - 50);
  const eloSeparation = classifyEloSeparation(eloGapPoints);
  // HIGH_CONFIDENCE and above require at least "Modest" separation (see classificationPolicy.ts) --
  // this single check blocks both "Thin" (no real gap yet) and "Caution" (a backtest-confirmed
  // dangerous middle band that underperforms "Thin" itself) from ever reaching HIGH/HIGHEST,
  // regardless of how strong the probability margin or model agreement look.
  const hasHighConfidenceSeparation = Math.abs(eloGapPoints) >= HIGH_CONFIDENCE_GATE.ELO_GAP_MIN_POINTS;

  // ── INSUFFICIENT_EDGE ──────────────────────────────────────────────────────
  // The evidence does not support a reliable directional pick.

  // 1. Data too thin / poor quality to trust any signal.
  if (dataIncomplete && tieBreakerApplied) return "DATA_INCOMPLETE";
  if (dataQualityLabel === "Poor" || dataQuality < INSUFFICIENT_EDGE_GATE.DATA_QUALITY_MIN) return "INSUFFICIENT_EDGE";
  // 2. Raw ensemble within coin-flip range — no validated directional edge exists.
  if (tieBreakerApplied) return "INSUFFICIENT_EDGE";
  // 3. Small lean with conflicted or mixed models = no reliable edge.
  if (margin < INSUFFICIENT_EDGE_GATE.SMALL_LEAN_MAX_MARGIN && (modelAgreement === "Mixed" || modelAgreement === "HighDisagreement")) return "INSUFFICIENT_EDGE";

  // ── HIGHEST_CONFIDENCE ─────────────────────────────────────────────────────
  // Strong, reliable, consistent evidence across independent signals. Requires:
  //  • a genuine underlying player-separation gap ("Decisive" Elo-gap band) -- added 2026-08-13,
  //    see module doc: this is now the PRIMARY separation gate, not the probability margin.
  //  • all three core signals agree on the same player (coreSignalsAlign) -- this CONFIRMS the
  //    separation above, it does not substitute for it (Root cause #2 fix: 6/6 agreement was
  //    present on literally every Elite pick, win or lose, so agreement alone cannot discriminate).
  //  • strong probability margin from a coin flip
  //  • full model consensus (Strong agreement)
  //
  // DQ gate intentionally removed (2026-08-08, Ticket 3): walk-forward data showed
  // Limited DQ (25–44) outperforms Excellent DQ (≥85) on held-out predictions —
  // 64.6% vs 62.5% — meaning treating higher DQ as more trustworthy here was
  // backwards. Only the Poor (<25) hard gate below is retained pending a full DQ
  // scoring redesign. Upset risk is NOT checked here; it is a separate dimension.
  if (eloSeparation === "Decisive") {
    if (margin >= RECOMMENDATION_MARGIN.HIGHEST_PRIMARY && modelAgreement === "Strong" && coreSignalsAlign)
      return "HIGHEST_CONFIDENCE";
    if (margin >= RECOMMENDATION_MARGIN.HIGHEST_SECONDARY && modelAgreement === "Strong" && coreSignalsAlign)
      return "HIGHEST_CONFIDENCE";
  }

  // ── HIGH_CONFIDENCE ────────────────────────────────────────────────────────
  // Clear, well-supported advantage with non-conflicted models AND real underlying separation.
  if (hasHighConfidenceSeparation) {
    if (margin >= RECOMMENDATION_MARGIN.HIGH_STRONG && modelAgreement === "Strong") return "HIGH_CONFIDENCE";
    if (margin >= RECOMMENDATION_MARGIN.HIGH_STRONG_OR_MODERATE && (modelAgreement === "Strong" || modelAgreement === "Moderate")) return "HIGH_CONFIDENCE";
    if (margin >= RECOMMENDATION_MARGIN.HIGH_STRONG_MIN && modelAgreement === "Strong") return "HIGH_CONFIDENCE";
    // Guardrail: very high-confidence picks (≥ 90% winner-equivalent margin) with
    // non-conflicted models must never be classified as merely a modest lean.
    if (margin >= HIGH_PROBABILITY_MARGIN_FLOOR && modelAgreement !== "Mixed" && modelAgreement !== "HighDisagreement")
      return "HIGH_CONFIDENCE";
  }

  // ── MODERATE_CONFIDENCE ────────────────────────────────────────────────────
  // Meaningful advantage, but with mixed evidence, lower model consensus, or (2026-08-13) not
  // enough real player separation to justify HIGH/HIGHEST regardless of how the probability looks.
  if (margin >= RECOMMENDATION_MARGIN.MODERATE_MIN && modelAgreement === "Moderate") return "MODERATE_CONFIDENCE";
  // Mixed or HighDisagreement models with a real (≥ 12pt) margin — there IS a
  // lean, but the models don't consistently agree on direction.
  if (margin >= RECOMMENDATION_MARGIN.MIXED_REAL_LEAN_MIN) return "MODERATE_CONFIDENCE";

  // ── LOW_CONFIDENCE ─────────────────────────────────────────────────────────
  // Projected winner, but the advantage is fragile, narrow, or contested.
  return "LOW_CONFIDENCE";
}
