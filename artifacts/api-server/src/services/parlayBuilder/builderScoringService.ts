/**
 * Parlay Builder Scoring Service
 *
 * The builder is a VALIDATOR, not an independent predictor. It takes a proposed `selectedPlayerId`
 * (typically the prediction engine's predicted winner) and evaluates how well that side is
 * supported by the underlying feature signals: head-to-head, recent form, surface Elo, fatigue,
 * availability, and style matchup.
 *
 * It does NOT independently declare a winner. Its output (`BuilderResult.decision`) says whether
 * the proposed pick holds up under scrutiny:
 *   - KEEP / BORDERLINE → builder doesn't disagree (crossEngineAgreement = true)
 *   - REMOVE → builder found more support for the opponent (crossEngineAgreement = false)
 *   - DATA_UNAVAILABLE → insufficient data to validate (crossEngineAgreement = null)
 *
 * Relation to existing engine modules:
 *   This service reads the SAME already-computed EngineBreakdown and EngineOutput produced by
 *   `predictionEngine/index.ts`. No re-computation is needed — the builder re-interprets the
 *   module results from the perspective of the proposed selectedPlayerId.
 */

import type { EngineBreakdown, EngineOutput } from "../predictionEngine/index";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FactorScore {
  name: string;
  /** Weight (0-1) used in the builder's validation score blend. */
  weight: number;
  /**
   * Score from -100 to +100 for this factor, where:
   *   positive = favors selectedPlayerId
   *   negative = favors opponent
   *   0 = neutral / no signal
   */
  score: number;
  reasoning: string;
}

export interface DataSourceDiagnostics {
  headsToHeadsCount: number;
  recentFormSampleCount: number;
  surfaceEloReliability: number;
  fatigueDataAvailable: boolean;
  availabilityDataAvailable: boolean;
  styleMatchupReliability: number;
}

export interface BuilderResult {
  /** 0-100: how well the selectedPlayerId is supported. */
  validationScore: number;
  /** 0-100: risk score (inverse of validation, calibrated). */
  riskScore: number;
  /** 0-100: how close the matchup is (mirrors engine's matchupCloseness). */
  matchupCloseness: number;
  /** Reliability grade derived from validationScore. */
  reliabilityGrade: "A" | "B" | "C" | "D" | "F";
  /** Overall parlay grade for including this pick. */
  parlayGrade: "Elite" | "Strong" | "Moderate" | "Weak" | "Reject";
  /** Probability (0-1) that this pick should be excluded from a parlay. */
  removalProbability: number;
  /**
   * Final decision:
   *   KEEP — strong support for selectedPlayerId
   *   BORDERLINE — acceptable but uncertain
   *   REMOVE — evidence favors opponent; selectedPlayerId poorly supported
   *   DATA_UNAVAILABLE — insufficient signals to decide
   */
  decision: "KEEP" | "BORDERLINE" | "REMOVE" | "DATA_UNAVAILABLE";
  reasons: string[];
  criticalFlags: string[];
  /** Data coverage: 0-100, how complete the available evidence is. */
  dataCoverage: number;
  /**
   * Fraction of evaluated factors that support selectedPlayerId (0-1).
   * Higher = more factors agree with the proposed pick.
   */
  sourceAgreement: number;
  sourcesAgreeing: number;
  sourcesTotal: number;
  factorScores: FactorScore[];
  dataSourceDiagnostics: DataSourceDiagnostics;
  builderVersion: string;
}

/** Input snapshot for the builder: takes the engine's already-computed outputs. */
export interface BuilderSnapshot {
  /** The player the builder should validate (typically the engine's predictedWinnerId). */
  selectedPlayerId: string;
  /** The opponent (used to orient sign of factor scores correctly). */
  opponentId: string;
  /** Already-computed engine breakdown (re-interpreted by the builder, not recomputed). */
  engineBreakdown: EngineBreakdown;
  /** Already-computed engine output (used for matchupCloseness, upsetRisk, etc.). */
  engineOutput: EngineOutput;
  /**
   * Whether player1 (the engine's orientation) is the selectedPlayerId.
   * Used to flip sign of player1Edge values to always be "relative to selectedPlayerId".
   */
  selectedIsPlayer1: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const BUILDER_VERSION = "1.0.0";

/**
 * Factor weights used in the builder's validation score blend.
 * These are NOT the same as ensemble weights — the builder is specifically
 * asking "does this player's evidence hold up?" so head-to-head carries
 * more weight here than in the prediction ensemble (where its absence is
 * the normal case and shouldn't dominate the ensemble vote).
 */
const BUILDER_FACTOR_WEIGHTS = {
  surfaceElo: 0.30,
  serveReturn: 0.25,
  recentForm: 0.20,
  headToHead: 0.10,
  fatigue: 0.08,
  availability: 0.07,
} as const;

/** Minimum data coverage (dataCoverage) to return a real decision vs DATA_UNAVAILABLE. */
const MIN_DATA_COVERAGE_FOR_DECISION = 25;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert a player1Edge (positive = favors player1) to a score relative to selectedPlayerId.
 * If selectedIsPlayer1 is true: score = edge (positive = favors selected).
 * If selectedIsPlayer1 is false: score = -edge (flip sign since player2 is selected).
 */
function edgeRelativeToSelected(player1Edge: number, selectedIsPlayer1: boolean): number {
  return selectedIsPlayer1 ? player1Edge : -player1Edge;
}

/** Convert a relative edge (-50..+50 range) to a normalized 0-100 factor score (50 = neutral). */
function normalizeEdgeToScore(relativeEdge: number): number {
  // Clamp to ±50 (the realistic max range of player1Edge values), then map to 0-100
  const clamped = Math.max(-50, Math.min(50, relativeEdge));
  return 50 + clamped;
}

/** Map a factor's normalized score (0-100) and reliability to an actual contribution score. */
function weightedFactorScore(normalizedScore: number, reliability: number): number {
  // If reliability is very low, shrink toward neutral (50 = no signal)
  const reliabilityScale = reliability / 100;
  return 50 + (normalizedScore - 50) * reliabilityScale;
}

/**
 * Compute the reliability grade from a validationScore.
 *   A: >= 70
 *   B: >= 58
 *   C: >= 46
 *   D: >= 34
 *   F: < 34
 */
function toReliabilityGrade(validationScore: number): BuilderResult["reliabilityGrade"] {
  if (validationScore >= 70) return "A";
  if (validationScore >= 58) return "B";
  if (validationScore >= 46) return "C";
  if (validationScore >= 34) return "D";
  return "F";
}

/**
 * Compute the parlay grade from validationScore and matchupCloseness.
 * Matchup closeness penalizes even well-supported picks (a coin-flip matchup is not parlay-worthy).
 */
function toParlayGrade(validationScore: number, matchupCloseness: number): BuilderResult["parlayGrade"] {
  // Closeness penalty: reduce effective validation for genuinely close matchups
  const closenessPenalty = (matchupCloseness / 100) * 10; // max 10pt penalty
  const effective = validationScore - closenessPenalty;

  if (effective >= 72) return "Elite";
  if (effective >= 62) return "Strong";
  if (effective >= 50) return "Moderate";
  if (effective >= 38) return "Weak";
  return "Reject";
}

/**
 * Compute removalProbability from validationScore.
 * Lower validation → higher removal probability. Uses a smooth sigmoid-like mapping.
 */
function toRemovalProbability(validationScore: number): number {
  // Invert and normalize: 100 → 0.00, 50 → 0.35, 25 → 0.70, 0 → 1.00
  const inverted = (100 - validationScore) / 100;
  // Apply mild nonlinear shaping so the middle stays moderate
  return Math.round(Math.pow(inverted, 0.75) * 100) / 100;
}

// ── Main function ──────────────────────────────────────────────────────────────

/**
 * Compute the builder's validation score for a proposed selectedPlayerId.
 * Takes an already-computed BuilderSnapshot (wrapping the engine's EngineBreakdown + EngineOutput)
 * and re-interprets the feature module results from the perspective of the selected player.
 *
 * This is synchronous and does NOT query the database — it only reads the engine's already-
 * computed module outputs, which are available in every stored prediction.
 */
export function computeBuilderScore(snapshot: BuilderSnapshot): BuilderResult {
  const { engineBreakdown, engineOutput, selectedIsPlayer1 } = snapshot;

  const reasons: string[] = [];
  const criticalFlags: string[] = [];
  const factorScores: FactorScore[] = [];

  // ── Surface Elo factor ──
  const surfaceEloRelEdge = edgeRelativeToSelected(engineBreakdown.surfaceElo.player1Edge, selectedIsPlayer1);
  const surfaceEloReliability = engineBreakdown.surfaceElo.reliability;
  const surfaceEloNorm = weightedFactorScore(normalizeEdgeToScore(surfaceEloRelEdge), surfaceEloReliability);
  factorScores.push({
    name: "Surface Elo",
    weight: BUILDER_FACTOR_WEIGHTS.surfaceElo,
    score: surfaceEloNorm,
    reasoning: engineBreakdown.surfaceElo.summary,
  });

  if (surfaceEloNorm < 35 && surfaceEloReliability >= 60) {
    criticalFlags.push("Surface Elo strongly favors opponent");
  } else if (surfaceEloNorm < 40) {
    reasons.push("Surface Elo leans toward opponent");
  }

  // ── Serve & Return factor ──
  const serveReturnRelEdge = edgeRelativeToSelected(engineBreakdown.serveReturn.player1Edge, selectedIsPlayer1);
  const serveReturnReliability = engineBreakdown.serveReturn.reliability;
  const serveReturnNorm = weightedFactorScore(normalizeEdgeToScore(serveReturnRelEdge), serveReturnReliability);
  factorScores.push({
    name: "Serve & Return",
    weight: BUILDER_FACTOR_WEIGHTS.serveReturn,
    score: serveReturnNorm,
    reasoning: engineBreakdown.serveReturn.summary,
  });

  if (serveReturnNorm < 35 && serveReturnReliability >= 60) {
    criticalFlags.push("Serve/return metrics strongly favor opponent");
  }

  // ── Recent Form factor ──
  const recentFormRelEdge = edgeRelativeToSelected(engineBreakdown.recentForm.player1Edge, selectedIsPlayer1);
  const recentFormReliability = engineBreakdown.recentForm.reliability;
  const recentFormNorm = weightedFactorScore(normalizeEdgeToScore(recentFormRelEdge), recentFormReliability);
  factorScores.push({
    name: "Recent Form",
    weight: BUILDER_FACTOR_WEIGHTS.recentForm,
    score: recentFormNorm,
    reasoning: engineBreakdown.recentForm.summary,
  });

  if (recentFormNorm < 38) {
    reasons.push("Recent form does not support this pick");
  }

  // ── Head-to-Head factor ──
  const h2hRelEdge = edgeRelativeToSelected(engineBreakdown.headToHead.player1Edge, selectedIsPlayer1);
  const h2hReliability = engineBreakdown.headToHead.reliability;
  const h2hNorm = weightedFactorScore(normalizeEdgeToScore(h2hRelEdge), h2hReliability);
  const h2hLowData = h2hReliability < 35; // Common for first meetings — not a critical flag
  factorScores.push({
    name: "Head-to-Head",
    weight: BUILDER_FACTOR_WEIGHTS.headToHead,
    score: h2hNorm,
    reasoning: engineBreakdown.headToHead.summary,
  });

  if (!h2hLowData && h2hNorm < 35) {
    reasons.push("Head-to-head record favors opponent");
  }

  // ── Fatigue factor ──
  const fatigueRelEdge = edgeRelativeToSelected(engineBreakdown.fatigue.player1Edge, selectedIsPlayer1);
  const fatigueReliability = engineBreakdown.fatigue.reliability;
  const fatigueNorm = weightedFactorScore(normalizeEdgeToScore(fatigueRelEdge), fatigueReliability);
  const fatigueDataAvailable = fatigueReliability > 20;
  factorScores.push({
    name: "Fatigue",
    weight: BUILDER_FACTOR_WEIGHTS.fatigue,
    score: fatigueNorm,
    reasoning: engineBreakdown.fatigue.summary,
  });

  if (fatigueNorm < 30 && fatigueReliability >= 50) {
    criticalFlags.push("Significant fatigue concern for selected player");
  }

  // ── Availability factor ──
  const availabilityRelEdge = edgeRelativeToSelected(engineBreakdown.availability.player1Edge, selectedIsPlayer1);
  const availabilityReliability = engineBreakdown.availability.reliability;
  const availabilityNorm = weightedFactorScore(normalizeEdgeToScore(availabilityRelEdge), availabilityReliability);
  const availabilityDataAvailable = availabilityReliability > 20;
  factorScores.push({
    name: "Availability",
    weight: BUILDER_FACTOR_WEIGHTS.availability,
    score: availabilityNorm,
    reasoning: engineBreakdown.availability.summary,
  });

  if (availabilityNorm < 30 && availabilityReliability >= 50) {
    criticalFlags.push("Availability concerns for selected player");
  }

  // ── Weighted validation score ──
  // Weights must sum to 1.0 (they do in BUILDER_FACTOR_WEIGHTS)
  const totalWeight = Object.values(BUILDER_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  const weightedSum =
    surfaceEloNorm * BUILDER_FACTOR_WEIGHTS.surfaceElo +
    serveReturnNorm * BUILDER_FACTOR_WEIGHTS.serveReturn +
    recentFormNorm * BUILDER_FACTOR_WEIGHTS.recentForm +
    h2hNorm * BUILDER_FACTOR_WEIGHTS.headToHead +
    fatigueNorm * BUILDER_FACTOR_WEIGHTS.fatigue +
    availabilityNorm * BUILDER_FACTOR_WEIGHTS.availability;
  const validationScore = Math.round(weightedSum / totalWeight);
  const riskScore = Math.round(100 - validationScore);

  // ── matchupCloseness: re-use engine's matchupCloseness signal ──
  // Map "CLOSE" → high closeness, etc.
  let matchupClosenessValue: number;
  const mc = engineBreakdown.matchupCloseness;
  if (mc === "CLOSE") {
    matchupClosenessValue = 85;
  } else if (mc === "MODERATE") {
    matchupClosenessValue = 55;
  } else {
    matchupClosenessValue = 25; // LOPSIDED
  }

  // ── Data coverage ──
  // Average the reliability scores (proxy for how much data we have to work with)
  const reliabilities = [
    surfaceEloReliability,
    serveReturnReliability,
    recentFormReliability,
    h2hLowData ? 0 : h2hReliability, // Don't penalize for expected absence of prior meetings
    fatigueDataAvailable ? fatigueReliability : 0,
    availabilityDataAvailable ? availabilityReliability : 0,
  ];
  const dataCoverage = Math.round(reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length);

  // ── Source agreement ──
  const agreementThreshold = 52; // >52 = factor "agrees" with selected player
  const agreeingFactors = factorScores.filter((f) => f.score > agreementThreshold);
  const sourcesAgreeing = agreeingFactors.length;
  const sourcesTotal = factorScores.length;
  const sourceAgreement = Math.round((sourcesAgreeing / sourcesTotal) * 100) / 100;

  // ── Decision ──
  let decision: BuilderResult["decision"];

  if (dataCoverage < MIN_DATA_COVERAGE_FOR_DECISION) {
    decision = "DATA_UNAVAILABLE";
    reasons.push("Insufficient data to validate this pick");
  } else if (criticalFlags.length >= 2 || validationScore < 35) {
    decision = "REMOVE";
    reasons.push("Multiple critical concerns or very low validation score");
  } else if (criticalFlags.length === 1 || validationScore < 45) {
    decision = "REMOVE";
    reasons.push("Evidence does not strongly support selected player");
  } else if (validationScore < 55 || matchupClosenessValue >= 80) {
    decision = "BORDERLINE";
    reasons.push(
      matchupClosenessValue >= 80
        ? "Genuinely close matchup — any pick carries substantial risk"
        : "Moderate support; include with caution"
    );
  } else {
    decision = "KEEP";
    reasons.push("Selected player is well-supported by the evidence");
  }

  // Positive reasons for strong picks
  if (validationScore >= 65 && sourceAgreement >= 0.7) {
    reasons.unshift(`${sourcesAgreeing}/${sourcesTotal} factors support selected player`);
  }

  const dataSourceDiagnostics: DataSourceDiagnostics = {
    headsToHeadsCount: h2hLowData ? 0 : engineBreakdown.headToHead.reliability,
    recentFormSampleCount: recentFormReliability,
    surfaceEloReliability,
    fatigueDataAvailable,
    availabilityDataAvailable,
    styleMatchupReliability: engineBreakdown.styleMatchup?.reliability ?? 0,
  };

  return {
    validationScore,
    riskScore,
    matchupCloseness: matchupClosenessValue,
    reliabilityGrade: toReliabilityGrade(validationScore),
    parlayGrade: toParlayGrade(validationScore, matchupClosenessValue),
    removalProbability: toRemovalProbability(validationScore),
    decision,
    reasons: reasons.filter((r, i, a) => a.indexOf(r) === i), // dedup
    criticalFlags,
    dataCoverage,
    sourceAgreement,
    sourcesAgreeing,
    sourcesTotal,
    factorScores,
    dataSourceDiagnostics,
    builderVersion: BUILDER_VERSION,
  };
}

/**
 * Compute the cross-engine agreement boolean from a BuilderResult's decision.
 *
 * The builder was run with the engine's own selectedPlayerId as its input. So:
 *   - KEEP / BORDERLINE → builder doesn't disagree → agreement = true
 *   - REMOVE → builder found more support for the opponent → agreement = false
 *   - DATA_UNAVAILABLE → insufficient data → agreement = null (unknown, not false)
 */
export function computeCrossEngineAgreement(
  builderDecision: BuilderResult["decision"]
): boolean | null {
  if (builderDecision === "KEEP" || builderDecision === "BORDERLINE") return true;
  if (builderDecision === "REMOVE") return false;
  return null; // DATA_UNAVAILABLE
}
