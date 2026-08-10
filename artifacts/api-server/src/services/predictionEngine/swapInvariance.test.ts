/**
 * Swap-Invariance Test
 *
 * If the engine is swap-invariant, calling it with (A, B) and then (B, A)
 * must produce the same predicted winner and mirrored probabilities:
 *   P(A wins | A=player1) ≈ 100 - P(A wins | A=player2)
 *
 * Calibration orientation fix (2026-08-09): training now uses predicted-winner
 * space (x = max(raw, 1-raw), outcome = predicted winner won). The
 * applyCalibrationOriented helper re-orients at inference time, guaranteeing
 * swap symmetry by construction: for any raw r,
 *   orientedX = max(r, 1-r)  ←  same for both slot assignments
 *   calibratedConfidence = applyCalibration(knots, orientedX)
 *   output = predictedPlayer1 ? calibratedConfidence : 1 - calibratedConfidence
 * So P(A|A=p1) + P(A|A=p2) = calibratedConfidence + (1 - calibratedConfidence) = 1.
 *
 * These tests use placeholder calibration knots in [0.5, 1.0] predicted-winner
 * space that represent a plausible correctly-oriented calibration. The real
 * calibration model will be refit by the next walk-forward run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPredictionEngine } from "./index.js";
import type { PredictionEngineInput } from "./types.js";
import type { PlayerProfile, MatchRecord, HeadToHeadRecord } from "../tennisData/types.js";

// ─── Placeholder calibration knots in predicted-winner space ─────────────────
// x = model confidence in predicted winner (always in [0.5, 1.0])
// y = P(predicted winner actually wins | that confidence)
// These represent a realistic calibration that slightly compresses extremes.
// The stale wrong-orientation model (id=711, isActive was set false on 2026-08-09)
// was trained in player1 space and must NOT be used here.
const PLACEHOLDER_GENERAL_CALIBRATION: { x: number; y: number }[] = [
  { x: 0,   y: 0.50 }, // anchor — never queried (inference always orients to x>=0.5)
  { x: 0.5, y: 0.50 }, // at exactly 50/50 raw, calibration is also 50/50
  { x: 0.6, y: 0.58 },
  { x: 0.7, y: 0.65 },
  { x: 0.8, y: 0.72 },
  { x: 0.9, y: 0.78 },
  { x: 1.0, y: 0.82 },
];

const PLACEHOLDER_SPECIALIST_CALIBRATION: { x: number; y: number }[] = [
  { x: 0,   y: 0.50 },
  { x: 0.5, y: 0.50 },
  { x: 0.6, y: 0.59 },
  { x: 0.7, y: 0.66 },
  { x: 0.8, y: 0.73 },
  { x: 0.9, y: 0.79 },
  { x: 1.0, y: 0.83 },
];

// ─── Helper: build a player profile ──────────────────────────────────────────
function makePlayer(id: string, name: string, rank: number): PlayerProfile {
  return { id, name, currentRank: rank, age: 28, plays: "Right-Handed", fullName: name, countryCode: null, tour: "ATP" };
}

// ─── Helper: build match records ──────────────────────────────────────────────
function makeMatch(
  opponentId: string,
  opponentName: string,
  opponentRank: number,
  result: "W" | "L",
  surface: "Hard" | "Clay" | "Grass",
  year: number,
  idx: number,
): MatchRecord {
  return {
    id: `m-${opponentId}-${year}-${idx}`,
    date: `${year}-06-${String(10 + idx).padStart(2, "0")}`,
    tournamentName: "Test Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface,
    indoor: false,
    opponentId,
    opponentName,
    opponentRank,
    result,
    score: result === "W" ? "6-3 6-4" : "3-6 4-6",
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins:
      result === "W"
        ? [
            { playerGames: 6, opponentGames: 3 },
            { playerGames: 6, opponentGames: 4 },
          ]
        : [
            { playerGames: 3, opponentGames: 6 },
            { playerGames: 4, opponentGames: 6 },
          ],
  };
}

function buildInput(player1: PlayerProfile, player2: PlayerProfile, p1Matches: MatchRecord[], p2Matches: MatchRecord[]): PredictionEngineInput {
  const h2h: HeadToHeadRecord = { player1Id: player1.id, player2Id: player2.id, meetings: [] };
  return {
    player1,
    player2,
    player1Matches: p1Matches,
    player2Matches: p2Matches,
    headToHead: h2h,
    surface: "Hard",
    matchFormat: "BestOf3",
    activeCalibration: PLACEHOLDER_GENERAL_CALIBRATION,
    segment: {
      segmentKey: "ATP-Hard",
      label: "ATP-Hard",
      meetsThreshold: true,
      historicalMatchCount: 18064,
      validationSampleSize: 18064,
      minHistoricalMatches: 200,
      minValidationSamples: 200,
      calibrationMapping: PLACEHOLDER_SPECIALIST_CALIBRATION,
      weight: 0.702,
    },
  };
}

const weakPlayer = makePlayer("weak-001", "Weak Player", 180);
const strongPlayer = makePlayer("strong-001", "Strong Player", 8);

// Weak player's Hard court record: 1W, 5L vs top-60 opponents
const weakMatches: MatchRecord[] = [
  makeMatch("opp-a", "Opponent Alpha", 45, "W", "Hard", 2025, 1),
  makeMatch("opp-b", "Opponent Beta", 40, "L", "Hard", 2025, 2),
  makeMatch("opp-c", "Opponent Gamma", 55, "L", "Hard", 2025, 3),
  makeMatch("opp-d", "Opponent Delta", 60, "L", "Hard", 2025, 4),
  makeMatch("opp-e", "Opponent Epsilon", 50, "L", "Hard", 2025, 5),
  makeMatch("opp-f", "Opponent Zeta", 48, "L", "Hard", 2025, 6),
];

// Strong player's Hard court record: 16W, 4L vs top-50 opponents
const strongMatches: MatchRecord[] = [
  makeMatch("opp-b", "Opponent Beta", 40, "W", "Hard", 2025, 1),
  makeMatch("opp-c", "Opponent Gamma", 55, "W", "Hard", 2025, 2),
  makeMatch("opp-d", "Opponent Delta", 60, "W", "Hard", 2025, 3),
  makeMatch("opp-e", "Opponent Epsilon", 50, "W", "Hard", 2025, 4),
  makeMatch("opp-f", "Opponent Zeta", 48, "L", "Hard", 2025, 5),
  makeMatch("opp-g", "Opponent Eta", 35, "W", "Hard", 2025, 6),
  makeMatch("opp-h", "Opponent Theta", 22, "W", "Hard", 2025, 7),
  makeMatch("opp-i", "Opponent Iota", 30, "L", "Hard", 2025, 8),
  makeMatch("opp-j", "Opponent Kappa", 25, "W", "Hard", 2025, 9),
  makeMatch("opp-k", "Opponent Lambda", 15, "W", "Hard", 2025, 10),
  makeMatch("opp-l", "Opponent Mu", 18, "W", "Hard", 2025, 11),
  makeMatch("opp-m", "Opponent Nu", 20, "L", "Hard", 2025, 12),
  makeMatch("opp-n", "Opponent Xi", 28, "W", "Hard", 2025, 13),
  makeMatch("opp-o", "Opponent Omicron", 33, "W", "Hard", 2025, 14),
  makeMatch("opp-p", "Opponent Pi", 42, "W", "Hard", 2025, 15),
  makeMatch("opp-q", "Opponent Rho", 38, "W", "Hard", 2025, 16),
  makeMatch("opp-r", "Opponent Sigma", 27, "W", "Hard", 2025, 17),
  makeMatch("opp-s", "Opponent Tau", 19, "W", "Hard", 2025, 18),
  makeMatch("opp-t", "Opponent Upsilon", 44, "W", "Hard", 2025, 19),
  makeMatch("opp-u", "Opponent Phi", 31, "L", "Hard", 2025, 20),
];

test("swap-invariance forward: raw ensemble for weak-as-player1", async () => {
  const input = buildInput(weakPlayer, strongPlayer, weakMatches, strongMatches);
  const output = await runPredictionEngine(input);

  const rawEnsemble = output.rawEnsembleProbability / 100;
  const calibrated = output.calibratedProbability;
  const predictedWinner = output.predictedWinnerId;

  console.log(`[FORWARD] raw ensemble P(weak=player1): ${(rawEnsemble * 100).toFixed(2)}%`);
  console.log(`[FORWARD] calibrated P(weak=player1):   ${calibrated.toFixed(2)}%`);
  console.log(`[FORWARD] predicted winner: ${predictedWinner}`);

  (globalThis as any).__fwdRaw = rawEnsemble;
  (globalThis as any).__fwdCalibrated = calibrated;
  (globalThis as any).__fwdWinner = predictedWinner;

  // Raw should strongly favour the strong player — weak player is rank 180 vs rank 8
  assert.ok(rawEnsemble < 0.5, `Expected raw to favour strong player, got ${(rawEnsemble * 100).toFixed(1)}% for weak`);
});

test("swap-invariance swapped: same matchup reversed — assert symmetry ≤ 2pp", async () => {
  const h2hSwapped: HeadToHeadRecord = { player1Id: strongPlayer.id, player2Id: weakPlayer.id, meetings: [] };
  const swappedInput: PredictionEngineInput = {
    player1: strongPlayer,
    player2: weakPlayer,
    player1Matches: strongMatches,
    player2Matches: weakMatches,
    headToHead: h2hSwapped,
    surface: "Hard",
    matchFormat: "BestOf3",
    activeCalibration: PLACEHOLDER_GENERAL_CALIBRATION,
    segment: {
      segmentKey: "ATP-Hard",
      label: "ATP-Hard",
      meetsThreshold: true,
      historicalMatchCount: 18064,
      validationSampleSize: 18064,
      minHistoricalMatches: 200,
      minValidationSamples: 200,
      calibrationMapping: PLACEHOLDER_SPECIALIST_CALIBRATION,
      weight: 0.702,
    },
  };

  const output = await runPredictionEngine(swappedInput);

  const rawEnsemble = output.rawEnsembleProbability / 100;
  const calibrated = output.calibratedProbability;
  const predictedWinner = output.predictedWinnerId;

  console.log(`[SWAPPED] raw ensemble P(strong=player1): ${(rawEnsemble * 100).toFixed(2)}%`);
  console.log(`[SWAPPED] calibrated P(strong=player1):   ${calibrated.toFixed(2)}%`);
  console.log(`[SWAPPED] predicted winner: ${predictedWinner}`);

  const fwdRaw: number = (globalThis as any).__fwdRaw ?? NaN;
  const fwdCalibrated: number = (globalThis as any).__fwdCalibrated ?? NaN;
  const fwdWinner: string = (globalThis as any).__fwdWinner ?? "?";

  const rawSum = fwdRaw * 100 + rawEnsemble * 100;
  const calibSum = fwdCalibrated + calibrated;

  console.log(`\n═══ SWAP SYMMETRY ═══`);
  console.log(`Raw sum:        ${rawSum.toFixed(2)} (expect ~100)`);
  console.log(`Calibrated sum: ${calibSum.toFixed(2)} (expect ~100 after orientation fix)`);
  console.log(`Same winner: fwd=${fwdWinner} swapped=${predictedWinner} → ${fwdWinner === predictedWinner ? "✓" : "✗"}`);

  // Raw ensemble is always symmetric (confirmed pre-fix)
  assert.ok(Math.abs(rawSum - 100) < 2,
    `Raw ensemble symmetry broken: sum=${rawSum.toFixed(2)}, expected ~100`);

  // Calibrated output must now be symmetric after the orientation fix.
  // Mathematically guaranteed: applyCalibrationOriented(knots, r) + applyCalibrationOriented(knots, 1-r) = 1
  // Tolerance is 2pp to account for rounding in the 0.1%-precision output rounding.
  assert.ok(Math.abs(calibSum - 100) < 2,
    `Calibrated swap asymmetry = ${Math.abs(calibSum - 100).toFixed(1)}pp (limit 2pp). ` +
    `Orientation fix may not have reached all applyCalibration call sites.`);

  // The predicted winner must be the same player regardless of slot assignment
  assert.strictEqual(fwdWinner, predictedWinner,
    `Predicted winner flipped on slot swap: fwd=${fwdWinner}, swapped=${predictedWinner}. ` +
    `Orientation fix may not have reached all applyCalibration call sites.`);
});

// ─── Calibrated-not-raw invariants ───────────────────────────────────────────
//
// Guard: a future change must not accidentally wire recommendation / predicted-
// winner logic to rawEnsembleProbability instead of calibratedProbability.
//
// Two scenarios:
//   A) Flat-zone floor: near-even matchup (raw ≈ 50%) — calibration's flat-zone
//      floor lifts output to ~56%.  Pick and margin must use the lifted value.
//   B) Knots-determine-output: same matchup, two different calibration curves →
//      calibratedProbability changes while rawEnsembleProbability stays the same.

// ─── Flat-zone calibration knots (mirrors model #712 left-tail plateau) ──────
// x ∈ [0, 0.52] → y = 0.56 (floor).  Higher-confidence inputs are compressed.
const FLAT_ZONE_CALIBRATION: { x: number; y: number }[] = [
  { x: 0.00, y: 0.56 },
  { x: 0.52, y: 0.56 },
  { x: 0.60, y: 0.62 },
  { x: 0.70, y: 0.68 },
  { x: 0.80, y: 0.74 },
  { x: 1.00, y: 0.80 },
];

// ─── Alternative calibration knots (identity-like, minimal lift) ─────────────
// Used in scenario B to confirm the output tracks the active knots.
const IDENTITY_LIKE_CALIBRATION: { x: number; y: number }[] = [
  { x: 0.00, y: 0.50 },
  { x: 0.50, y: 0.50 },
  { x: 0.60, y: 0.60 },
  { x: 0.70, y: 0.70 },
  { x: 0.80, y: 0.80 },
  { x: 1.00, y: 0.90 },
];

// ─── Near-even matchup players ────────────────────────────────────────────────
// Rank 50 vs 52 with symmetric win/loss records → raw ensemble ≈ 50%.
// Some modules will say >50% for player A, others <50% — straddling 50% in
// raw space — while the calibrated output is lifted above 50% by the flat zone.
const playerA = makePlayer("even-a", "Player A", 50);
const playerB = makePlayer("even-b", "Player B", 52);

function makeSymmetricMatches(prefix: string): MatchRecord[] {
  // 3W / 3L vs similar-ranked opponents — produces near-50% form signal.
  return [
    makeMatch(`${prefix}-opp-1`, "Opp One",   48, "W", "Hard", 2025, 1),
    makeMatch(`${prefix}-opp-2`, "Opp Two",   51, "L", "Hard", 2025, 2),
    makeMatch(`${prefix}-opp-3`, "Opp Three", 53, "W", "Hard", 2025, 3),
    makeMatch(`${prefix}-opp-4`, "Opp Four",  47, "L", "Hard", 2025, 4),
    makeMatch(`${prefix}-opp-5`, "Opp Five",  50, "W", "Hard", 2025, 5),
    makeMatch(`${prefix}-opp-6`, "Opp Six",   49, "L", "Hard", 2025, 6),
  ];
}

test("calibrated-not-raw A: near-50% raw ensemble is lifted by flat-zone calibration — pick and calibratedProbability use calibrated value, not raw", async () => {
  const h2h: HeadToHeadRecord = { player1Id: playerA.id, player2Id: playerB.id, meetings: [] };
  const input: PredictionEngineInput = {
    player1: playerA,
    player2: playerB,
    player1Matches: makeSymmetricMatches("a"),
    player2Matches: makeSymmetricMatches("b"),
    headToHead: h2h,
    surface: "Hard",
    matchFormat: "BestOf3",
    activeCalibration: FLAT_ZONE_CALIBRATION,
    // No segment specialist — isolates the general calibration path.
  };

  const out = await runPredictionEngine(input);

  console.log(`[FLAT-ZONE] raw ensemble P(A=p1):  ${out.rawEnsembleProbability.toFixed(2)}%`);
  console.log(`[FLAT-ZONE] calibrated P(A=p1):    ${out.calibratedProbability.toFixed(2)}%`);
  console.log(`[FLAT-ZONE] predicted winner:       ${out.predictedWinnerId}`);

  // 1. Near-even matchup → raw ensemble must be close to 50%.
  //    Modules will straddle 50% (some >50%, some <50%) by construction.
  assert.ok(
    Math.abs(out.rawEnsembleProbability - 50) <= 12,
    `Expected near-even raw ensemble (within 12pp of 50%), got ${out.rawEnsembleProbability.toFixed(1)}%. ` +
    `Check that playerA/playerB are equivalently matched.`,
  );

  // 2. Calibration must actually be applied: calibratedProbability must differ
  //    from rawEnsembleProbability by more than rounding noise.
  //    The flat-zone floor guarantees a minimum ~6pp lift for any raw ≤ 52%.
  assert.notStrictEqual(
    Math.round(out.calibratedProbability),
    Math.round(out.rawEnsembleProbability),
    `calibratedProbability (${out.calibratedProbability.toFixed(1)}%) must differ from ` +
    `rawEnsembleProbability (${out.rawEnsembleProbability.toFixed(1)}%). ` +
    `If these are equal, calibration is not being applied — check that activeCalibration ` +
    `is wired into generalProbability and that applyCalibrationOriented is called.`,
  );

  // 3. predictedWinnerId must be determined by calibratedProbability (≥50% → player1),
  //    NOT by rawEnsembleProbability.
  //    This is the core guard: if someone accidentally wires the pick to raw, a near-50%
  //    raw ensemble that calibrates to 56% would still assign the correct winner via
  //    calibrated, but would produce the wrong result via raw when raw < 50%.
  const calibratedFavorsA = out.calibratedProbability >= 50;
  const predictedIsA = out.predictedWinnerId === playerA.id;
  assert.strictEqual(
    predictedIsA,
    calibratedFavorsA,
    `predictedWinnerId must match the calibratedProbability direction. ` +
    `Got winner=${out.predictedWinnerId}, calibrated=${out.calibratedProbability.toFixed(1)}% ` +
    `(favours ${calibratedFavorsA ? "A=player1" : "B=player2"}).`,
  );

  // 4. Calibrated margin must reflect the flat-zone lift (not the raw near-0 margin).
  //    With flat zone y=0.56 and raw ≤ 52%, expected calibrated output ≈ 56%/44%.
  //    Calibrated margin should be ≥ 4pp regardless of which side of 50% raw lands on.
  const calMargin = Math.abs(out.calibratedProbability - 50);
  assert.ok(
    calMargin >= 4,
    `Calibrated margin (${calMargin.toFixed(1)}pp) should be ≥ 4pp for a flat-zone calibration ` +
    `applied to a near-50% raw ensemble. If it is near 0pp, the raw value is being used instead.`,
  );
});

test("calibrated-not-raw B: changing calibration knots changes calibratedProbability but not rawEnsembleProbability", async () => {
  // Run the strong-vs-weak matchup (well-separated, not a coin flip) with two
  // different calibration curves.  Only calibratedProbability should change.
  const base = buildInput(weakPlayer, strongPlayer, weakMatches, strongMatches);

  const inputFlat: PredictionEngineInput = {
    ...base,
    activeCalibration: FLAT_ZONE_CALIBRATION,
    segment: undefined, // no specialist — keep only the general calibration variable
  };
  const inputIdentity: PredictionEngineInput = {
    ...base,
    activeCalibration: IDENTITY_LIKE_CALIBRATION,
    segment: undefined,
  };

  const [outFlat, outIdentity] = await Promise.all([
    runPredictionEngine(inputFlat),
    runPredictionEngine(inputIdentity),
  ]);

  console.log(`[KNOT-B flat]     raw=${outFlat.rawEnsembleProbability.toFixed(2)}%  cal=${outFlat.calibratedProbability.toFixed(2)}%`);
  console.log(`[KNOT-B identity] raw=${outIdentity.rawEnsembleProbability.toFixed(2)}%  cal=${outIdentity.calibratedProbability.toFixed(2)}%`);

  // Raw ensemble must be identical — it does not depend on calibration knots.
  assert.strictEqual(
    outFlat.rawEnsembleProbability,
    outIdentity.rawEnsembleProbability,
    `rawEnsembleProbability must be identical across calibration variants. ` +
    `Got flat=${outFlat.rawEnsembleProbability}, identity=${outIdentity.rawEnsembleProbability}. ` +
    `Raw ensemble must not depend on calibration knots.`,
  );

  // Calibrated output must differ — the two curves produce different outputs.
  // FLAT_ZONE compresses high confidence; IDENTITY_LIKE passes it through.
  // For a strongly-favoured prediction (strong vs weak), the gap should be visible.
  assert.notStrictEqual(
    Math.round(outFlat.calibratedProbability),
    Math.round(outIdentity.calibratedProbability),
    `calibratedProbability must differ between FLAT_ZONE and IDENTITY_LIKE calibration. ` +
    `Got flat=${outFlat.calibratedProbability.toFixed(1)}%, identity=${outIdentity.calibratedProbability.toFixed(1)}%. ` +
    `If they are equal, calibration knots are not being respected — check applyCalibrationOriented call sites.`,
  );

  // Both predicted winners must agree on direction (calibration is direction-preserving).
  assert.strictEqual(
    outFlat.predictedWinnerId,
    outIdentity.predictedWinnerId,
    `Predicted winner must be the same under both calibration curves. ` +
    `applyCalibrationOriented preserves direction by construction. ` +
    `Got flat=${outFlat.predictedWinnerId}, identity=${outIdentity.predictedWinnerId}.`,
  );
});
