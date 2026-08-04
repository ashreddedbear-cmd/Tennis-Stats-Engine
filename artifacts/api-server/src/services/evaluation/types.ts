import type { EngineBreakdown } from "../predictionEngine";

/**
 * Bumped whenever the historical walk-forward scoring APPROACH materially changes -- not the
 * same thing as `LIVE_MODEL_VERSION`, which tracks the ensemble engine's own logic. Historical
 * rows tagged `phase4-historical-v1` (written before this version existed) used a deliberately
 * reduced Elo/form/game-share reconstruction and stored the legacy `HistoricalFeatureSnapshot`
 * shape below, because Phase 3's backfill hadn't yet captured enough raw per-match data to
 * reconstruct the full live engine's inputs. From `phase8-historical-live-engine-v1` onward,
 * historical_test rows instead run the exact same `runPredictionEngine` ensemble live/paper-trade
 * predictions use (see `historicalScoring.ts`) and embed a real `LiveFeatureSnapshot` -- so this
 * constant now tags "which historical-scoring generation produced this row" rather than a
 * genuinely different algorithm.
 */
export const HISTORICAL_MODEL_VERSION = "phase8-historical-live-engine-v1";
/**
 * Bumped whenever the live ensemble engine (predictionEngine/index.ts) materially changes.
 * v2 (2026-07-13): fix-the-engine pass driven by the ablation report -- Availability excluded
 * from ensemble voting, Surface Elo/Serve & Return/Recent Form given a fixed higher voting-weight
 * prior, Serve & Return/Recent Form individually confidence-shrunk, a tie-break cascade replaces
 * pure averaging when core signals are close, and an Elite Prediction tier was added.
 */
export const LIVE_MODEL_VERSION = "phase9-fixed-ensemble-v2";

export type RunKind = "historical_test" | "paper_trade" | "live" | "paper_trade_shadow";
export type Segment = "validation" | "test" | "live";
export type PredictionStatus = "pending" | "graded" | "void" | "missed";
export type ResultType = "normal" | "retired" | "walkover" | "cancelled";
export type RetirementRule = "excluded" | "included";

/**
 * LEGACY shape. Only present on historical_test rows written before `HISTORICAL_MODEL_VERSION`
 * was `phase8-historical-live-engine-v1` -- back when Phase 3's backfill hadn't yet captured
 * enough raw per-match data to reconstruct the full live engine's inputs, so historical scoring
 * used this deliberately reduced Elo/form/game-share approximation instead. New historical_test
 * rows use `LiveFeatureSnapshot` (below) like every other run kind. Kept only so old rows already
 * in the database remain typed/readable.
 */
export interface HistoricalFeatureSnapshot {
  modelVersion: "phase4-historical-v1";
  player1: PlayerReducedFeatures;
  player2: PlayerReducedFeatures;
  eloEdge: number;
  formEdge: number;
  gameShareEdge: number;
}

export interface PlayerReducedFeatures {
  matchesPlayed: number;
  eloOverall: number | null;
  eloSurface: number | null;
  winPctLast10: number | null;
  gameShareLast10: number | null;
}

/**
 * Feature snapshot stored for a paper_trade/live row, and (from `phase8-historical-live-engine-v1`
 * onward) historical_test rows too: the real, full live engine breakdown, since historical
 * backtests now run the exact same `runPredictionEngine` call live predictions do.
 */
export interface LiveFeatureSnapshot {
  modelVersion: typeof LIVE_MODEL_VERSION;
  engine: EngineBreakdown;
  preCalibrationProbability: number;
  /**
   * Denormalized copy of `EngineOutput.dataQuality`/`isEliteTier` at scoring time -- these already
   * live inside `engine`/`EngineOutput`, but evaluation reporting (accuracy by data-quality
   * bucket, elite-tier accuracy) reads `evaluation_predictions` rows directly without re-running
   * the engine, so they're captured here explicitly rather than requiring every report to reach
   * into the nested breakdown shape.
   */
  dataQuality?: number;
  isEliteTier?: boolean;
}

export interface CalibrationKnot {
  x: number;
  y: number;
}
