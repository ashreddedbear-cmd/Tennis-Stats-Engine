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

test("DATA_INCOMPLETE: close-call gate with a defaulted input is distinct from a genuine no-edge result", () => {
  assert.equal(computeRecommendation(50, 20, "Poor", "Strong", true, false, true), "DATA_INCOMPLETE");
  assert.equal(computeRecommendation(50, 70, "Strong", "Strong", true, false, false), "INSUFFICIENT_EDGE");
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

test("HIGHEST_CONFIDENCE: DQ gate removed — margin ≥ 35 AND Strong AND coreSignalsAlign reaches HIGHEST_CONFIDENCE regardless of DQ (Ticket 3)", () => {
  // DQ gate removed 2026-08-08 (Ticket 3): Limited DQ outperforms Excellent DQ on held-out data.
  // margin=35, DQ=44 → was blocked by old gate, now passes through to HIGHEST_CONFIDENCE.
  const result = computeRecommendation(85, 44, "Acceptable", "Strong", false, true);
  assert.equal(result, "HIGHEST_CONFIDENCE");
});

test("HIGHEST_CONFIDENCE: DQ gate removed — margin ≥ 26 AND Strong AND coreSignalsAlign reaches HIGHEST_CONFIDENCE regardless of DQ (Ticket 3)", () => {
  // DQ gate removed 2026-08-08 (Ticket 3): Limited DQ outperforms Excellent DQ on held-out data.
  // margin=26, DQ=49 → was blocked by old gate, now passes through to HIGHEST_CONFIDENCE.
  const result = computeRecommendation(76, 49, "Acceptable", "Strong", false, true);
  assert.equal(result, "HIGHEST_CONFIDENCE");
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

// ── Calibrated vs raw probability invariant (Task #179 / Task #172 Step 3) ───────────────────
//
// After the applyCalibrationOriented orientation fix (Task #175), the calibrated probability can
// differ substantially from the raw ensemble — e.g. a raw ensemble of 48% maps to ~84% after
// calibration (the Sackmann flat-zone effect). The recommendation margin MUST use
// calibratedProbability (34 pts from 50% here), not the raw ensemble value (2 pts from 50%).
//
// The critical failure mode this guards: if recommendation.ts used rawEnsembleProbability for
// its margin calculation, a calibrated 84% pick with HighDisagreement (from raw modules
// straddling 50%) would incorrectly fire the "margin < 8 AND HighDisagreement → INSUFFICIENT_EDGE"
// gate (raw margin ≈ 2). Calibrated margin = 34 is well above that gate, so INSUFFICIENT_EDGE
// must NOT fire and the result should be MODERATE_CONFIDENCE or better.

test("calibrated vs raw — recommendation uses calibratedProbability for margin, not raw ensemble probability", () => {
  // Scenario: raw feature modules straddle 50% (HighDisagreement — some favor player 1, some
  // player 2). The raw ensemble probability lands near 48% (margin ≈ 2 from 50%). After
  // applyCalibrationOriented the calibrated probability maps to 84% (margin = 34 from 50%).
  //
  // If recommendation.ts mistakenly used raw probability for margin:
  //   → margin ≈ 2, HighDisagreement → INSUFFICIENT_EDGE (via the margin < 8 gate)
  // Correctly using calibratedProbability:
  //   → margin = 34, HighDisagreement → MODERATE_CONFIDENCE (margin >= 12 fallthrough)
  const result = computeRecommendation(
    84,              // calibratedProbability — post-applyCalibrationOriented (was ~48% raw)
    70,              // dataQuality — well above the Poor gate
    "Strong",        // dataQualityLabel
    "HighDisagreement", // raw feature modules straddled 50%; featureAgreement reflects raw module votes
  );
  // The INSUFFICIENT_EDGE gate (margin < 8 AND HighDisagreement) must NOT fire when
  // calibratedProbability is 84 — the margin is 34, not 2.
  assert.notEqual(
    result, "INSUFFICIENT_EDGE",
    "recommendation must use calibrated margin (34pts), not raw (≈2pts) — using raw would incorrectly fire INSUFFICIENT_EDGE",
  );
  // With calibrated margin=34 and HighDisagreement, the result should be MODERATE_CONFIDENCE.
  assert.equal(result, "MODERATE_CONFIDENCE");
});

test("calibrated vs raw — inverse: near-coin-flip calibrated probability fires INSUFFICIENT_EDGE even when raw ensemble was high", () => {
  // Belt-and-suspenders for the inverse direction: calibrated near 50% with Mixed agreement
  // must fire INSUFFICIENT_EDGE regardless of any hypothetical raw ensemble value.
  // The function takes calibratedProbability as a named argument, so this is trivially enforced
  // by the interface. Spelled out so any future refactor that swaps in rawEnsembleProbability fails.
  const result = computeRecommendation(
    56,    // calibratedProbability near 50 (margin = 6, below the 8-point gate)
    70,    // dataQuality
    "Strong",
    "HighDisagreement", // Mixed models at a thin margin → no reliable edge
  );
  assert.equal(result, "INSUFFICIENT_EDGE",
    "calibrated margin=6 with HighDisagreement must be INSUFFICIENT_EDGE — calibrated margin drives the gate, not a hypothetical raw value");
});
