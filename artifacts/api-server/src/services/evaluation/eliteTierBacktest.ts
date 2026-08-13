import type { EvaluationPredictionRow } from "@workspace/db";
import { computeSegmentMetrics, type SegmentMetrics } from "./metrics";
import { computeEliteTier, computeNearEliteTier, voteFavorsPlayer1, type EliteTierInputs } from "../predictionEngine/eliteTier";
import type { EngineBreakdown } from "../predictionEngine";
import type { LiveFeatureSnapshot } from "./types";

/**
 * Task 46 ("Accumulate and backtest a real Elite tier sample"): minimum sample size before the
 * Elite tier backtest is treated as meaningful. Matches the project's existing convention for
 * "small but non-trivial" thresholds -- `MIN_VALIDATION_SAMPLES_FOR_SEGMENT` (Phase 6 specialist
 * segments) and `simulatorValidationTable.minSampleSize` (Phase 7 simulator validation) both use
 * 30 for the same reason: fewer points than that makes accuracy/logLoss too noisy to headline.
 */
export const ELITE_TIER_BACKTEST_MIN_SAMPLE_SIZE = 30;

export interface EliteTierBacktestSummary {
  minSampleSize: number;
  /** Real Elite tier: every gate in `computeEliteTier` genuinely met, including a real segment specialist. */
  elite: SegmentMetrics;
  eliteMeetsMinSample: boolean;
  /**
   * Backtest-only comparison group: every Elite gate met EXCEPT segment-specialist support (see
   * `computeNearEliteTier`). Disjoint from `elite` -- a row counted here is never also counted as
   * `elite`. Since Task #65, historical walk-forward rows CAN earn real Elite tier when a
   * validated previous-cycle specialist exists for their segment (see
   * `HistoricalScoringContext.specialistRowsBySegmentKey`); this group now catches rows/segments
   * where no such specialist was available yet, rather than being the only group historical
   * scoring could ever populate.
   */
  nearElite: SegmentMetrics;
  nearEliteMeetsMinSample: boolean;
}

/**
 * A graded row's `featureSnapshot` only carries enough to reconstruct Elite-tier gating once it
 * has the full live `EngineBreakdown` (models, modelAgreement, modelConflict, specialistApplied,
 * upsetRiskBreakdown) -- fields that were added at different points as the engine evolved. Rows
 * predating any of them are honestly excluded from classification rather than guessed at.
 */
function extractEngineBreakdown(snapshot: unknown): EngineBreakdown | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const candidate = (snapshot as Partial<LiveFeatureSnapshot>).engine;
  if (!candidate || typeof candidate !== "object") return null;
  const engine = candidate as EngineBreakdown;
  if (!Array.isArray(engine.models)) return null;
  if (typeof engine.modelAgreement !== "string") return null;
  if (typeof engine.modelConflict !== "boolean") return null;
  if (typeof engine.specialistApplied !== "boolean") return null;
  if (!engine.upsetRiskBreakdown || typeof engine.upsetRiskBreakdown.upsetRisk !== "string") return null;
  const snapshotDataQuality = (snapshot as Partial<LiveFeatureSnapshot>).dataQuality;
  if (typeof snapshotDataQuality !== "number") return null;
  return engine;
}

function toEliteTierInputs(engine: EngineBreakdown, dataQuality: number, calibratedProbability: number): EliteTierInputs {
  return {
    dataQuality,
    calibratedProbability,
    surfaceEloFavorsPlayer1: voteFavorsPlayer1(engine.models, "Surface Elo"),
    serveReturnFavorsPlayer1: voteFavorsPlayer1(engine.models, "Serve & Return"),
    recentFormFavorsPlayer1: voteFavorsPlayer1(engine.models, "Recent Form"),
    specialistApplied: engine.specialistApplied,
    segmentLabel: engine.segmentLabel,
    modelConflict: engine.modelConflict,
    modelAgreement: engine.modelAgreement,
    upsetRisk: engine.upsetRiskBreakdown.upsetRisk,
    eloGapPoints: Math.abs(engine.surfaceElo.eloDifference),
  };
}

/**
 * Classifies one graded/void evaluation_predictions row as real-Elite, near-Elite (backtest-only,
 * specialist requirement relaxed), or neither. Recomputed from the row's own stored engine
 * breakdown rather than trusting `featureSnapshot.isEliteTier` at face value -- this keeps the
 * classifier correct even if a future engine change alters Elite gating, since old rows still
 * carry the raw inputs needed to re-derive their tier under the CURRENT gating logic.
 */
export function classifyEliteTierRow(row: EvaluationPredictionRow): { isElite: boolean; isNearElite: boolean } {
  const engine = extractEngineBreakdown(row.featureSnapshot);
  if (!engine) return { isElite: false, isNearElite: false };
  if (row.calibratedProbability === null) return { isElite: false, isNearElite: false };
  const dataQuality = (row.featureSnapshot as LiveFeatureSnapshot).dataQuality as number;
  const inputs = toEliteTierInputs(engine, dataQuality, row.calibratedProbability);
  const { isEliteTier } = computeEliteTier(inputs);
  if (isEliteTier) return { isElite: true, isNearElite: false };
  const { isNearEliteTier } = computeNearEliteTier(inputs);
  return { isElite: false, isNearElite: isNearEliteTier };
}

/**
 * Splits already-graded evaluation rows into the real-Elite and near-Elite groups and scores each
 * with the exact same `computeSegmentMetrics` every other segment on the Accuracy dashboard uses
 * (n, accuracy, logLoss, brier, ECE) -- no separate methodology for this tier. Callers should pass
 * genuinely-unseen rows (historical_test test-segment + paper_trade/live), matching how the rest
 * of the dashboard already separates "used for calibration" from "genuinely unseen".
 */
export function computeEliteTierBacktest(rows: EvaluationPredictionRow[]): EliteTierBacktestSummary {
  const eliteRows: EvaluationPredictionRow[] = [];
  const nearEliteRows: EvaluationPredictionRow[] = [];

  for (const row of rows) {
    if (row.status !== "graded" && row.status !== "void") continue;
    const { isElite, isNearElite } = classifyEliteTierRow(row);
    if (isElite) eliteRows.push(row);
    else if (isNearElite) nearEliteRows.push(row);
  }

  const elite = computeSegmentMetrics(eliteRows);
  const nearElite = computeSegmentMetrics(nearEliteRows);

  return {
    minSampleSize: ELITE_TIER_BACKTEST_MIN_SAMPLE_SIZE,
    elite,
    eliteMeetsMinSample: elite.n >= ELITE_TIER_BACKTEST_MIN_SAMPLE_SIZE,
    nearElite,
    nearEliteMeetsMinSample: nearElite.n >= ELITE_TIER_BACKTEST_MIN_SAMPLE_SIZE,
  };
}
