import type { DataQualityLabel } from "./dataQuality";
import type { ModelAgreement } from "./ensemble";

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
const HIGH_PROBABILITY_MARGIN_FLOOR = 40;

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
): Recommendation {
  const margin = Math.abs(calibratedProbability - 50);

  // ── INSUFFICIENT_EDGE ──────────────────────────────────────────────────────
  // The evidence does not support a reliable directional pick.

  // 1. Data too thin / poor quality to trust any signal.
  if (dataIncomplete && tieBreakerApplied) return "DATA_INCOMPLETE";
  if (dataQualityLabel === "Poor" || dataQuality < 25) return "INSUFFICIENT_EDGE";
  // 2. Raw ensemble within coin-flip range — no validated directional edge exists.
  if (tieBreakerApplied) return "INSUFFICIENT_EDGE";
  // 3. Small lean with conflicted or mixed models = no reliable edge.
  if (margin < 8 && (modelAgreement === "Mixed" || modelAgreement === "HighDisagreement")) return "INSUFFICIENT_EDGE";

  // ── HIGHEST_CONFIDENCE ─────────────────────────────────────────────────────
  // Strong, reliable, consistent evidence across independent signals. Requires:
  //  • all three core signals agree on the same player (coreSignalsAlign)
  //  • strong probability margin from a coin flip
  //  • full model consensus (Strong agreement)
  //
  // DQ gate intentionally removed (2026-08-08, Ticket 3): walk-forward data showed
  // Limited DQ (25–44) outperforms Excellent DQ (≥85) on held-out predictions —
  // 64.6% vs 62.5% — meaning treating higher DQ as more trustworthy here was
  // backwards. Only the Poor (<25) hard gate below is retained pending a full DQ
  // scoring redesign. Upset risk is NOT checked here; it is a separate dimension.
  if (margin >= 35 && modelAgreement === "Strong" && coreSignalsAlign)
    return "HIGHEST_CONFIDENCE";
  if (margin >= 26 && modelAgreement === "Strong" && coreSignalsAlign)
    return "HIGHEST_CONFIDENCE";

  // ── HIGH_CONFIDENCE ────────────────────────────────────────────────────────
  // Clear, well-supported advantage with non-conflicted models.
  if (margin >= 20 && modelAgreement === "Strong") return "HIGH_CONFIDENCE";
  if (margin >= 12 && (modelAgreement === "Strong" || modelAgreement === "Moderate")) return "HIGH_CONFIDENCE";
  if (margin >= 9 && modelAgreement === "Strong") return "HIGH_CONFIDENCE";
  // Guardrail: very high-confidence picks (≥ 90% winner-equivalent margin) with
  // non-conflicted models must never be classified as merely a modest lean.
  if (margin >= HIGH_PROBABILITY_MARGIN_FLOOR && modelAgreement !== "Mixed" && modelAgreement !== "HighDisagreement")
    return "HIGH_CONFIDENCE";

  // ── MODERATE_CONFIDENCE ────────────────────────────────────────────────────
  // Meaningful advantage, but with mixed evidence or lower model consensus.
  if (margin >= 9 && modelAgreement === "Moderate") return "MODERATE_CONFIDENCE";
  // Mixed or HighDisagreement models with a real (≥ 12pt) margin — there IS a
  // lean, but the models don't consistently agree on direction.
  if (margin >= 12) return "MODERATE_CONFIDENCE";

  // ── LOW_CONFIDENCE ─────────────────────────────────────────────────────────
  // Projected winner, but the advantage is fragile, narrow, or contested.
  return "LOW_CONFIDENCE";
}
