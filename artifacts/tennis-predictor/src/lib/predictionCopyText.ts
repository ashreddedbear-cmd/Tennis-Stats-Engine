import { deriveMonteCarloHeadline } from "@/lib/monteCarloHeadline";
import { getRecommendationLabel as getSharedRecommendationLabel } from "@/lib/recommendationLabels";

// ---------------------------------------------------------------------------
// toVisibleModelName — replicated from PredictionResult.tsx so this module
// can label model names without importing from a page file.
// ---------------------------------------------------------------------------
const _MODEL_NAME_LABELS: Record<string, string> = {
  "Surface Elo": "Surface Elo",
  "Serve & Return": "Serve & Return",
  "Recent Form": "Recent Form",
  "Fatigue Index": "Fatigue, Rest & Match Load",
  "Head-to-Head": "Head-to-Head",
  "Style Matchup": "Style Matchup",
  "Availability": "Availability / Injury",
  "Court Speed": "Court Speed",
  "Weather": "Weather",
  "Tour Adjustment": "Tour-Level Adjustment",
  "Segment Specialist": "Specialist Model",
  "Monte Carlo": "Monte Carlo",
  "Calibrated Ensemble": "Calibrated Ensemble",
};

function _toVisibleModelName(name: string): string {
  const exact = _MODEL_NAME_LABELS[name];
  if (exact) return exact;
  if (name.includes("Surface Elo")) return "Surface Elo";
  if (name.includes("Serve") || name.includes("Return")) return "Serve & Return";
  if (name.includes("Recent Form")) return "Recent Form";
  if (name.includes("Fatigue") || name.includes("Match Load") || name.includes("Recovery")) return "Fatigue, Rest & Match Load";
  if (name.includes("Head")) return "Head-to-Head";
  if (name.includes("Style")) return "Style Matchup";
  if (name.includes("Availability") || name.includes("Injury")) return "Availability / Injury";
  if (name.includes("Weather")) return "Weather";
  if (name.includes("Specialist")) return "Specialist Model";
  if (name.includes("Monte")) return "Monte Carlo";
  if (name.includes("Ensemble") || name.includes("Calibrat")) return "Calibrated Ensemble";
  return name;
}

const _CLOSENESS_LABELS: Record<string, string> = {
  VeryClose: "Very close to a coin flip",
  Close: "Close matchup",
  Moderate: "Moderate lean",
  Clear: "Clear favorite",
};

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

// ---------------------------------------------------------------------------
// buildFullPredictionCopyText — complete engine report for AI chat paste.
// Completely independent of buildPredictionCopyText; changing one cannot
// affect the other.
// ---------------------------------------------------------------------------
export function buildFullPredictionCopyText(prediction: any): string {
  const engine = prediction?.engine ?? {};
  const dash = "—";
  const p1 = String(prediction?.player1Name ?? "P1");
  const p2 = String(prediction?.player2Name ?? "P2");

  const lines: string[] = [];

  // ── 1. SUMMARY ──────────────────────────────────────────────────────────
  lines.push("SUMMARY");
  lines.push(`Winner: ${prediction?.predictedWinnerName ?? dash}`);

  const surfaceParts = [prediction?.surface, prediction?.matchFormat, prediction?.tournamentLevel].filter(Boolean);
  lines.push(`Match: ${surfaceParts.length ? surfaceParts.join(" · ") : dash}`);

  const winProbability = getWinProbability(prediction);
  lines.push(`Win Probability: ${typeof winProbability === "number" ? `${Math.round(winProbability)}%` : dash}`);

  const recommendation = getRecommendationLabel(prediction);
  lines.push(`Recommendation: ${recommendation || dash}`);

  const upsetRiskRaw = prediction?.upsetRisk as string | undefined;
  lines.push(`Upset Risk: ${getUpsetRiskLabel(upsetRiskRaw) || dash}`);

  lines.push(`Data Quality: ${typeof prediction?.dataQuality === "number" ? `${Math.round(Number(prediction.dataQuality))}%` : dash}`);
  lines.push(`Set Score: ${prediction?.predictedSetScore ?? dash}`);

  const modelAgreement = engine.modelAgreement
    ? engine.modelAgreement.replace(/([a-z])([A-Z])/g, "$1 $2")
    : null;
  lines.push(`Model Agreement: ${modelAgreement ?? dash}`);

  const closenessRaw = engine.matchupCloseness;
  lines.push(`Matchup Closeness: ${closenessRaw ? (_CLOSENESS_LABELS[closenessRaw] ?? closenessRaw) : dash}`);

  lines.push("");

  // ── 2. MODEL VOTES ──────────────────────────────────────────────────────
  if (Array.isArray(engine.models) && engine.models.length > 0) {
    lines.push("MODEL VOTES");
    for (const vote of engine.models.filter(
      (v: any) => typeof v.modelName === "string" && v.modelName.trim().length > 0
    )) {
      const modelName = _toVisibleModelName(vote.modelName);
      const effectiveWeightPct = vote.weightUsed * 100;
      const weightedContribution = vote.player1Probability * vote.weightUsed;
      const favored = vote.player1Probability >= 50 ? p1 : p2;
      const status =
        vote.weightUsed < 0.01 ? "Excluded" : vote.reliability < 25 ? "Limited" : "Active";
      const availability = vote.weightUsed < 0.01 ? "Unavailable" : "Available";
      const sampleDepth =
        vote.reliability >= 75 ? "High" : vote.reliability >= 45 ? "Medium" : "Low";
      const note =
        status !== "Active"
          ? status === "Excluded"
            ? "Near-zero effect."
            : "Limited influence."
          : null;

      lines.push(`  ${modelName}`);
      lines.push(`    RAW PROB: ${vote.player1Probability.toFixed(1)}%`);
      lines.push(`    FAVORED: ${favored}`);
      lines.push(`    EFF. WEIGHT: ${effectiveWeightPct.toFixed(1)}%`);
      lines.push(`    CONTRIBUTION: ${weightedContribution.toFixed(1)}`);
      lines.push(`    RELIABILITY: ${vote.reliability.toFixed(0)}`);
      lines.push(`    AVAILABILITY: ${availability}`);
      lines.push(`    SAMPLE: ${sampleDepth}`);
      lines.push(`    STATUS: ${status}`);
      if (note) lines.push(`    NOTE: ${note}`);
    }
    lines.push("");
  }

  // ── 3. SURFACE ELO ──────────────────────────────────────────────────────
  if (engine.surfaceElo) {
    lines.push("SURFACE ELO");
    lines.push(`  ${p1} ELO: ${engine.surfaceElo.player1SurfaceElo ?? dash}`);
    lines.push(`  ${p2} ELO: ${engine.surfaceElo.player2SurfaceElo ?? dash}`);
    // eloWinProbabilityPlayer1 is already Percentage (0–100)
    lines.push(
      `  ELO Win Prob: ${
        typeof engine.surfaceElo.eloWinProbabilityPlayer1 === "number"
          ? `${engine.surfaceElo.eloWinProbabilityPlayer1.toFixed(1)}%`
          : dash
      }`
    );
    if (engine.surfaceSampleDepth) {
      lines.push(
        `  Surface Sample Depth: ${engine.surfaceSampleDepth.label} (${engine.surfaceSampleDepth.player1Sample}/${engine.surfaceSampleDepth.player2Sample})`
      );
    }
    if (
      typeof engine.surfaceElo.effectiveSampleSizePlayer1 === "number" &&
      typeof engine.surfaceElo.effectiveSampleSizePlayer2 === "number"
    ) {
      lines.push(
        `  Effective Sample (Weighted): ${engine.surfaceElo.effectiveSampleSizePlayer1.toFixed(1)}/${engine.surfaceElo.effectiveSampleSizePlayer2.toFixed(1)}`
      );
    }
    if (
      typeof engine.surfaceElo.player1BlendWeight === "number" &&
      typeof engine.surfaceElo.player2BlendWeight === "number" &&
      Math.max(engine.surfaceElo.player1BlendWeight, engine.surfaceElo.player2BlendWeight) > 0.3
    ) {
      // player1/2BlendWeight are Fractions (0–1); display as percentage
      lines.push(
        `  Blended toward overall Elo: ${p1} ${(engine.surfaceElo.player1BlendWeight * 100).toFixed(0)}%, ${p2} ${(engine.surfaceElo.player2BlendWeight * 100).toFixed(0)}% (thin surface-specific sample)`
      );
    }
    lines.push("");
  }

  // ── 4. SERVE & RETURN ───────────────────────────────────────────────────
  if (engine.serveReturn) {
    lines.push("SERVE & RETURN");
    lines.push(`  ${p1} Serve S.P.: ${engine.serveReturn.player1ServeRating ?? dash}`);
    lines.push(`  ${p2} Serve S.P.: ${engine.serveReturn.player2ServeRating ?? dash}`);
    lines.push(`  ${p1} Return S.P.: ${engine.serveReturn.player1ReturnRating ?? dash}`);
    lines.push(`  ${p2} Return S.P.: ${engine.serveReturn.player2ReturnRating ?? dash}`);
    if (engine.serveReturn.note) lines.push(`  Note: ${engine.serveReturn.note}`);
    lines.push("");
  }

  // ── 5. RECENT FORM ──────────────────────────────────────────────────────
  if (engine.recentForm) {
    lines.push("RECENT FORM");
    lines.push(
      `  ${p1}: ${engine.recentForm.player1Form?.toFixed(1) ?? dash} (${engine.recentForm.player1Trend ?? dash})`
    );
    lines.push(
      `  ${p2}: ${engine.recentForm.player2Form?.toFixed(1) ?? dash} (${engine.recentForm.player2Trend ?? dash})`
    );
    if (
      typeof engine.recentForm.player1OpponentAdjustedCoverage === "number" &&
      typeof engine.recentForm.player2OpponentAdjustedCoverage === "number"
    ) {
      lines.push(
        `  Opponent-Adjusted: ${engine.recentForm.player1OpponentAdjustedCoverage}%/${engine.recentForm.player2OpponentAdjustedCoverage}%`
      );
    }
    if (
      typeof engine.recentForm.player1ServeReturnCoverage === "number" &&
      typeof engine.recentForm.player2ServeReturnCoverage === "number"
    ) {
      lines.push(
        `  Serve/Return Signal: ${engine.recentForm.player1ServeReturnCoverage}%/${engine.recentForm.player2ServeReturnCoverage}%`
      );
    }
    lines.push("");
  }

  // ── 6. HEAD TO HEAD ─────────────────────────────────────────────────────
  if (engine.headToHead) {
    lines.push("HEAD TO HEAD");
    lines.push(`  ${p1}: ${engine.headToHead.player1Wins ?? dash} wins`);
    lines.push(`  ${p2}: ${engine.headToHead.player2Wins ?? dash} wins`);
    lines.push(
      `  Surface meetings: ${engine.headToHead.surfaceMeetings ?? dash} on ${prediction?.surface ?? dash}`
    );
    lines.push("");
  }

  // ── 7. STYLE MATCHUP ────────────────────────────────────────────────────
  if (engine.styleMatchup) {
    lines.push("STYLE MATCHUP");
    const p1Styles =
      engine.styleMatchup.player1Styles?.length
        ? (engine.styleMatchup.player1Styles as string[]).join(", ")
        : "Unknown";
    const p2Styles =
      engine.styleMatchup.player2Styles?.length
        ? (engine.styleMatchup.player2Styles as string[]).join(", ")
        : "Unknown";
    lines.push(`  ${p1}: ${p1Styles}`);
    lines.push(`  ${p2}: ${p2Styles}`);
    lines.push("");
  }

  // ── 8. FATIGUE INDEX ────────────────────────────────────────────────────
  if (engine.fatigue) {
    lines.push("FATIGUE INDEX");
    lines.push(`  ${p1} Fatigue: ${engine.fatigue.player1FatigueScore ?? dash}`);
    lines.push(`  ${p2} Fatigue: ${engine.fatigue.player2FatigueScore ?? dash}`);
    lines.push(`  ${p1} matches (7d): ${engine.fatigue.player1MatchesLast7Days ?? dash}`);
    lines.push(`  ${p2} matches (7d): ${engine.fatigue.player2MatchesLast7Days ?? dash}`);
    lines.push("");
  }

  // ── 9. MONTE CARLO ──────────────────────────────────────────────────────
  if (engine.simulation && typeof engine.simulation.player1WinProbability === "number") {
    const mcHeadline = deriveMonteCarloHeadline({
      predictedWinnerId: String(prediction.predictedWinnerId),
      player1Id: String(prediction.player1Id),
      player1Name: p1,
      player2Name: p2,
      player1WinProbability: Number(engine.simulation.player1WinProbability),
      rangeLow: Number(engine.simulation.rangeLow ?? engine.simulation.player1WinProbability),
      rangeHigh: Number(engine.simulation.rangeHigh ?? engine.simulation.player1WinProbability),
    });

    lines.push("MONTE CARLO");
    lines.push(
      `  Winner: ${mcHeadline.headlineWinnerName} — ${mcHeadline.headlineWinProbability.toFixed(1)}% (range ${mcHeadline.headlineRangeLow.toFixed(0)}–${mcHeadline.headlineRangeHigh.toFixed(0)}%)`
    );
    lines.push(
      `  Straight Sets (${p1}): ${engine.simulation.straightSetsProbabilityPlayer1?.toFixed(1) ?? dash}%`
    );
    lines.push(
      `  Straight Sets (${p2}): ${engine.simulation.straightSetsProbabilityPlayer2?.toFixed(1) ?? dash}%`
    );
    lines.push(
      `  Expected Games (${p1}): ${engine.simulation.expectedGamesPlayer1?.toFixed(1) ?? dash}`
    );
    lines.push(
      `  Expected Games (${p2}): ${engine.simulation.expectedGamesPlayer2?.toFixed(1) ?? dash}`
    );
    lines.push(
      `  Simulations: ${engine.simulation.simulationsRun != null ? engine.simulation.simulationsRun.toLocaleString() : dash}`
    );
    lines.push(`  Input Completeness: ${engine.simulation.inputReliability ?? dash}%`);
    lines.push("");
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push("🤖 Tennis Matrix AI");

  return lines.join("\n");
}
