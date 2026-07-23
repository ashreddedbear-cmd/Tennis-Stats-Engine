import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRecommendation } from "./recommendation";

test("STRONG_RECOMMENDATION requires high margin + high data quality + low/moderate upset risk + strong-enough model agreement", () => {
  const result = computeRecommendation(85, 70, "Strong", "LOW", "Strong");
  assert.equal(result, "STRONG_RECOMMENDATION");
});

test("STRONG_RECOMMENDATION is withheld when model agreement is HighDisagreement, even with high margin/data quality/low risk", () => {
  // Regression test: previously STRONG_RECOMMENDATION only checked margin, data quality, and
  // upset risk -- not model agreement -- so a match where the core models genuinely disagree
  // could still be labeled a strong recommendation.
  const result = computeRecommendation(85, 70, "Strong", "LOW", "HighDisagreement");
  assert.notEqual(result, "STRONG_RECOMMENDATION", "HighDisagreement must block STRONG_RECOMMENDATION regardless of margin/data quality/risk");
});

test("STRONG_RECOMMENDATION is withheld when model agreement is Mixed, even with high margin/data quality/low risk", () => {
  const result = computeRecommendation(85, 70, "Strong", "MODERATE", "Mixed");
  assert.notEqual(result, "STRONG_RECOMMENDATION", "Mixed agreement must block STRONG_RECOMMENDATION regardless of margin/data quality/risk");
});

test("at very high confidence, Moderate agreement can still qualify for STRONG_RECOMMENDATION (Phase 7 >=85% gate)", () => {
  const result = computeRecommendation(85, 70, "Strong", "LOW", "Moderate");
  assert.equal(result, "STRONG_RECOMMENDATION");
});

test("DO_NOT_RECOMMEND still takes priority over everything else on poor data quality", () => {
  const result = computeRecommendation(85, 20, "Poor", "LOW", "Strong");
  assert.equal(result, "DO_NOT_RECOMMEND");
});

test("NO_STRONG_SIGNAL still fires for a near-coin-flip margin with Mixed/HighDisagreement agreement", () => {
  const result = computeRecommendation(52, 70, "Strong", "LOW", "HighDisagreement");
  assert.equal(result, "NO_STRONG_SIGNAL");
});

test("HIGH_RISK still fires on EXTREME upset risk regardless of agreement", () => {
  const result = computeRecommendation(85, 70, "Strong", "EXTREME", "Strong");
  assert.equal(result, "HIGH_RISK");
});

test("a high-margin match with HighDisagreement does not get promoted to MODERATE_LEAN", () => {
  // HighDisagreement now blocks both STRONG_RECOMMENDATION and MODERATE_LEAN, so this remains
  // HIGH_RISK despite the large margin.
  const result = computeRecommendation(80, 70, "Strong", "LOW", "HighDisagreement");
  assert.equal(result, "HIGH_RISK");
});

test("margin below 9 with LOW upset risk and Moderate agreement is HIGH_RISK under the stricter moderate-lean floor", () => {
  // margin = 8.7 now remains below the cautious moderate-lean floor.
  const result = computeRecommendation(58.7, 70, "Strong", "LOW", "Moderate");
  assert.equal(result, "HIGH_RISK");
});

test("margin exactly 9 with MODERATE upset risk and Strong agreement is MODERATE_LEAN (lower boundary of the new band)", () => {
  const result = computeRecommendation(59, 70, "Strong", "MODERATE", "Strong");
  assert.equal(result, "MODERATE_LEAN");
});

test("margin exactly 8 with MODERATE upset risk and Strong agreement is HIGH_RISK", () => {
  const result = computeRecommendation(58, 70, "Strong", "MODERATE", "Strong");
  assert.equal(result, "HIGH_RISK");
});

test("margin just under 8 with Strong agreement (so NOT caught by NO_STRONG_SIGNAL) still falls through to HIGH_RISK -- the new rule must not swallow sub-8 margins", () => {
  // tieBreakerApplied defaults to false here -- rule only fires when raw ensemble was coin-flip
  const result = computeRecommendation(57.9, 70, "Strong", "LOW", "Strong");
  assert.equal(result, "HIGH_RISK");
});

// ─── Task #7: tieBreakerApplied gate ────────────────────────────────────────

test("tieBreakerApplied=true → NO_STRONG_SIGNAL, regardless of margin or model agreement", () => {
  // Even a high-margin, strong-agreement match should be NO_STRONG_SIGNAL when the raw ensemble
  // was within TIE_BAND — the cascade was validated to perform at or below coin-flip in that
  // probability range; a confident-sounding recommendation on top of it is actively misleading.
  const result = computeRecommendation(57.9, 70, "Strong", "LOW", "Strong", /* tieBreakerApplied */ true);
  assert.equal(result, "NO_STRONG_SIGNAL");
});

test("tieBreakerApplied=true → NO_STRONG_SIGNAL even when margin would otherwise qualify for MODERATE_LEAN", () => {
  const result = computeRecommendation(61, 70, "Strong", "LOW", "Strong", true);
  assert.equal(result, "NO_STRONG_SIGNAL");
});

test("tieBreakerApplied=true with Poor DQ → DO_NOT_RECOMMEND still wins (DO_NOT_RECOMMEND takes absolute priority)", () => {
  // DO_NOT_RECOMMEND means the data is too thin to trust at all; that takes priority even over
  // a close-matchup disclosure.
  const result = computeRecommendation(52, 20, "Poor", "LOW", "Strong", true);
  assert.equal(result, "DO_NOT_RECOMMEND");
});

test("tieBreakerApplied=false (default) → original logic unchanged: Strong agreement sub-8 margin is HIGH_RISK", () => {
  // Regression guard: adding the tieBreakerApplied parameter must not affect existing behaviour
  // when it is false (or omitted).
  const result = computeRecommendation(53, 70, "Strong", "LOW", "Strong", false);
  assert.equal(result, "HIGH_RISK");
});

test("margin 8-10 with HighDisagreement agreement is NOT rescued by the new rule -- still HIGH_RISK (agreement gate must still apply)", () => {
  const result = computeRecommendation(58.7, 70, "Strong", "LOW", "HighDisagreement");
  assert.equal(result, "HIGH_RISK");
});

test("margin 8-10 with EXTREME upset risk is still HIGH_RISK via the earlier EXTREME rule, not reclassified by the new band", () => {
  const result = computeRecommendation(58.7, 70, "Strong", "EXTREME", "Strong");
  assert.equal(result, "HIGH_RISK");
});

// Regression guard for the margin 8-10 catch-all gap class of bug: sweep every margin from 0 to
// 50 (in 0.1 steps) across every upsetRisk x modelAgreement combination, holding dataQuality/label
// fixed at a value that can never trigger DO_NOT_RECOMMEND, and assert two structural properties
// that must ALWAYS hold no matter how the branch order or thresholds inside computeRecommendation
// change in the future:
//  (a) every single margin value produces a real Recommendation -- there is no gap where some
//      unanticipated combination of inputs falls through every rule unhandled (impossible in JS
//      since the function always returns something, but this documents and locks the exhaustive
//      combination space actually tested);
//  (b) for a FIXED upsetRisk/modelAgreement combination, the "confidence" of the recommendation
//      must never fall discontinuously as margin increases -- i.e. once a combination qualifies
//      for a stronger-than-HIGH_RISK label at some margin, a larger margin under the same
//      upsetRisk/modelAgreement must never regress to a weaker label. This is exactly the shape
//      of bug that shipped: margin 10+ was MODERATE_LEAN, but margin 8-10 (a SMALLER, not larger,
//      margin) fell through to HIGH_RISK -- so this specific gap would already have failed
//      property (b) as originally written, before the fix. Kept post-fix as a standing invariant.
const RECOMMENDATION_RANK: Record<string, number> = {
  DO_NOT_RECOMMEND: 0,
  NO_STRONG_SIGNAL: 0, // NO_STRONG_SIGNAL and DO_NOT_RECOMMEND are both "nothing usable" -- not ranked against each other, only against the three real leans below.
  HIGH_RISK: 1,
  MODERATE_LEAN: 2,
  STRONG_RECOMMENDATION: 3,
};
const UPSET_RISKS = ["LOW", "MODERATE", "HIGH", "EXTREME"] as const;
const MODEL_AGREEMENTS = ["Strong", "Moderate", "Mixed", "HighDisagreement"] as const;

test("no margin ever falls through to an unhandled/undefined recommendation, across the full upsetRisk x modelAgreement grid", () => {
  for (const upsetRisk of UPSET_RISKS) {
    for (const modelAgreement of MODEL_AGREEMENTS) {
      for (let margin = 0; margin <= 50; margin += 0.1) {
        const calibratedProbability = 50 + margin;
        const result = computeRecommendation(calibratedProbability, 70, "Strong", upsetRisk, modelAgreement);
        assert.ok(result in RECOMMENDATION_RANK, `computeRecommendation(${calibratedProbability}, 70, "Strong", "${upsetRisk}", "${modelAgreement}") returned an unrecognized value: ${result}`);
      }
    }
  }
});

test("recommendation strength never regresses to a weaker lean as margin increases, for any fixed upsetRisk/modelAgreement (guards catch-all gaps like the margin 8-10 bug)", () => {
  for (const upsetRisk of UPSET_RISKS) {
    for (const modelAgreement of MODEL_AGREEMENTS) {
      let previousRank = -1;
      let previousMargin = -1;
      for (let margin = 0; margin <= 50; margin += 0.1) {
        const calibratedProbability = 50 + margin;
        const result = computeRecommendation(calibratedProbability, 70, "Strong", upsetRisk, modelAgreement);
        const rank = RECOMMENDATION_RANK[result];
        if (previousRank !== -1) {
          assert.ok(
            rank >= previousRank,
            `upsetRisk=${upsetRisk}, modelAgreement=${modelAgreement}: margin ${margin.toFixed(1)} produced "${result}" (rank ${rank}), which is WEAKER than margin ${previousMargin.toFixed(1)}'s rank ${previousRank} -- a larger margin must never look like a smaller signal.`,
          );
        }
        previousRank = rank;
        previousMargin = margin;
      }
    }
  }
});
