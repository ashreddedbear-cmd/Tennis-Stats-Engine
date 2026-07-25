import type { UpsetRisk } from "./upsetRisk";
import type { DataQualityLabel } from "./dataQuality";
import type { ModelAgreement } from "./ensemble";

export type Recommendation = "STRONG_RECOMMENDATION" | "MODERATE_LEAN" | "HIGH_RISK" | "NO_STRONG_SIGNAL" | "DO_NOT_RECOMMEND";

const HIGH_PROBABILITY_MARGIN_FLOOR = 40; // 90% winner-confidence equivalent (or 10% for player1-relative probability)

/**
 * NO_STRONG_SIGNAL is distinct from HIGH_RISK: HIGH_RISK means the engine has a real lean but the
 * matchup carries genuine upset danger (e.g. a big favorite who could plausibly lose).
 * NO_STRONG_SIGNAL means the engine simply doesn't have a lean at all -- the probability is close
 * to a coin flip AND the underlying models don't agree -- so there's nothing meaningful to
 * recommend either way, as opposed to a real signal that's merely risky.
 */
export function computeRecommendation(
  calibratedProbability: number,
  dataQuality: number,
  dataQualityLabel: DataQualityLabel,
  upsetRisk: UpsetRisk,
  modelAgreement: ModelAgreement,
  /**
   * Pass `tieBreaker.applied` from the engine output. When true the raw ensemble sat within
   * `TIE_BAND` of 50 -- no validated signal provides a reliable directional edge in that
   * probability range (every cascade step measured at or below coin-flip accuracy on real graded
   * outcomes; see tieBreakers.ts history block). Routing to NO_STRONG_SIGNAL ensures the stored
   * recommendation is consistent with the UI's "Too close to call" treatment and prevents a
   * genuinely ambiguous match from being mislabelled HIGH_RISK by the fallthrough branch.
   * Defaults to false so old call sites (e.g. finalConsistencyCheck Rule 10 on legacy rows) are
   * not retroactively changed.
   */
  tieBreakerApplied = false,
): Recommendation {
  const margin = Math.abs(calibratedProbability - 50);

  if (dataQualityLabel === "Poor" || dataQuality < 25) return "DO_NOT_RECOMMEND";
  // Raw ensemble was coin-flip level — no validated signal exists in this probability range.
  // Returning NO_STRONG_SIGNAL keeps the recommendation consistent with the UI's "Too close to
  // call" disclosure and avoids the HIGH_RISK fallthrough mislabelling an ambiguous match.
  if (tieBreakerApplied) return "NO_STRONG_SIGNAL";
  if (margin < 8 && (modelAgreement === "Mixed" || modelAgreement === "HighDisagreement")) return "NO_STRONG_SIGNAL";
  if (upsetRisk === "EXTREME") return "HIGH_RISK";
  // Phase 7 fix: at ≥85% confidence (margin≥35), non-extreme risk, and no active model
  // disagreement, always return STRONG_RECOMMENDATION — a 92% prediction mislabeled "LEAN"
  // due to modelAgreement not being exactly "Strong" is confusing and misleading. This gate
  // applies ONLY going forward; saved records are never retroactively mutated.
  if (
    margin >= 35 &&
    dataQuality >= 45 &&
    (upsetRisk === "LOW" || upsetRisk === "MODERATE") &&
    modelAgreement !== "Mixed" &&
    modelAgreement !== "HighDisagreement"
  )
    return "STRONG_RECOMMENDATION";
  // Task #75: the dataQuality>=55 floor here was tuned before Task #68 excluded Head-to-Head from
  // the Data Quality blend, which pushed most real scores higher. A real walk-forward re-run
  // (docs/audit-task75-dq-threshold-revalidation.md) shows the 45-55 band is now the
  // best-calibrated slice of the whole distribution (log loss 0.662, only +2.6pt gap vs. observed
  // favorite win rate) -- better than 55-65 (log loss 0.693, -2.9pt gap), which the old >=55 floor
  // let through untouched while excluding the stronger 45-55 band. Lowered to 45 (the "Acceptable"
  // label floor) so STRONG_RECOMMENDATION reaches the segment the evidence actually supports.
  // Task #120: Task #116's audit found STRONG_RECOMMENDATION (margin>=22, i.e. confidence>=72%)
  // had the worst log loss of any tier (0.736, worse than a coin flip) on n=189 -- a real but
  // small-sample warning. This task re-checked it against an independent fresh backtest sample
  // (n=44) and found the same pattern reproduces (log loss 0.729, accuracy indistinguishable from
  // MODERATE_LEAN) -- see docs/audit-task120-strong-recommendation-revalidation.md. Thresholds are
  // left unchanged: the better-powered confidence-band calibration curve (n=307-136 in the
  // relevant range) shows overconfidence *worsens*, not improves, above this gate's ~72%
  // confidence floor, so raising the margin further would select an equally/more overconfident
  // population rather than a better-calibrated one (unlike Task #75's DQ retune, where a threshold
  // move did land on a genuinely better-calibrated band). The real fix belongs in the calibration
  // curve itself (calibration.ts), not this gate -- re-check this threshold again once that's
  // addressed and once live paper-trading volume (Task #121) exists to compare against.
  if (
    margin >= 26 &&
    dataQuality >= 50 &&
    upsetRisk === "LOW" &&
    modelAgreement === "Strong"
  )
    return "STRONG_RECOMMENDATION";
  if (
    margin >= 12 &&
    (upsetRisk === "LOW" || upsetRisk === "MODERATE") &&
    modelAgreement !== "Mixed" &&
    modelAgreement !== "HighDisagreement"
  )
    return "MODERATE_LEAN";
  // Margin 8-10 (exclusive of the >=10 branch above, so effectively [8, 10)) with a genuinely
  // low/moderate upset risk and non-Mixed/HighDisagreement agreement is a real, if modest, lean --
  // not a case of "genuine upset danger" (HIGH_RISK's documented meaning above). Falling through
  // to HIGH_RISK for these rows mislabeled otherwise-unremarkable matches as risky.
  if (
    margin >= 9 &&
    (upsetRisk === "LOW" || upsetRisk === "MODERATE") &&
    modelAgreement !== "Mixed" &&
    modelAgreement !== "HighDisagreement"
  )
    return "MODERATE_LEAN";
  // Guardrail: very high-confidence picks (>=90% winner-confidence equivalent) should not be
  // shown as HIGH_RISK unless there is explicit severe conflict evidence (Mixed/HighDisagreement)
  // or truly extreme upset danger. This keeps top-badge semantics aligned with user-facing
  // intuition while preserving the stricter STRONG_RECOMMENDATION gate above.
  if (
    margin >= HIGH_PROBABILITY_MARGIN_FLOOR &&
    modelAgreement !== "Mixed" &&
    modelAgreement !== "HighDisagreement"
  )
    return "MODERATE_LEAN";
  return "HIGH_RISK";
}
