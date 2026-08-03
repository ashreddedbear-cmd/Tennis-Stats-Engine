import { deriveMonteCarloHeadline } from "@/lib/monteCarloHeadline";
import { getRecommendationLabel as getSharedRecommendationLabel } from "@/lib/recommendationLabels";

function getRecommendationLabel(prediction: any): string {
  const engine = prediction?.engine ?? {};
  if (engine.isEliteTier) return "Elite";
  const recommendation = String(prediction?.recommendation ?? "");
  return getSharedRecommendationLabel(recommendation);
}

function getRecommendationEmoji(label: string): string {
  const l = label.toLowerCase();
  if (l === "elite" || l === "high confidence" || l === "strong lean") return "🟢";
  if (l === "high risk" || l === "skip") return "🔴";
  return "🟡";
}

function getUpsetRiskLabel(raw: string | undefined): string {
  if (!raw) return "";
  const u = String(raw).toUpperCase();
  if (u === "LOW") return "Low";
  if (u === "MODERATE") return "Moderate";
  if (u === "HIGH") return "High";
  return raw;
}

function getUpsetRiskEmoji(raw: string | undefined): string {
  const u = String(raw ?? "").toUpperCase();
  if (u === "LOW") return "🟢";
  if (u === "MODERATE") return "🟡";
  if (u === "HIGH") return "🔴";
  return "⚪";
}

function getWinProbability(prediction: any): number | null {
  if (typeof prediction?.predictedWinnerProbability === "number") {
    return Number(prediction.predictedWinnerProbability);
  }
  if (typeof prediction?.calibratedProbability === "number") {
    return Number(prediction.calibratedProbability);
  }
  return null;
}

export function buildPredictionCopyText(prediction: any): string {
  const engine = prediction?.engine ?? {};

  const winnerName = String(prediction?.predictedWinnerName ?? "Predicted Winner");
  const recommendation = getRecommendationLabel(prediction);
  const recEmoji = getRecommendationEmoji(recommendation);
  const winProbability = getWinProbability(prediction);
  const upsetRiskRaw = prediction?.upsetRisk as string | undefined;
  const upsetLabel = getUpsetRiskLabel(upsetRiskRaw);
  const upsetEmoji = getUpsetRiskEmoji(upsetRiskRaw);

  // Monte Carlo simulation
  let simulationLine = "🎲 Simulation: —";
  if (engine.simulation && typeof engine.simulation.player1WinProbability === "number") {
    const { headlineWinProbability } = deriveMonteCarloHeadline({
      predictedWinnerId: String(prediction.predictedWinnerId),
      player1Id: String(prediction.player1Id),
      player1Name: String(prediction.player1Name),
      player2Name: String(prediction.player2Name),
      player1WinProbability: Number(engine.simulation.player1WinProbability),
      rangeLow: Number(engine.simulation.rangeLow ?? engine.simulation.player1WinProbability),
      rangeHigh: Number(engine.simulation.rangeHigh ?? engine.simulation.player1WinProbability),
    });
    simulationLine = `🎲 Simulation: ${Math.round(headlineWinProbability)}%`;
  }

  const lines: string[] = [];

  // Winner
  lines.push(`${winnerName}🥇`);
  lines.push("");

  // Stats block
  if (typeof winProbability === "number") {
    lines.push(`🎾 ${Math.round(winProbability)}% Win Prob.`);
  }

  if (recommendation) {
    lines.push(`${recEmoji} Rec: ${recommendation}`);
  }

  if (upsetLabel) {
    lines.push(`${upsetEmoji} Upset Risk: ${upsetLabel}`);
  }

  if (typeof prediction?.dataQuality === "number") {
    lines.push(`📊 Data Quality: ${Math.round(Number(prediction.dataQuality))}%`);
  }

  if (prediction?.predictedSetScore) {
    lines.push(`🎯 Set Score: ${String(prediction.predictedSetScore)}`);
  }

  lines.push(simulationLine);

  // Footer
  lines.push("");
  lines.push("🤖 Tennis Matrix AI");
  lines.push("🎾 AI Tennis Prediction App");
  lines.push("📲 Follow @TennisMatrixAI");

  return lines.join("\n");
}
