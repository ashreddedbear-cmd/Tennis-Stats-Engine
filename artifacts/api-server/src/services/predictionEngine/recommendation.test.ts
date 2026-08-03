import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRecommendation } from "./recommendation";

// ── Shorthand helpers ────────────────────────────────────────────────────────
// signature: (calibratedProbability, dataQuality, dataQualityLabel, modelAgreement, tieBreakerApplied?, coreSignalsAlign?)

// ── INSUFFICIENT_EDGE ────────────────────────────────────────────────────────

test("INSUFFICIENT_EDGE: DQ < 25 → regardless of any other input", () => {
  assert.equal(computeRecommendation(85, 20, "Poor", "Strong"), "INSUFFICIENT_EDGE");
  assert.equal(computeRecommendation(85, 24, "Limited", "Strong"), "INSUFFICIENT_EDGE");
});

test("INSUFFICIENT_EDGE: DQ label 'Poor' takes priority even if numeric score is above 25", () => {
  // Label and numeric can diverge in edge cases; label wins when 'Poor'
  assert.equal(computeRecommendation(85, 30, "Poor", "Strong"), "INSUFFICIENT_EDGE");
});

test("INSUFFICIENT_EDGE: tieBreakerApplied=true → regardless of margin or agreement", () => {
  assert.equal(computeRecommendation(57.9, 70, "Strong", "Strong", true), "INSUFFICIENT_EDGE");
  assert.equal(computeRecommendation(61, 70, "Strong", "Strong", true), "INSUFFICIENT_EDGE");
  assert.equal(computeRecommendation(85, 70, "Strong", "Strong", true), "INSUFFICIENT_EDGE");
});

test("INSUFFICIENT_EDGE: tieBreakerApplied=true with poor DQ → INSUFFICIENT_EDGE still (DQ check fires first, same result)", () => {
  assert.equal(computeRecommendation(52, 20, "Poor", "Strong", true), "INSUFFICIENT_EDGE");
});

test("INSUFFICIENT_EDGE: margin < 8 AND Mixed agreement → no reliable edge", () => {
  assert.equal(computeRecommendation(55, 70, "Strong", "Mixed"), "INSUFFICIENT_EDGE");
  assert.equal(computeRecommendation(57.9, 70, "Strong", "Mixed"), "INSUFFICIENT_EDGE");
});

test("INSUFFICIENT_EDGE: margin < 8 AND HighDisagreement → no reliable edge", () => {
  assert.equal(computeRecommendation(55, 70, "Strong", "HighDisagreement"), "INSUFFICIENT_EDGE");
  assert.equal(computeRecommendation(57.9, 70, "Strong", "HighDisagreement"), "INSUFFICIENT_EDGE");
});

test("NOT INSUFFICIENT_EDGE: margin < 8 with Strong agreement → LOW_CONFIDENCE (not caught by small-lean gate)", () => {
  // The INSUFFICIENT_EDGE gate only fires for Mixed/HighDisagreement; Strong agreement passes through
  assert.notEqual(computeRecommendation(55, 70, "Strong", "Strong"), "INSUFFICIENT_EDGE");
  assert.notEqual(computeRecommendation(55, 70, "Strong", "Moderate"), "INSUFFICIENT_EDGE");
});

test("NOT INSUFFICIENT_EDGE: margin exactly 8 with Mixed → passes (gate is margin < 8, not <=)", () => {
  assert.notEqual(computeRecommendation(58, 70, "Strong", "Mixed"), "INSUFFICIENT_EDGE");
});

// ── HIGHEST_CONFIDENCE ───────────────────────────────────────────────────────

test("HIGHEST_CONFIDENCE: margin ≥ 35, DQ ≥ 45, Strong, coreSignalsAlign=true", () => {
  assert.equal(computeRecommendation(85, 70, "Strong", "Strong", false, true), "HIGHEST_CONFIDENCE");
  assert.equal(computeRecommendation(90, 45, "Acceptable", "Strong", false, true), "HIGHEST_CONFIDENCE");
});

test("HIGHEST_CONFIDENCE: margin ≥ 26, DQ ≥ 50, Strong, coreSignalsAlign=true", () => {
  assert.equal(computeRecommendation(76, 50, "Acceptable", "Strong", false, true), "HIGHEST_CONFIDENCE");
  assert.equal(computeRecommendation(76, 70, "Strong", "Strong", false, true), "HIGHEST_CONFIDENCE");
});

test("NOT HIGHEST_CONFIDENCE: coreSignalsAlign=false → can't reach HIGHEST_CONFIDENCE", () => {
  const result = computeRecommendation(85, 70, "Strong", "Strong", false, false);
  assert.notEqual(result, "HIGHEST_CONFIDENCE");
});

test("NOT HIGHEST_CONFIDENCE: Moderate agreement → withheld even with coreSignalsAlign=true and large margin", () => {
  const result = computeRecommendation(85, 70, "Strong", "Moderate", false, true);
  assert.notEqual(result, "HIGHEST_CONFIDENCE");
});

test("NOT HIGHEST_CONFIDENCE: DQ just below 45 threshold blocks the ≥35-margin gate", () => {
  // margin=35, DQ=44 → blocked
  const result = computeRecommendation(85, 44, "Acceptable", "Strong", false, true);
  assert.notEqual(result, "HIGHEST_CONFIDENCE");
});

test("NOT HIGHEST_CONFIDENCE: DQ just below 50 threshold blocks the ≥26-margin gate", () => {
  // margin=26, DQ=49 → blocked
  const result = computeRecommendation(76, 49, "Acceptable", "Strong", false, true);
  assert.notEqual(result, "HIGHEST_CONFIDENCE");
});

// ── HIGH_CONFIDENCE ──────────────────────────────────────────────────────────

test("HIGH_CONFIDENCE: margin ≥ 20 AND Strong agreement", () => {
  assert.equal(computeRecommendation(70, 70, "Strong", "Strong"), "HIGH_CONFIDENCE");
});

test("HIGH_CONFIDENCE: margin ≥ 12 AND Strong agreement", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "Strong"), "HIGH_CONFIDENCE");
});

test("HIGH_CONFIDENCE: margin ≥ 12 AND Moderate agreement", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "Moderate"), "HIGH_CONFIDENCE");
});

test("HIGH_CONFIDENCE: margin ≥ 9 AND Strong agreement", () => {
  assert.equal(computeRecommendation(59, 70, "Strong", "Strong"), "HIGH_CONFIDENCE");
});

test("HIGH_CONFIDENCE guardrail: margin ≥ 40 AND Moderate agreement → HIGH_CONFIDENCE not MODERATE", () => {
  assert.equal(computeRecommendation(90, 70, "Strong", "Moderate"), "HIGH_CONFIDENCE");
});

test("NOT HIGH_CONFIDENCE: margin ≥ 12 with HighDisagreement → MODERATE_CONFIDENCE (real lean but contested)", () => {
  assert.notEqual(computeRecommendation(62, 70, "Strong", "HighDisagreement"), "HIGH_CONFIDENCE");
  assert.equal(computeRecommendation(62, 70, "Strong", "HighDisagreement"), "MODERATE_CONFIDENCE");
});

test("NOT HIGH_CONFIDENCE: margin 9-11 with Moderate agreement → MODERATE_CONFIDENCE not HIGH", () => {
  assert.equal(computeRecommendation(59, 70, "Strong", "Moderate"), "MODERATE_CONFIDENCE");
});

// ── MODERATE_CONFIDENCE ──────────────────────────────────────────────────────

test("MODERATE_CONFIDENCE: margin ≥ 9 AND Moderate agreement", () => {
  assert.equal(computeRecommendation(59, 70, "Strong", "Moderate"), "MODERATE_CONFIDENCE");
  assert.equal(computeRecommendation(61, 70, "Strong", "Moderate"), "MODERATE_CONFIDENCE");
});

test("MODERATE_CONFIDENCE: margin ≥ 12 with Mixed agreement", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "Mixed"), "MODERATE_CONFIDENCE");
});

test("MODERATE_CONFIDENCE: margin ≥ 12 with HighDisagreement", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "HighDisagreement"), "MODERATE_CONFIDENCE");
});

// ── LOW_CONFIDENCE ───────────────────────────────────────────────────────────

test("LOW_CONFIDENCE: fallthrough — margin < 9 with Strong agreement (thin but real lean)", () => {
  assert.equal(computeRecommendation(57.9, 70, "Strong", "Strong"), "LOW_CONFIDENCE");
  assert.equal(computeRecommendation(58, 70, "Strong", "Strong"), "LOW_CONFIDENCE");
});

test("LOW_CONFIDENCE: margin < 9 with Moderate agreement", () => {
  assert.equal(computeRecommendation(57.9, 70, "Strong", "Moderate"), "LOW_CONFIDENCE");
});

test("LOW_CONFIDENCE: margin 8 with Mixed agreement (above INSUFFICIENT_EDGE threshold)", () => {
  assert.equal(computeRecommendation(58, 70, "Strong", "Mixed"), "LOW_CONFIDENCE");
});

test("LOW_CONFIDENCE: margin 8-11.9 with HighDisagreement (above INSUFFICIENT_EDGE threshold, below MODERATE)", () => {
  assert.equal(computeRecommendation(58, 70, "Strong", "HighDisagreement"), "LOW_CONFIDENCE");
  assert.equal(computeRecommendation(61, 70, "Strong", "HighDisagreement"), "LOW_CONFIDENCE");
});

// ── Boundary / regression tests ───────────────────────────────────────────────

test("margin exactly 9 with Strong agreement → HIGH_CONFIDENCE (lower boundary)", () => {
  assert.equal(computeRecommendation(59, 70, "Strong", "Strong"), "HIGH_CONFIDENCE");
});

test("margin exactly 8 with Strong agreement → LOW_CONFIDENCE", () => {
  assert.equal(computeRecommendation(58, 70, "Strong", "Strong"), "LOW_CONFIDENCE");
});

test("margin exactly 12 with Moderate agreement → HIGH_CONFIDENCE", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "Moderate"), "HIGH_CONFIDENCE");
});

test("margin exactly 12 with Mixed agreement → MODERATE_CONFIDENCE", () => {
  assert.equal(computeRecommendation(62, 70, "Strong", "Mixed"), "MODERATE_CONFIDENCE");
});

test("tieBreakerApplied=false (default) → original logic unchanged for sub-8 margin", () => {
  // Regression guard: adding tieBreakerApplied must not change behaviour when false/omitted
  assert.equal(computeRecommendation(53, 70, "Strong", "Strong", false), "LOW_CONFIDENCE");
});

test("high-confidence picks (≥ 90% equivalent) with HighDisagreement are at most MODERATE_CONFIDENCE", () => {
  assert.equal(computeRecommendation(92, 70, "Strong", "HighDisagreement"), "MODERATE_CONFIDENCE");
});

test("high-confidence picks (≥ 90% equivalent) with Mixed are at most MODERATE_CONFIDENCE", () => {
  assert.equal(computeRecommendation(92, 70, "Strong", "Mixed"), "MODERATE_CONFIDENCE");
});

// ── Structural invariants (exhaustive grid) ───────────────────────────────────

const RECOMMENDATION_RANK: Record<string, number> = {
  INSUFFICIENT_EDGE: 0,
  LOW_CONFIDENCE: 1,
  MODERATE_CONFIDENCE: 2,
  HIGH_CONFIDENCE: 3,
  HIGHEST_CONFIDENCE: 4,
};

const MODEL_AGREEMENTS = ["Strong", "Moderate", "Mixed", "HighDisagreement"] as const;
const DATA_QUALITIES = [
  { score: 20, label: "Poor" as const },
  { score: 40, label: "Acceptable" as const },
  { score: 70, label: "Strong" as const },
] as const;

test("no margin / agreement / DQ combination ever produces an unrecognized recommendation", () => {
  for (const { score: dq, label: dqLabel } of DATA_QUALITIES) {
    for (const modelAgreement of MODEL_AGREEMENTS) {
      for (const coreSignalsAlign of [false, true]) {
        for (let margin = 0; margin <= 50; margin += 0.5) {
          const calibratedProbability = 50 + margin;
          const result = computeRecommendation(calibratedProbability, dq, dqLabel, modelAgreement, false, coreSignalsAlign);
          assert.ok(
            result in RECOMMENDATION_RANK,
            `computeRecommendation(${calibratedProbability}, ${dq}, "${dqLabel}", "${modelAgreement}", false, ${coreSignalsAlign}) returned unrecognized: "${result}"`,
          );
        }
      }
    }
  }
});

test("recommendation strength never regresses as margin increases (monotonicity invariant)", () => {
  for (const { score: dq, label: dqLabel } of DATA_QUALITIES) {
    for (const modelAgreement of MODEL_AGREEMENTS) {
      for (const coreSignalsAlign of [false, true]) {
        let previousRank = -1;
        let previousMargin = -1;
        for (let margin = 0; margin <= 50; margin += 0.5) {
          const calibratedProbability = 50 + margin;
          const result = computeRecommendation(calibratedProbability, dq, dqLabel, modelAgreement, false, coreSignalsAlign);
          const rank = RECOMMENDATION_RANK[result];
          if (previousRank !== -1) {
            assert.ok(
              rank >= previousRank,
              `DQ=${dq}/"${dqLabel}", agreement="${modelAgreement}", coreSignalsAlign=${coreSignalsAlign}: ` +
                `margin ${margin.toFixed(1)} produced "${result}" (rank ${rank}), which is WEAKER ` +
                `than margin ${previousMargin.toFixed(1)}'s rank ${previousRank} — a larger margin must never produce a weaker recommendation.`,
            );
          }
          previousRank = rank;
          previousMargin = margin;
        }
      }
    }
  }
});

test("catch-all-gap guard: margin 9–12 with Strong agreement must be at least HIGH_CONFIDENCE", () => {
  // Regression guard for the class of bug where this window mislabels a real lean as the fallthrough bucket.
  // Deliberately hardcodes the assertion independently of computeRecommendation's current implementation.
  for (let margin = 9; margin < 12; margin += 0.1) {
    const calibratedProbability = 50 + margin;
    const result = computeRecommendation(calibratedProbability, 70, "Strong", "Strong");
    assert.equal(
      result,
      "HIGH_CONFIDENCE",
      `margin ${margin.toFixed(1)} with Strong agreement must be HIGH_CONFIDENCE, not "${result}"`,
    );
  }
});
