// Unit tests for the Phase 7 point-by-point Monte Carlo match simulator. Verifies real tennis
// scoring behaves correctly at the boundaries (deuce, tiebreak, best-of-3 vs best-of-5), that a
// symmetric matchup produces a genuinely centered outcome, and that uncertainty-aware sampling
// widens the reported range as input reliability drops -- never a single false-precision number.
// Run with: pnpm --filter @workspace/api-server run test:evaluation
import test from "node:test";
import assert from "node:assert/strict";
import { simulateMatch, runMatchSimulation, deriveServicePointEstimate, deriveMatchSeed, type ServicePointEstimate } from "./simulator";
import type { SurfaceEloResult } from "./surfaceElo";
import type { ServeReturnResult } from "./serveReturn";
import { asFraction, asPercentage } from "./units";

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("simulateMatch: a heavily-favored server almost always wins, respecting best-of-3 (max 3 sets)", () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 20; i++) {
    const result = simulateMatch(0.95, 0.3, "BestOf3", rng);
    assert.ok(result.setScores.length <= 3, "best-of-3 must never play a 4th set");
    assert.ok(result.setsWonPlayer1 === 2 || result.setsWonPlayer2 === 2, "match must end once a player reaches 2 sets");
  }
});

test("simulateMatch: best-of-5 allows up to 5 sets and requires 3 to win", () => {
  const rng = mulberry32(7);
  let sawMoreThanThreeSets = false;
  for (let i = 0; i < 60; i++) {
    const result = simulateMatch(0.55, 0.5, "BestOf5", rng);
    assert.ok(result.setScores.length <= 5, "best-of-5 must never play a 6th set");
    assert.ok(result.setsWonPlayer1 === 3 || result.setsWonPlayer2 === 3, "match must end once a player reaches 3 sets");
    if (result.setScores.length > 3) sawMoreThanThreeSets = true;
  }
  assert.ok(sawMoreThanThreeSets, "a competitive best-of-5 run should occasionally go the distance");
});

test("simulateMatch: every set is won by at least 2 games, or resolved by a tiebreak at 7-6", () => {
  const rng = mulberry32(123);
  for (let i = 0; i < 30; i++) {
    const result = simulateMatch(0.65, 0.6, "BestOf3", rng);
    for (const set of result.setScores) {
      const margin = Math.abs(set.player1Games - set.player2Games);
      const isTiebreakSet = set.player1Games === 7 || set.player2Games === 7;
      assert.ok(margin >= 2 || isTiebreakSet, `invalid set score ${set.player1Games}-${set.player2Games}`);
      assert.ok(Math.max(set.player1Games, set.player2Games) <= 7, `set score exceeds 7 games: ${set.player1Games}-${set.player2Games}`);
    }
  }
});

test("runMatchSimulation: a perfectly symmetric matchup centers close to 50% and set-score probabilities sum near 100%", () => {
  const estimate: ServicePointEstimate = {
    player1ServicePointProbability: 0.63,
    player2ServicePointProbability: 0.63,
    reliability: 80,
    note: "test",
  };
  const result = runMatchSimulation(estimate, "BestOf3", { seed: 1, outerDraws: 150, innerSimulationsPerDraw: 80 });

  assert.ok(Math.abs(result.player1WinProbability - 50) < 6, `expected near-50% for a symmetric matchup, got ${result.player1WinProbability}`);
  assert.ok(result.rangeLow <= result.player1WinProbability && result.player1WinProbability <= result.rangeHigh, "point estimate must fall within its own range");
  assert.ok(result.rangeLow < result.rangeHigh, "range must be a genuine spread, not a single point");

  const totalSetScoreProbability = result.setScoreDistribution.reduce((sum, s) => sum + s.probability, 0);
  assert.ok(Math.abs(totalSetScoreProbability - 100) < 1, `set score distribution should sum to ~100%, got ${totalSetScoreProbability}`);
});

test("runMatchSimulation: lower input reliability produces a wider uncertainty range", () => {
  const highReliability: ServicePointEstimate = { player1ServicePointProbability: 0.65, player2ServicePointProbability: 0.6, reliability: 95, note: "test" };
  const lowReliability: ServicePointEstimate = { player1ServicePointProbability: 0.65, player2ServicePointProbability: 0.6, reliability: 10, note: "test" };

  const highRelResult = runMatchSimulation(highReliability, "BestOf3", { seed: 5, outerDraws: 150, innerSimulationsPerDraw: 60 });
  const lowRelResult = runMatchSimulation(lowReliability, "BestOf3", { seed: 5, outerDraws: 150, innerSimulationsPerDraw: 60 });

  const highRelSpread = highRelResult.rangeHigh - highRelResult.rangeLow;
  const lowRelSpread = lowRelResult.rangeHigh - lowRelResult.rangeLow;
  assert.ok(lowRelSpread > highRelSpread, `low-reliability inputs (${lowRelSpread}) should widen the range vs high-reliability inputs (${highRelSpread})`);
});

test("deriveServicePointEstimate: never fabricates certainty beyond the weaker of its two real input signals", () => {
  const surfaceElo: SurfaceEloResult = {
    player1SurfaceElo: 1600,
    player2SurfaceElo: 1500,
    eloDifference: 100,
    eloWinProbabilityPlayer1: asPercentage(64),
    rawEloWinProbabilityPlayer1: asPercentage(64),
    reliability: asPercentage(90),
    sampleSizePlayer1: 40,
    sampleSizePlayer2: 35,
    effectiveSampleSizePlayer1: 30,
    effectiveSampleSizePlayer2: 25,
    player1OverallElo: 1600,
    player2OverallElo: 1500,
    player1SurfaceOnlyElo: 1600,
    player2SurfaceOnlyElo: 1500,
    player1BlendWeight: asFraction(0.05),
    player2BlendWeight: asFraction(0.05),
    player1TourLevelShare: asFraction(1),
    player2TourLevelShare: asFraction(1),
    defaulted: false,
    warnings: [],
  };
  const emptyPointLevel = { firstServeWinPct: null, breakPointsSavedPct: null, breakPointsConvertedPct: null, serviceGamesHeldPct: null, sampleSize: 0 };
  const serveReturn: ServeReturnResult = {
    player1ServeRating: 55,
    player2ServeRating: 48,
    player1ReturnRating: 52,
    player2ReturnRating: 47,
    player1PointLevel: emptyPointLevel,
    player2PointLevel: emptyPointLevel,
    reliability: 20,
    note: null,
    defaulted: false,
    warnings: [],
  };

  const estimate = deriveServicePointEstimate(surfaceElo, serveReturn);
  assert.equal(estimate.reliability, 20, "simulator reliability must inherit the weaker (serveReturn) signal, never the stronger one");
  assert.ok(estimate.player1ServicePointProbability > 0.45 && estimate.player1ServicePointProbability < 0.85, "service point probability must stay within a realistic tour range");
  assert.ok(estimate.note.length > 0, "must always explain that this is a derived, not point-tracked, estimate");
});

test("deriveMatchSeed: identical match identity always yields the same seed", () => {
  const seed1 = deriveMatchSeed("p1", "p2", "Hard", "BestOf3");
  const seed2 = deriveMatchSeed("p1", "p2", "Hard", "BestOf3");
  assert.equal(seed1, seed2, "the same match identity must always derive the same seed");
});

test("deriveMatchSeed: is order-independent in the two player ids", () => {
  const seedForward = deriveMatchSeed("p1", "p2", "Hard", "BestOf3");
  const seedReversed = deriveMatchSeed("p2", "p1", "Hard", "BestOf3");
  assert.equal(seedForward, seedReversed, "swapping which player is player1/player2 must not change the seed -- it's the same real match");
});

test("deriveMatchSeed: differs when surface, format, or either player differs", () => {
  const base = deriveMatchSeed("p1", "p2", "Hard", "BestOf3");
  assert.notEqual(deriveMatchSeed("p1", "p3", "Hard", "BestOf3"), base, "a different opponent must be a different match");
  assert.notEqual(deriveMatchSeed("p1", "p2", "Clay", "BestOf3"), base, "a different surface must be a different match");
  assert.notEqual(deriveMatchSeed("p1", "p2", "Hard", "BestOf5"), base, "a different match format must be a different match");
});

test("runMatchSimulation: player1WinProbability, rangeLow, rangeHigh never hit exactly 0% or 100%", () => {
  // When DB-backed match history gives strong surface Elo to a dominant player, service-point
  // inputs can reach their clamp bounds and drive meanWinRate to ≥0.9995, which
  // Math.round(x * 1000) / 10 rounds to exactly 100.0 — a rounding artefact, not real certainty.
  // The safeRate cap in runMatchSimulation must prevent this for all realistic inputs.
  const cases: Array<{ p1: number; p2: number; label: string }> = [
    { p1: 0.82, p2: 0.45, label: "extreme favourite (p1 at upper clamp, p2 at lower clamp)" },
    { p1: 0.45, p2: 0.82, label: "extreme underdog" },
    { p1: 0.92, p2: 0.30, label: "absolute clamp bounds from jitter expansion" },
    { p1: 0.63, p2: 0.63, label: "symmetric 50/50 baseline" },
    { p1: 0.75, p2: 0.55, label: "moderate favourite" },
  ];

  for (const { p1, p2, label } of cases) {
    const estimate: ServicePointEstimate = { player1ServicePointProbability: p1, player2ServicePointProbability: p2, reliability: 90, note: "test" };
    const result = runMatchSimulation(estimate, "BestOf3", { seed: 99, outerDraws: 200, innerSimulationsPerDraw: 100 });
    assert.ok(result.player1WinProbability > 0, `player1WinProbability must be > 0 for: ${label} (got ${result.player1WinProbability})`);
    assert.ok(result.player1WinProbability < 100, `player1WinProbability must be < 100 for: ${label} (got ${result.player1WinProbability})`);
    assert.ok(result.rangeLow < 100, `rangeLow must be < 100 for: ${label} (got ${result.rangeLow})`);
    assert.ok(result.rangeHigh < 100, `rangeHigh must be < 100 for: ${label} (got ${result.rangeHigh})`);
    assert.ok(result.rangeLow > 0, `rangeLow must be > 0 for: ${label} (got ${result.rangeLow})`);
    assert.ok(result.straightSetsProbabilityPlayer1 > 0, `straightSetsProbabilityPlayer1 must be > 0 for: ${label} (got ${result.straightSetsProbabilityPlayer1})`);
    assert.ok(result.straightSetsProbabilityPlayer1 < 100, `straightSetsProbabilityPlayer1 must be < 100 for: ${label} (got ${result.straightSetsProbabilityPlayer1})`);
    assert.ok(result.straightSetsProbabilityPlayer2 > 0, `straightSetsProbabilityPlayer2 must be > 0 for: ${label} (got ${result.straightSetsProbabilityPlayer2})`);
    assert.ok(result.straightSetsProbabilityPlayer2 < 100, `straightSetsProbabilityPlayer2 must be < 100 for: ${label} (got ${result.straightSetsProbabilityPlayer2})`);
  }

  // Symmetric case must stay in realistic range
  const symEstimate: ServicePointEstimate = { player1ServicePointProbability: 0.63, player2ServicePointProbability: 0.63, reliability: 80, note: "test" };
  const symResult = runMatchSimulation(symEstimate, "BestOf3", { seed: 1, outerDraws: 150, innerSimulationsPerDraw: 80 });
  assert.ok(symResult.player1WinProbability >= 45 && symResult.player1WinProbability <= 55, `symmetric matchup must stay within [45,55], got ${symResult.player1WinProbability}`);
});

test("re-predicting the exact same match twice produces an identical simulated outcome", () => {
  const estimate: ServicePointEstimate = { player1ServicePointProbability: 0.63, player2ServicePointProbability: 0.6, reliability: 70, note: "test" };
  const seed = deriveMatchSeed("alice", "bob", "Clay", "BestOf3");

  const first = runMatchSimulation(estimate, "BestOf3", { seed });
  const second = runMatchSimulation(estimate, "BestOf3", { seed });

  assert.equal(first.player1WinProbability, second.player1WinProbability, "identical match identity must reproduce the identical win probability");
  assert.deepEqual(first.setScoreDistribution, second.setScoreDistribution, "identical match identity must reproduce the identical set-score distribution");
});
