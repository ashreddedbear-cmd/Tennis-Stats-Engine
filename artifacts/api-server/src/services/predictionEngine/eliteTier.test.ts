import test from "node:test";
import assert from "node:assert/strict";
import { computeEliteTier, type EliteTierInputs } from "./eliteTier";

function baseInputs(overrides: Partial<EliteTierInputs> = {}): EliteTierInputs {
  return {
    dataQuality: 80,
    calibratedProbability: 70,
    surfaceEloFavorsPlayer1: true,
    serveReturnFavorsPlayer1: true,
    recentFormFavorsPlayer1: true,
    specialistApplied: true,
    segmentLabel: "ATP-Hard",
    modelConflict: false,
    modelAgreement: "Strong",
    upsetRisk: "LOW",
    eloGapPoints: 80,
    ...overrides,
  };
}

test("every condition satisfied, including the new consistency guardrail, earns Elite", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs());
  assert.equal(isEliteTier, true);
  assert.match(reason, /Elite:/);
});

test("High Disagreement vetoes Elite even when the Elo gap, margin, and every other positive gate qualify", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs({ eloGapPoints: 80, calibratedProbability: 70, modelAgreement: "HighDisagreement" }));
  assert.equal(isEliteTier, false);
  assert.match(reason, /High Disagreement/);
  assert.match(reason, /cannot create Elite on its own, but High Disagreement can still veto it/);
});

test("HIGH upset risk withholds Elite", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs({ upsetRisk: "HIGH" }));
  assert.equal(isEliteTier, false);
  assert.match(reason, /upset risk is HIGH/);
});

test("EXTREME upset risk withholds Elite", () => {
  const { isEliteTier } = computeEliteTier(baseInputs({ upsetRisk: "EXTREME" }));
  assert.equal(isEliteTier, false);
});

test("MODERATE upset risk alone does not withhold Elite -- only High/Extreme do", () => {
  const { isEliteTier } = computeEliteTier(baseInputs({ upsetRisk: "MODERATE" }));
  assert.equal(isEliteTier, true);
});

test("pre-existing gates (data quality, 3-signal agreement, specialist, model conflict) still work unchanged", () => {
  assert.equal(computeEliteTier(baseInputs({ dataQuality: 40 })).isEliteTier, false);
  assert.equal(computeEliteTier(baseInputs({ recentFormFavorsPlayer1: false })).isEliteTier, false);
  assert.equal(computeEliteTier(baseInputs({ specialistApplied: false })).isEliteTier, false);
  assert.equal(computeEliteTier(baseInputs({ modelConflict: true })).isEliteTier, false);
});

// Task #66: three signals agreeing on DIRECTION alone (e.g. each barely above 50%) isn't real
// evidence -- the final calibrated pick must also clear a minimum margin from a coin flip.
test("a near-coin-flip calibrated probability withholds Elite even when all three signals agree on direction", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs({ calibratedProbability: 52 }));
  assert.equal(isEliteTier, false);
  assert.match(reason, /coin flip/);
});

test("a calibrated probability right at the margin floor earns Elite; just under it does not", () => {
  assert.equal(computeEliteTier(baseInputs({ calibratedProbability: 55 })).isEliteTier, true);
  assert.equal(computeEliteTier(baseInputs({ calibratedProbability: 54.9 })).isEliteTier, false);
});

test("the margin gate is symmetric -- a strong lean toward player2 (calibratedProbability far below 50) also earns Elite", () => {
  assert.equal(computeEliteTier(baseInputs({ calibratedProbability: 30 })).isEliteTier, true);
});

// ── 2026-08-13 classification fix: Elo-gap separation gate ──────────────────────────────────

test("Elite requires a Decisive Elo-gap (>=75 points) -- a Thin gap withholds Elite even with everything else perfect", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs({ eloGapPoints: 20 }));
  assert.equal(isEliteTier, false);
  assert.match(reason, /surface-Elo point-gap/);
  assert.match(reason, /"Thin"/);
});

test("Elite requires a Decisive Elo-gap (>=75 points) -- a Caution-band gap (25-50) withholds Elite too", () => {
  const { isEliteTier, reason } = computeEliteTier(baseInputs({ eloGapPoints: 40 }));
  assert.equal(isEliteTier, false);
  assert.match(reason, /"Caution"/);
});

test("Elite requires a Decisive Elo-gap (>=75 points) -- a Modest gap (50-75) still withholds Elite", () => {
  assert.equal(computeEliteTier(baseInputs({ eloGapPoints: 60 })).isEliteTier, false);
});

test("Elite is earned at exactly the 75-point Elo-gap floor and above", () => {
  assert.equal(computeEliteTier(baseInputs({ eloGapPoints: 75 })).isEliteTier, true);
  assert.equal(computeEliteTier(baseInputs({ eloGapPoints: 74.9 })).isEliteTier, false);
});

test("full 6-model agreement/consensus alone cannot earn Elite without a Decisive Elo gap -- consensus confirms strength, it does not create it", () => {
  // Every other gate maximally satisfied (Strong agreement, coreSignalsAlign via all-true signals,
  // LOW upset risk, specialist applied, no conflict) but the underlying player separation is thin.
  const { isEliteTier } = computeEliteTier(
    baseInputs({ eloGapPoints: 10, calibratedProbability: 95, modelAgreement: "Strong" }),
  );
  assert.equal(isEliteTier, false);
});

test("the Elo-gap gate is symmetric in sign -- a negative eloGapPoints (player2-favoring) magnitude is what's checked, not its sign", () => {
  assert.equal(computeEliteTier(baseInputs({ eloGapPoints: -80 })).isEliteTier, true);
  assert.equal(computeEliteTier(baseInputs({ eloGapPoints: -10 })).isEliteTier, false);
});
