import test from "node:test";
import assert from "node:assert/strict";
import { computeDataQuality, computeSurfaceSampleDepth, computeMatchupDifficultySignal, adjustDataQualityForMatchupDifficulty, MODULE_IMPORTANCE, EXCLUDED_FROM_DATA_QUALITY } from "./dataQuality";

function modules(overrides: Partial<Record<keyof typeof MODULE_IMPORTANCE, number>>) {
  const defaults: Record<keyof typeof MODULE_IMPORTANCE, number> = {
    surfaceElo: 0,
    serveReturn: 0,
    recentForm: 0,
    availability: 0,
    fatigue: 0,
    headToHead: 0,
    matchLoadRecovery: 0,
  };
  const reliabilities = { ...defaults, ...overrides };
  return (Object.keys(MODULE_IMPORTANCE) as Array<keyof typeof MODULE_IMPORTANCE>).map((key) => ({
    reliability: reliabilities[key],
    importance: MODULE_IMPORTANCE[key],
  }));
}

test("a rare-but-real gap (no head-to-head, no travel data) no longer caps a strong-core-signal match", () => {
  // Strong Elo/Serve&Return/Recent Form, fixed-constant Fatigue, and the two structurally-rare
  // signals (Availability without travel, Head-to-Head with no prior meetings) both low.
  const strongCore = modules({ surfaceElo: 90, serveReturn: 85, recentForm: 80, fatigue: 70, availability: 50, headToHead: 5 });
  const { score, label } = computeDataQuality(strongCore);

  const flatAverage = Math.round((90 + 85 + 80 + 70 + 50 + 5) / 6); // what the old flat average would have produced

  assert.ok(score > flatAverage, `expected weighted score (${score}) to beat the old flat average (${flatAverage})`);
  assert.ok(score >= 65, `expected a match with strong core signals to reach at least "Strong", got ${score}`);
  assert.equal(label, "Strong");
});

test("genuinely weak core signals still score low, even though Fatigue's reliability is a fixed constant", () => {
  const weakCore = modules({ surfaceElo: 20, serveReturn: 20, recentForm: 20, fatigue: 70, availability: 25, headToHead: 5 });
  const { score, label } = computeDataQuality(weakCore);

  assert.ok(score <= 35, `expected genuinely thin data to still score low despite Fatigue's fixed 70, got ${score}`);
  assert.ok(label === "Poor" || label === "Limited", `expected Poor or Limited, got ${label}`);
});

test("strong data across every module still scores Excellent", () => {
  const allStrong = modules({ surfaceElo: 95, serveReturn: 90, recentForm: 90, fatigue: 70, availability: 95, headToHead: 90, matchLoadRecovery: 70 });
  const { score, label } = computeDataQuality(allStrong);

  assert.ok(score >= 85, `expected a uniformly strong match to reach Excellent, got ${score}`);
  assert.equal(label, "Excellent");
});

test("Head-to-Head is excluded from the real Data Quality blend (2026-07-13 'stop low-value signals' fix) -- its reliability can no longer move the score at all once filtered the way index.ts actually does", () => {
  const withoutHeadToHead = (overrides: Partial<Record<keyof typeof MODULE_IMPORTANCE, number>>) =>
    modules(overrides).filter((_, i) => !EXCLUDED_FROM_DATA_QUALITY.has((Object.keys(MODULE_IMPORTANCE) as Array<keyof typeof MODULE_IMPORTANCE>)[i]));

  const noMeetings = computeDataQuality(withoutHeadToHead({ surfaceElo: 60, serveReturn: 60, recentForm: 60, fatigue: 70, availability: 60, headToHead: 5 }));
  const manyMeetings = computeDataQuality(withoutHeadToHead({ surfaceElo: 60, serveReturn: 60, recentForm: 60, fatigue: 70, availability: 60, headToHead: 90 }));

  assert.equal(
    manyMeetings.score,
    noMeetings.score,
    "with Head-to-Head correctly filtered out before calling computeDataQuality (as index.ts now does), its reliability must have zero effect on the score",
  );
});

test("computeDataQuality itself still accepts a Head-to-Head-shaped input (defensive -- the exclusion lives at the call site in index.ts, not inside this pure blend function)", () => {
  const noMeetings = computeDataQuality(modules({ surfaceElo: 60, serveReturn: 60, recentForm: 60, fatigue: 70, availability: 60, headToHead: 5 }));
  const manyMeetings = computeDataQuality(modules({ surfaceElo: 60, serveReturn: 60, recentForm: 60, fatigue: 70, availability: 60, headToHead: 90 }));

  assert.ok(manyMeetings.score >= noMeetings.score, "the underlying weighted-blend math is unchanged -- only the real pipeline's call site now omits Head-to-Head");
});

test("an all-zero input produces the lowest score without dividing by zero", () => {
  const { score, label } = computeDataQuality(modules({}));
  assert.equal(score, 0);
  assert.equal(label, "Poor");
});

test("computeSurfaceSampleDepth flags the weaker side and labels Low/Moderate/High consistently with surfaceElo's own warning threshold", () => {
  const low = computeSurfaceSampleDepth(2, 20);
  assert.equal(low.minSample, 2);
  assert.equal(low.label, "Low");

  const moderate = computeSurfaceSampleDepth(8, 9);
  assert.equal(moderate.label, "Moderate");

  const high = computeSurfaceSampleDepth(15, 30);
  assert.equal(high.label, "High");
  assert.equal(high.player1Sample, 15);
  assert.equal(high.player2Sample, 30);
});

test("matchup difficulty prefers rank-gap when both ranks are known", () => {
  const signal = computeMatchupDifficultySignal({ player1Rank: 8, player2Rank: 108, surfaceEloEdge: 0 });
  assert.equal(signal.source, "rank-gap");
  assert.equal(signal.rankGap, 100);
  assert.equal(signal.eloGapProbabilityPoints, null);
  assert.ok(signal.decisivenessScore > 0);
});

test("matchup difficulty falls back to Elo gap when rank is missing", () => {
  const signal = computeMatchupDifficultySignal({ player1Rank: null, player2Rank: 45, surfaceEloEdge: 20 });
  assert.equal(signal.source, "elo-gap-fallback");
  assert.equal(signal.rankGap, null);
  assert.ok(typeof signal.eloGapProbabilityPoints === "number");
  assert.ok(signal.decisivenessScore > 0);
});

test("Data Quality adjustment lowers close-parity matchups and raises lopsided matchups", () => {
  const base = 70;
  const close = computeMatchupDifficultySignal({ player1Rank: 28, player2Rank: 30, surfaceEloEdge: 0 });
  const lopsided = computeMatchupDifficultySignal({ player1Rank: 5, player2Rank: 200, surfaceEloEdge: 0 });
  const closeAdjusted = adjustDataQualityForMatchupDifficulty(base, close);
  const lopsidedAdjusted = adjustDataQualityForMatchupDifficulty(base, lopsided);

  assert.ok(closeAdjusted < base, `expected parity matchup to reduce DQ from ${base}, got ${closeAdjusted}`);
  assert.ok(lopsidedAdjusted > base, `expected lopsided matchup to increase DQ from ${base}, got ${lopsidedAdjusted}`);
});
