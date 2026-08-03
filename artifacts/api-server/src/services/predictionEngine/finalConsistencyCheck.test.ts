import test from "node:test";
import assert from "node:assert/strict";
import { checkFinalConsistency, type FinalConsistencyInput } from "./finalConsistencyCheck";
import { runPredictionEngine } from "./index";
import type { PredictionEngineInput } from "./types";
import type { PlayerProfile, MatchRecord } from "../tennisData/types";

function baseInput(overrides: Partial<FinalConsistencyInput> = {}): FinalConsistencyInput {
  return {
    player1Id: "p1",
    player2Id: "p2",
    calibratedProbability: 65,
    predictedWinnerId: "p1",
    predictedWinnerProbability: 65,
    isEliteTier: false,
    eliteTierReason: "Not elite tier -- data quality too low.",
    modelAgreement: "Strong",
    upsetRisk: "LOW",
    upsetRiskBreakdownTier: "LOW",
    recommendation: "MODERATE_LEAN",
    modelConflict: false,
    disagreementNote: null,
    modelConflictNote: null,
    upsetRiskNote: "LOW: the favorite's edge is comfortable (15pts from a coin flip) and no other risk factor is present.",
    predictedSetScore: "2-0",
    dataQuality: 70,
    dataQualityLabel: "Strong",
    ...overrides,
  };
}

test("a fully consistent prediction has zero violations", () => {
  assert.deepEqual(checkFinalConsistency(baseInput()).violations, []);
});

test("rule 10: a stale stored v2 recommendation that no longer matches computeRecommendation's current output is caught", () => {
  // Same shape as the real staleness class: a row's `recommendation` was stored as LOW_CONFIDENCE
  // under older logic, but calibratedProbability=59 (margin 9), dataQuality=70/"Strong", and
  // modelAgreement=Strong now produce HIGH_CONFIDENCE under the current logic. Legacy recommendation
  // values (STRONG_RECOMMENDATION, MODERATE_LEAN, etc.) are deliberately skipped by Rule 10 to
  // avoid retroactively flagging pre-rename rows -- this test uses a v2 value (LOW_CONFIDENCE) to
  // confirm the freshness check still works for current-schema rows.
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, dataQuality: 70, dataQualityLabel: "Strong", upsetRisk: "LOW", modelAgreement: "Strong", recommendation: "LOW_CONFIDENCE" }),
  );
  // This exact shape (margin 9, Strong agreement, stored LOW_CONFIDENCE) also independently
  // trips rule 12 (hardcoded catch-all-gap guard) -- both rules correctly fire here.
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => v.includes("Rule 10")));
  assert.ok(violations.some((v) => v.includes("Rule 12")));
});

test("rule 10: a v2 recommendation that matches computeRecommendation's current output for the same inputs is not flagged", () => {
  // margin=9, DQ=70/Strong, Strong agreement → HIGH_CONFIDENCE under current logic
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, dataQuality: 70, dataQualityLabel: "Strong", upsetRisk: "LOW", modelAgreement: "Strong", recommendation: "HIGH_CONFIDENCE" }),
  );
  assert.deepEqual(violations, []);
});

test("rule 10: legacy stored recommendations (pre-v2 rename) are never flagged as stale even when they differ from current logic", () => {
  // MODERATE_LEAN was the old name for a middle-confidence tier; it's now a legacy value.
  // Rule 10 explicitly skips legacy names so pre-rename rows aren't flooded with freshness
  // violations. The shadow replay (recommendationCalibration route) is the right audit path.
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, dataQuality: 70, dataQualityLabel: "Strong", upsetRisk: "LOW", modelAgreement: "Strong", recommendation: "MODERATE_LEAN" }),
  );
  assert.ok(!violations.some((v) => v.includes("Rule 10")));
});

test("rule 11: a valid simulation resolves cleanly when the winner is stored as player1", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedWinnerId: "p1", simulationPlayer1WinProbability: 65 }));
  assert.ok(!violations.some((v) => v.includes("Rule 11")));
});

test("rule 11: a valid simulation resolves cleanly when the winner is stored as player2 (the original binding-bug shape)", () => {
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 35, predictedWinnerId: "p2", predictedWinnerProbability: 65, simulationPlayer1WinProbability: 30 }),
  );
  // mirrored: predictedWinnerId is p2, so winner probability = 100 - 30 = 70, a valid [0,100] value
  assert.ok(!violations.some((v) => v.includes("Rule 11")));
});

test("rule 11: a row with no stored simulation (legacy, pre-Phase-7) is not flagged", () => {
  const { violations } = checkFinalConsistency(baseInput({ simulationPlayer1WinProbability: null }));
  assert.ok(!violations.some((v) => v.includes("Rule 11")));
});

test("rule 11: a malformed/out-of-range simulation value is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedWinnerId: "p1", simulationPlayer1WinProbability: Number.NaN }));
  assert.ok(violations.some((v) => v.includes("Rule 11")));
});

test("rule 12: the exact margin 9-12 catch-all gap (LOW_CONFIDENCE on a Strong-agreement pick) is caught independent of computeRecommendation", () => {
  // margin = |59 - 50| = 9, inside [9,12); Strong agreement -- computeRecommendation produces
  // HIGH_CONFIDENCE for this (margin>=9 + Strong), but Rule 12 hardcodes the expected outcome
  // independently so it still fires even if a future regression makes computeRecommendation agree
  // with the bad LOW_CONFIDENCE. upsetRisk is intentionally not a Rule 12 input any more.
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, upsetRisk: "LOW", upsetRiskBreakdownTier: "LOW", modelAgreement: "Strong", recommendation: "LOW_CONFIDENCE" }),
  );
  assert.ok(violations.some((v) => v.includes("Rule 12")));
});

test("rule 12: a margin 9-12 pick correctly labeled HIGH_CONFIDENCE is not flagged", () => {
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, upsetRisk: "LOW", upsetRiskBreakdownTier: "LOW", modelAgreement: "Strong", recommendation: "HIGH_CONFIDENCE" }),
  );
  assert.ok(!violations.some((v) => v.includes("Rule 12")));
});

test("rule 12: a margin 9-12 pick with HighDisagreement agreement is not caught by rule 12 (LOW_CONFIDENCE is valid there)", () => {
  // Rule 12 only fires when modelAgreement === "Strong" to guard the specific window where a
  // Strong-agreement lean must always produce at least HIGH_CONFIDENCE.
  const { violations } = checkFinalConsistency(
    baseInput({ calibratedProbability: 59, predictedWinnerProbability: 59, upsetRisk: "LOW", upsetRiskBreakdownTier: "LOW", modelAgreement: "HighDisagreement", recommendation: "LOW_CONFIDENCE", disagreementNote: "HIGHDISAGREEMENT: some real note." }),
  );
  assert.ok(!violations.some((v) => v.includes("Rule 12")));
});

test("rule 1: predicted winner disagreeing with the probability's own direction is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ calibratedProbability: 65, predictedWinnerId: "p2" }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Rule 1/);
});

test("rule 2: an out-of-bounds predictedWinnerProbability is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedWinnerProbability: 40 }));
  assert.ok(violations.some((v) => v.includes("Rule 2")));
});

test("rule 3: a predictedWinnerProbability that isn't the true mirrored complement is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ calibratedProbability: 30, predictedWinnerId: "p2", predictedWinnerProbability: 60 }));
  // true mirrored complement of 30 (player2 favored) is 70, not 60
  assert.ok(violations.some((v) => v.includes("Rule 3")));
});

test("rule 4 (the original bug report's exact shape): Elite claiming 'no model conflict' while High Disagreement/Extreme risk is caught", () => {
  const { violations } = checkFinalConsistency(
    baseInput({
      isEliteTier: true,
      eliteTierReason: "Elite: high data quality, ... the calibrated pick agrees with the raw evidence (no model conflict).",
      modelAgreement: "HighDisagreement",
      upsetRisk: "EXTREME",
      upsetRiskBreakdownTier: "EXTREME",
    }),
  );
  assert.ok(violations.some((v) => v.includes("Rule 4") && v.includes("no model conflict")));
  assert.ok(violations.some((v) => v.includes("Rule 4") && v.includes("isEliteTier is true")));
});

test("rule 4 tolerates High Disagreement/High risk as long as Elite is correctly withheld and the wording doesn't claim otherwise", () => {
  const { violations } = checkFinalConsistency(
    baseInput({
      isEliteTier: false,
      eliteTierReason: "Not elite tier -- model agreement is High Disagreement -- the risk label is not suppressed, only the Elite badge is withheld.",
      modelAgreement: "HighDisagreement",
      upsetRisk: "HIGH",
      upsetRiskBreakdownTier: "HIGH",
      // computeRecommendation produces HIGH_RISK for upsetRisk=HIGH + HighDisagreement
      // (margin=15, falls through all MODERATE_LEAN gates). Explicitly pass the correct
      // recommendation so Rule 10 (freshness check) stays silent and only Rule 4 is tested.
      recommendation: "HIGH_RISK",
      disagreementNote: "HIGHDISAGREEMENT: some real note explaining the conflicting models.",
    }),
  );
  assert.deepEqual(violations, []);
});

test("rule 5: a top-level upsetRisk that disagrees with the detailed breakdown's own tier is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ upsetRisk: "LOW", upsetRiskBreakdownTier: "EXTREME" }));
  assert.ok(violations.some((v) => v.includes("Rule 5")));
});

test("rule 6: HIGHEST_CONFIDENCE paired with Mixed model agreement is caught", () => {
  // upsetRisk is intentionally NOT a Rule 6 input any more — Recommendation and Upset Risk are
  // now decoupled, independent signals. Rule 6 only guards the model-agreement invariant.
  const { violations } = checkFinalConsistency(
    baseInput({
      recommendation: "HIGHEST_CONFIDENCE",
      modelAgreement: "Mixed",
      disagreementNote: "MIXED: some note.",
    }),
  );
  assert.ok(violations.some((v) => v.includes("Rule 6") && v.includes("model agreement")));
});

test("rule 6: HIGHEST_CONFIDENCE paired with HighDisagreement is caught", () => {
  const { violations } = checkFinalConsistency(
    baseInput({
      recommendation: "HIGHEST_CONFIDENCE",
      modelAgreement: "HighDisagreement",
      disagreementNote: "HIGHDISAGREEMENT: some real note explaining the conflicting models.",
    }),
  );
  assert.ok(violations.some((v) => v.includes("Rule 6") && v.includes("model agreement")));
});

test("rule 6: HIGHEST_CONFIDENCE with Strong agreement is clean (even with High upset risk — upset risk is no longer a Rule 6 input)", () => {
  // Rule 6 no longer checks upsetRisk; this scenario used to trip Rule 6 under the old
  // STRONG_RECOMMENDATION naming but is now correctly clean for Rule 6 specifically.
  // coreSignalsAlign=true + margin>=26 + DQ>=50 + Strong → HIGHEST_CONFIDENCE under current logic.
  const { violations } = checkFinalConsistency(
    baseInput({
      calibratedProbability: 76,
      predictedWinnerProbability: 76,
      recommendation: "HIGHEST_CONFIDENCE",
      upsetRisk: "HIGH",
      upsetRiskBreakdownTier: "HIGH",
      modelAgreement: "Strong",
      coreSignalsAlign: true,
    }),
  );
  assert.ok(!violations.some((v) => v.includes("Rule 6")));
});

test("rule 7: Elite tier paired with INSUFFICIENT_EDGE is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ isEliteTier: true, recommendation: "INSUFFICIENT_EDGE" }));
  assert.ok(violations.some((v) => v.includes("Rule 7")));
});

test("rule 7: Elite tier paired with legacy No Strong Signal is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ isEliteTier: true, recommendation: "NO_STRONG_SIGNAL" }));
  assert.ok(violations.some((v) => v.includes("Rule 7")));
});

test("rule 7: Elite tier paired with legacy Do Not Recommend is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ isEliteTier: true, recommendation: "DO_NOT_RECOMMEND" }));
  assert.ok(violations.some((v) => v.includes("Rule 7")));
});

test("rule 8: a disagreementNote present while modelAgreement is Strong is caught (vice versa of the real bug)", () => {
  const { violations } = checkFinalConsistency(baseInput({ modelAgreement: "Strong", disagreementNote: "Moderate: some spurious note." }));
  assert.ok(violations.some((v) => v.includes("Rule 8") && v.includes("disagreement note")));
});

test("rule 8: a missing disagreementNote while modelAgreement isn't Strong is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ modelAgreement: "Moderate", disagreementNote: null }));
  assert.ok(violations.some((v) => v.includes("Rule 8") && v.includes("disagreement note")));
});

test("rule 8: a modelConflictNote present while modelConflict is false is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ modelConflict: false, modelConflictNote: "MODEL CONFLICT: some spurious note." }));
  assert.ok(violations.some((v) => v.includes("Rule 8") && v.includes("model-conflict note")));
});

test("rule 8: a missing modelConflictNote while modelConflict is true is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ modelConflict: true, modelConflictNote: null }));
  assert.ok(violations.some((v) => v.includes("Rule 8") && v.includes("model-conflict note")));
});

test("rule 8 (the exact upsetRisk.ts bug this task fixed): a note claiming core-model direction conflict while modelAgreement isn't HighDisagreement is caught", () => {
  const { violations } = checkFinalConsistency(
    baseInput({ modelAgreement: "Moderate", upsetRiskNote: "LOW upset risk, mainly because the core models disagree on direction and the favorite's edge is thin." }),
  );
  assert.ok(violations.some((v) => v.includes("Rule 8") && v.includes("upset-risk note")));
});

test("rule 8 tolerates the real direction-conflict wording when modelAgreement genuinely is HighDisagreement", () => {
  const { violations } = checkFinalConsistency(
    baseInput({
      modelAgreement: "HighDisagreement",
      disagreementNote: "HIGHDISAGREEMENT: some real note.",
      upsetRiskNote: "HIGH upset risk, mainly because the core models disagree on direction.",
    }),
  );
  assert.ok(!violations.some((v) => v.includes("Rule 8") && v.includes("upset-risk note")));
});

test("rule 9: a predicted winner's set score implying a loss (fewer sets than the opponent) is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedSetScore: "1-2" }));
  assert.ok(violations.some((v) => v.includes("Rule 9") && v.includes("does not show")));
});

test("rule 9: a malformed set score is caught", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedSetScore: "garbage" }));
  assert.ok(violations.some((v) => v.includes("Rule 9") && v.includes("format")));
});

test("rule 9: a legitimate winner-first set score is clean", () => {
  const { violations } = checkFinalConsistency(baseInput({ predictedSetScore: "3-1" }));
  assert.deepEqual(violations, []);
});

// --- Regression fixture: the original bug report (C. Bouchelaghem vs. A. Ganesan) showed Elite
// Prediction, High Disagreement, AND a "no model conflict" success reason simultaneously. The
// literal original match inputs aren't available, so this reconstructs a match SHAPED the same
// way: three core signal modules genuinely split on direction (so disagreement.ts's own weighted
// core-conflict check legitimately fires HighDisagreement, not a hand-set override), a probability
// close enough to 50 that upset risk climbs toward HIGH/EXTREME on its own real component
// scoring, and otherwise-high data quality (the exact combination that used to slip through as
// Elite). Run through the REAL engine end-to-end -- not a mocked EngineOutput -- so this proves
// the current code, not just the guard function in isolation.

function player(id: string, name: string): PlayerProfile {
  return { id, name, countryCode: "US", currentRank: 40, tour: "ATP", age: 26, plays: "Right-handed", fullName: name };
}

/** A real-shaped match record, minimal but internally consistent for the modules that read it. */
function match(opponentId: string, opponentName: string, won: boolean, surface: "Hard" | "Clay" | "Grass", daysAgo: number, servicePointsWonPct: number): MatchRecord {
  const date = new Date(Date.now());
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `m-${opponentId}-${daysAgo}`,
    date: date.toISOString().slice(0, 10),
    tournamentName: "Regression Fixture Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface,
    indoor: false,
    opponentId,
    opponentName,
    opponentRank: 60,
    result: won ? "W" : "L",
    score: won ? "6-3 6-4" : "3-6 4-6",
    retired: false,
    walkover: false,
    stats: { firstServePct: 62, firstServeWon: 70, secondServeWon: 50, aces: 5, doubleFaults: 2, breakPointsSaved: 60, breakPointsFaced: 5, returnPointsWon: 38, servicePointsWonPct },
    opponentStats: null,
    setGameMargins: won ? [{ playerGames: 6, opponentGames: 3 }, { playerGames: 6, opponentGames: 4 }] : [{ playerGames: 3, opponentGames: 6 }, { playerGames: 4, opponentGames: 6 }],
  };
}

test("regression fixture: a Bouchelaghem/Ganesan-shaped near-coin-flip, core-model-split match never surfaces as Elite, and never claims 'no model conflict' while High Disagreement", () => {
  const player1 = player("bouchelaghem", "C. Bouchelaghem");
  const player2 = player("ganesan", "A. Ganesan");

  // Player 1: strong recent hard-court form (high service points won, mostly wins), but weak on
  // this exact surface historically (few/no prior clay matches) -- built to make Surface Elo and
  // Recent Form/Serve&Return point in OPPOSITE directions, the real structural cause of a
  // core-model conflict (not a fabricated override).
  const player1Matches: MatchRecord[] = [
    match("opp-a", "Opponent A", true, "Hard", 10, 68),
    match("opp-b", "Opponent B", true, "Hard", 20, 66),
    match("opp-c", "Opponent C", true, "Hard", 30, 64),
    match("opp-d", "Opponent D", false, "Hard", 45, 55),
    match("opp-e", "Opponent E", true, "Hard", 60, 65),
    match("opp-f", "Opponent F", true, "Hard", 75, 63),
  ];
  const player2Matches: MatchRecord[] = [
    match("opp-g", "Opponent G", false, "Clay", 8, 50),
    match("opp-h", "Opponent H", true, "Clay", 18, 58),
    match("opp-i", "Opponent I", true, "Clay", 28, 60),
    match("opp-j", "Opponent J", false, "Clay", 40, 48),
    match("opp-k", "Opponent K", true, "Clay", 55, 59),
    match("opp-l", "Opponent L", true, "Clay", 70, 61),
  ];

  const input: PredictionEngineInput = {
    player1,
    player2,
    player1Matches,
    player2Matches,
    headToHead: { player1Id: player1.id, player2Id: player2.id, meetings: [] },
    surface: "Clay",
    matchFormat: "BestOf3",
    tournamentName: "Regression Fixture Open",
    weather: null,
    segment: null,
    simulatorAdoption: null,
    activeCalibration: null,
  };

  const output = runPredictionEngine(input);

  // This is a real, structurally-derived output -- assert on the actual guarantees rather than a
  // pre-decided modelAgreement/upsetRisk, since the exact tier depends on the real weighted
  // disagreement/upset-risk math (disagreement.ts / upsetRisk.ts), not this fixture.
  assert.equal(output.engine.consistencyViolations.length, 0, "the real engine output must never trip the final-consistency guard");

  if (output.engine.modelAgreement === "HighDisagreement" || output.upsetRisk === "HIGH" || output.upsetRisk === "EXTREME") {
    assert.equal(output.engine.isEliteTier, false, "Elite must be withheld whenever disagreement is High or upset risk is High/Extreme");
    assert.doesNotMatch(output.engine.eliteTierReason, /no model conflict/i, "the reason string must never claim 'no model conflict' while genuinely disagreeing");
  }
});
