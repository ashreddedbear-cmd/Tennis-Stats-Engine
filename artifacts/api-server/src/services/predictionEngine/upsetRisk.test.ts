import test from "node:test";
import assert from "node:assert/strict";
import { computeUpsetRisk, type UpsetRiskInput } from "./upsetRisk";
import type { WeightedDisagreement } from "./disagreement";

function disagreement(overrides: Partial<WeightedDisagreement> = {}): WeightedDisagreement {
  return {
    modelAgreement: "Strong",
    weightedStdDev: 2,
    leadingSupportPercent: 90,
    player1SupportPercent: 90,
    coreModelsConflict: false,
    conflictingModels: [],
    ...overrides,
  };
}

function input(overrides: Partial<UpsetRiskInput> = {}): UpsetRiskInput {
  return {
    calibratedProbability: 75, // a clear, comfortable favorite by default
    disagreement: disagreement(),
    rawVsCalibratedConflict: false,
    uncertaintyWarningCount: 0,
    minSurfaceSampleSize: 10,
    tournamentLevel: null,
    ...overrides,
  };
}

test("a comfortable favorite with clean data and full agreement is LOW risk with no contributors", () => {
  const result = computeUpsetRisk(input());
  assert.equal(result.upsetRisk, "LOW");
  assert.deepEqual(result.topContributors, []);
  assert.match(result.note, /LOW/);
});

test("a near-coin-flip probability alone (no other real signal) cannot reach EXTREME -- caps at HIGH", () => {
  // margin < 3 alone maxes favoriteWeakness at 45 (< HIGH_MAX of 55 already caps it at HIGH
  // territory), and the explicit gate additionally refuses EXTREME without a second real signal.
  const result = computeUpsetRisk(input({ calibratedProbability: 51 }));
  assert.notEqual(result.upsetRisk, "EXTREME", "a single weak/missing field must never alone produce EXTREME");
  assert.equal(result.components.favoriteWeakness, 45);
  assert.equal(result.topContributors[0], "favoriteWeakness");
});

test("a genuine core-model conflict (>=2 validated core models pointing at different players) pushes toward EXTREME even with a merely close probability", () => {
  const result = computeUpsetRisk(
    input({
      calibratedProbability: 52,
      disagreement: disagreement({ modelAgreement: "HighDisagreement", coreModelsConflict: true }),
    }),
  );
  assert.equal(result.upsetRisk, "EXTREME");
  assert.equal(result.components.modelConflict, 33); // 8 band + 25 core-conflict bonus
});

test("severe sample-depth gap (zero real matches on this surface for a player) can gate EXTREME alongside a close probability", () => {
  const result = computeUpsetRisk(
    input({
      calibratedProbability: 51,
      minSurfaceSampleSize: 0,
    }),
  );
  assert.equal(result.components.sampleDepth, 10);
  // favoriteWeakness(45) + sampleDepth(10) = 55 -> crosses HIGH_MAX -> EXTREME, and the explicit
  // gate allows it because minSurfaceSampleSize === 0 (severeSampleGap).
  assert.equal(result.upsetRisk, "EXTREME");
});

test("modelAgreement alone (Strong vs HighDisagreement, no core conflict) only nudges the score slightly -- it is not a strong standalone driver", () => {
  const strong = computeUpsetRisk(input({ disagreement: disagreement({ modelAgreement: "Strong" }) }));
  const highDisagreement = computeUpsetRisk(input({ disagreement: disagreement({ modelAgreement: "HighDisagreement" }) }));
  assert.ok(highDisagreement.score - strong.score <= 8, "non-core-conflict modelAgreement bands should only contribute a small amount, per the calibration analysis");
});

test("volatility component only applies to clear favorites (margin>=15) and only for levels with a validated deviation", () => {
  const challengerClear = computeUpsetRisk(input({ calibratedProbability: 80, tournamentLevel: "Challenger" }));
  const challengerClose = computeUpsetRisk(input({ calibratedProbability: 55, tournamentLevel: "Challenger" }));
  const unknownLevel = computeUpsetRisk(input({ calibratedProbability: 80, tournamentLevel: "SomeUnvalidatedLevel" }));

  assert.equal(challengerClear.components.volatility, 7);
  assert.equal(challengerClose.components.volatility, 0, "volatility should not apply when the favorite isn't clear");
  assert.equal(unknownLevel.components.volatility, 0, "unvalidated levels must stay at 0, never a guessed adjustment");
});

test("uncertainty component combines warning count and raw-vs-calibrated conflict, capped at 15", () => {
  const result = computeUpsetRisk(input({ uncertaintyWarningCount: 10, rawVsCalibratedConflict: true }));
  assert.equal(result.components.uncertainty, 15);
});

test("matchupHazard is always 0 -- no fabricated hazard signal", () => {
  const result = computeUpsetRisk(input());
  assert.equal(result.components.matchupHazard, 0);
});

test("note names the real top contributors, never a generic placeholder, whenever risk is above LOW", () => {
  const result = computeUpsetRisk(input({ calibratedProbability: 52, minSurfaceSampleSize: 0 }));
  assert.notEqual(result.upsetRisk, "LOW");
  assert.match(result.note, /favorite's edge is thin|thin surface-history sample/);
});

test("LOW upset risk note says the factor is present but does NOT imply it caused the low rating", () => {
  // 58% → margin 8 → favoriteWeakness 15 → score 15 → LOW.
  // The old template "LOW upset risk, mainly because the favorite's edge is thin" implied
  // the thin edge *causes* low risk (backwards — thin edge is a risk driver, not a safety net).
  const result = computeUpsetRisk(input({ calibratedProbability: 58 }));
  assert.equal(result.upsetRisk, "LOW");
  assert.ok(result.topContributors.includes("favoriteWeakness"), "favoriteWeakness should be a top contributor at margin=8");
  // Must NOT use "mainly because" — that framing implies the factor caused the LOW tier.
  assert.doesNotMatch(result.note, /mainly because/, "LOW tier must not use 'mainly because' framing");
  // Must acknowledge the factor IS present.
  assert.match(result.note, /present|thin edge/, "LOW tier note must still name the contributing factor");
  // Must convey that the risk stays low despite the factor.
  assert.match(result.note, /LOW/);
});

test("LOW upset risk note with no contributors stays on the comfortable-edge branch", () => {
  // 75% → margin 25 → favoriteWeakness 0 → score 0 → LOW, no contributors.
  const result = computeUpsetRisk(input({ calibratedProbability: 75 }));
  assert.equal(result.upsetRisk, "LOW");
  assert.deepEqual(result.topContributors, []);
  assert.match(result.note, /comfortable/);
  assert.doesNotMatch(result.note, /mainly because/);
});

test("modelConflict note names a real core-model direction conflict only when coreModelsConflict is actually true", () => {
  const withCoreConflict = computeUpsetRisk(
    input({
      calibratedProbability: 60, // margin 10, keeps favoriteWeakness a smaller secondary contributor
      disagreement: disagreement({ modelAgreement: "HighDisagreement", coreModelsConflict: true }),
    }),
  );
  assert.ok(withCoreConflict.topContributors.includes("modelConflict"));
  assert.match(withCoreConflict.note, /the core models disagree on direction/);
});

test("modelConflict note falls back to an accurate agreement-band label when the score comes from HighDisagreement alone (no core-model direction conflict)", () => {
  const bandOnly = computeUpsetRisk(
    input({
      calibratedProbability: 60,
      disagreement: disagreement({ modelAgreement: "HighDisagreement", coreModelsConflict: false }),
    }),
  );
  assert.ok(bandOnly.topContributors.includes("modelConflict"));
  assert.doesNotMatch(bandOnly.note, /the core models disagree on direction/);
  // Note may use different phrasing depending on whether the tier is LOW or MODERATE+, but must
  // never falsely claim a direction conflict. Acceptable phrases for the agreement-band case:
  assert.match(bandOnly.note, /partial model disagreement|overall agreement is less than strong/);
});

// ── Calibrated vs raw probability invariant (Task #179 / Task #172 Step 3) ───────────────────
//
// After the applyCalibrationOriented orientation fix (Task #175), the calibrated probability can
// differ substantially from the raw ensemble — e.g. a raw ensemble of 48% (slightly favoring
// player 2 in raw space) maps to ~84% for player 1 after calibration (the PAVA flat-zone effect
// documented in specialist-calibration-audit-and-fix.md). The favoriteWeakness component of
// upsetRisk MUST use the calibrated margin (34 pts, comfortably away from 50%), not the raw
// margin (2 pts, near coin-flip), to correctly reflect actual post-calibration risk.
//
// The separate rawVsCalibratedConflict flag (fed from index.ts's `modelConflict`) captures that
// calibration sent the pick in a different direction — that adds to the `uncertainty` component,
// not to favoriteWeakness. These are two distinct signals; this test verifies they're not confused.

test("calibrated vs raw — favoriteWeakness uses calibratedProbability margin, not raw ensemble margin", () => {
  // Scenario: raw feature modules straddle 50% (HighDisagreement — some favor player 1, some
  // player 2), raw ensemble probability lands near 48%. After applyCalibrationOriented the
  // calibrated probability maps to 84% (the Sackmann flat-zone documented in Task #172).
  //
  // favoriteWeakness with calibrated margin=34 (>=13) → 0 (no favoriteWeakness penalty).
  // favoriteWeakness with raw margin=2 (<3) → would be 45 (maximum penalty, extreme).
  // The test proves upsetRisk correctly reads the CALIBRATED margin.
  const highConfidenceAfterCalibration = computeUpsetRisk(
    input({
      calibratedProbability: 84, // post-orientation calibration (was ~48% raw)
      disagreement: disagreement({
        modelAgreement: "HighDisagreement", // raw modules straddled 50% — correct to reflect raw module state
        coreModelsConflict: false,
      }),
      rawVsCalibratedConflict: true, // calibration flipped the pick direction from raw → reflected in uncertainty
    }),
  );
  assert.equal(
    highConfidenceAfterCalibration.components.favoriteWeakness, 0,
    "margin=34 from calibratedProbability should give zero favoriteWeakness — using raw ~48% would mistakenly score 45",
  );
  // rawVsCalibratedConflict adds 5 to uncertainty, HighDisagreement band adds 8 to modelConflict.
  // Total score: 0 (favoriteWeakness) + 8 (modelConflict band) + 5 (uncertainty) = 13 → LOW.
  assert.equal(highConfidenceAfterCalibration.upsetRisk, "LOW",
    "even with HighDisagreement and a raw↔calibrated flip, a 34-point calibrated margin should be LOW risk");
});

test("calibrated vs raw — inverse: a near-coin-flip calibrated probability registers high favoriteWeakness regardless of any raw ensemble value", () => {
  // Belt-and-suspenders: the function takes calibratedProbability as a named argument, so this is
  // trivially enforced by the interface. Spelled out explicitly so any future refactor that tries
  // to pass rawEnsembleProbability instead fails loudly.
  const nearCoinFlip = computeUpsetRisk(
    input({
      calibratedProbability: 51, // coin-flip calibrated — high risk regardless of raw value
      disagreement: disagreement({ modelAgreement: "Strong" }), // models agree in raw space
      rawVsCalibratedConflict: false,
    }),
  );
  assert.equal(nearCoinFlip.components.favoriteWeakness, 45,
    "calibrated margin=1 must give maximum favoriteWeakness (45) even when raw models agree strongly");
});
