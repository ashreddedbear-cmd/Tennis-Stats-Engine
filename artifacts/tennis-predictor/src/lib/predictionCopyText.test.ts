import test from "node:test";
import assert from "node:assert/strict";
import { buildPredictionCopyText } from "./predictionCopyText";

test("buildPredictionCopyText uses emoji social format with Elite recommendation", () => {
  const text = buildPredictionCopyText({
    player1Id: "p1",
    player1Name: "S. Shin",
    player2Id: "p2",
    player2Name: "Opponent",
    predictedWinnerId: "p1",
    predictedWinnerName: "S. Shin",
    predictedWinnerProbability: 55,
    calibratedProbability: 55,
    recommendation: "MODERATE_LEAN",
    upsetRisk: "LOW",
    dataQuality: 78,
    predictedSetScore: "2–1",
    engine: {
      isEliteTier: true,
      simulation: {
        player1WinProbability: 66,
        rangeLow: 61,
        rangeHigh: 71,
      },
    },
  });

  assert.equal(
    text,
    [
      "S. Shin🥇",
      "",
      "🎾 55% Win Prob.",
      "🟢 Rec: Elite",
      "🟢 Upset Risk: Low",
      "📊 Data Quality: 78%",
      "🎯 Set Score: 2–1",
      "🎲 Simulation: 66%",
      "",
      "🤖 Tennis Matrix AI",
      "🎾 AI Tennis Prediction App",
      "📲 Follow @TennisMatrixAI",
    ].join("\n"),
  );
});

test("buildPredictionCopyText shows dashes when simulation unavailable", () => {
  const text = buildPredictionCopyText({
    player1Id: "p1",
    player1Name: "S. Shin",
    player2Id: "p2",
    player2Name: "Opponent",
    predictedWinnerId: "p1",
    predictedWinnerName: "S. Shin",
    predictedWinnerProbability: 55,
    calibratedProbability: 55,
    recommendation: "HIGH_RISK",
    upsetRisk: "HIGH",
    dataQuality: 78,
    predictedSetScore: "2–1",
    engine: {},
  });

  assert.equal(
    text,
    [
      "S. Shin🥇",
      "",
      "🎾 55% Win Prob.",
      "🔴 Rec: High Risk",
      "🔴 Upset Risk: High",
      "📊 Data Quality: 78%",
      "🎯 Set Score: 2–1",
      "🎲 Simulation: —",
      "",
      "🤖 Tennis Matrix AI",
      "🎾 AI Tennis Prediction App",
      "📲 Follow @TennisMatrixAI",
    ].join("\n"),
  );
});

test("buildPredictionCopyText moderate upset risk uses yellow emoji", () => {
  const text = buildPredictionCopyText({
    player1Id: "p1",
    player1Name: "O. Crawford",
    player2Id: "p2",
    player2Name: "Opponent",
    predictedWinnerId: "p1",
    predictedWinnerName: "O. Crawford",
    predictedWinnerProbability: 64,
    calibratedProbability: 64,
    recommendation: "MODERATE_LEAN",
    upsetRisk: "MODERATE",
    dataQuality: 88,
    predictedSetScore: "2-1",
    engine: {
      isEliteTier: false,
      simulation: {
        player1WinProbability: 67,
        rangeLow: 62,
        rangeHigh: 72,
      },
    },
  });

  assert.equal(
    text,
    [
      "O. Crawford🥇",
      "",
      "🎾 64% Win Prob.",
      "🟡 Rec: Moderate Lean",
      "🟡 Upset Risk: Moderate",
      "📊 Data Quality: 88%",
      "🎯 Set Score: 2-1",
      "🎲 Simulation: 67%",
      "",
      "🤖 Tennis Matrix AI",
      "🎾 AI Tennis Prediction App",
      "📲 Follow @TennisMatrixAI",
    ].join("\n"),
  );
});
