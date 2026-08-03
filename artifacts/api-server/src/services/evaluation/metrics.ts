import type { EvaluationPredictionRow } from "@workspace/db";
import { BUCKET_EDGES, brierScore, logLoss, type CalibrationPoint } from "./calibration";

export interface SegmentMetrics {
  n: number;
  accuracy: number | null;
  logLoss: number | null;
  brier: number | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  retiredCount: number;
  retiredAccuracy: number | null;
  voidCount: number;
  missedCount: number;
  /** Expected Calibration Error on raw (pre-calibration) probabilities. Null when n=0. */
  eceRaw: number | null;
  /** Expected Calibration Error on calibrated probabilities. Null when n=0. */
  eceCalibrated: number | null;
}

function toPoint(row: EvaluationPredictionRow): CalibrationPoint | null {
  if (row.calibratedProbability === null || row.actualWinnerId === null) return null;
  const outcome: 0 | 1 = row.actualWinnerId === row.player1Id ? 1 : 0;
  // calibratedProbability is stored 0-100 (player1 win %); logLoss/brier math expects 0-1.
  return { rawProbability: row.calibratedProbability / 100, outcome };
}

function toRawPoint(row: EvaluationPredictionRow): CalibrationPoint | null {
  if (row.rawProbability === null || row.actualWinnerId === null) return null;
  const outcome: 0 | 1 = row.actualWinnerId === row.player1Id ? 1 : 0;
  return { rawProbability: row.rawProbability / 100, outcome };
}

/**
 * Fixed bucket boundaries for Expected Calibration Error, deliberately independent of
 * `BUCKET_EDGES` (the display reliability-bucket boundaries used by `computeCalibrationBuckets`
 * and by the binned isotonic calibration fit). If the dashboard's display buckets ever change,
 * ECE stays comparable release over release instead of silently shifting with them.
 */
// ECE_BUCKET_EDGES is now identical to BUCKET_EDGES (imported from calibration.ts above).
// Both used 5% steps [50, 55, ..., 100]. The separate constant is retained as an alias here
// so that the computeECE function below can continue to reference it by its original name.
const ECE_BUCKET_EDGES = BUCKET_EDGES;

/**
 * A bucket with fewer than this many points has an observed accuracy that's either 0% or (close
 * to) 100% far more often than a real underlying rate would produce -- e.g. a single point is
 * ALWAYS 0% or 100% "accurate", guaranteeing a large confidence/accuracy gap regardless of true
 * calibration. Small evaluation segments (a backtest cohort of a few hundred rows spread across
 * ECE_BUCKET_EDGES' ten buckets, rather than the thousands the full dashboard segments have)
 * concentrate most of their points in the low-confidence buckets and leave the high-confidence
 * tail with only 1-2 points each -- those near-empty buckets otherwise swing the sample-size-
 * weighted average by chance alone. Task #66's near-Elite backtest investigation found exactly
 * this: a 70-75% bucket with n=1 and a 75-80% bucket with n=2 contributed noise indistinguishable
 * from a real calibration problem. Buckets below this floor are excluded from ECE entirely (both
 * numerator and denominator) rather than force-included at full weight or silently zero-weighted.
 */
export const MIN_ECE_BUCKET_SAMPLE = 5;

/**
 * Expected Calibration Error: the sample-size-weighted average gap between confidence (distance
 * from a coin flip toward the predicted winner) and observed accuracy, across `ECE_BUCKET_EDGES`.
 * Buckets with fewer than `MIN_ECE_BUCKET_SAMPLE` points are excluded (see its doc comment) so a
 * handful of sparse high-confidence outcomes can't dominate the metric by chance. 0 = perfectly
 * calibrated. Returns null when there are no buckets left with enough points to score.
 */
export function computeECE(points: CalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  const edges = ECE_BUCKET_EDGES.map((e) => e / 100);
  const buckets: CalibrationPoint[][] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const min = edges[i];
    const max = edges[i + 1];
    const inBucket = points.filter((p) => {
      const confidence = Math.max(p.rawProbability, 1 - p.rawProbability);
      return confidence >= min && (max === 1 ? confidence <= 1 : confidence < max);
    });
    if (inBucket.length >= MIN_ECE_BUCKET_SAMPLE) buckets.push(inBucket);
  }
  const total = buckets.reduce((sum, b) => sum + b.length, 0);
  if (total === 0) return null;

  let ece = 0;
  for (const inBucket of buckets) {
    const avgConfidence = inBucket.reduce((sum, p) => sum + Math.max(p.rawProbability, 1 - p.rawProbability), 0) / inBucket.length;
    const accuracy = inBucket.filter((p) => (p.rawProbability >= 0.5 ? 1 : 0) === p.outcome).length / inBucket.length;
    ece += (inBucket.length / total) * Math.abs(avgConfidence - accuracy);
  }
  return Math.round(ece * 10000) / 10000;
}

/**
 * Computes honestly-scoped accuracy/logLoss/Brier for one segment of evaluation predictions.
 * Only `includedInAccuracy` rows feed the headline numbers; retirements, voids, and misses are
 * always reported as separate counts so a dashboard reader can see exactly what was excluded and
 * why, rather than a single number that quietly absorbs edge cases.
 */
export function computeSegmentMetrics(rows: EvaluationPredictionRow[]): SegmentMetrics {
  const graded = rows.filter((r) => r.status === "graded" || r.status === "void");
  const included = graded.filter((r) => r.includedInAccuracy);
  const points = included.map(toPoint).filter((p): p is CalibrationPoint => p !== null);
  const rawPoints = included.map(toRawPoint).filter((p): p is CalibrationPoint => p !== null);

  const correct = included.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;
  const retired = graded.filter((r) => r.resultType === "retired");
  const retiredCorrect = retired.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;

  const dates = rows.map((r) => r.scheduledStartAt.getTime());
  const dateRangeStart = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
  const dateRangeEnd = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

  return {
    n: included.length,
    accuracy: included.length > 0 ? Math.round((correct / included.length) * 1000) / 10 : null,
    logLoss: logLoss(points),
    brier: brierScore(points),
    dateRangeStart,
    dateRangeEnd,
    retiredCount: retired.length,
    retiredAccuracy: retired.length > 0 ? Math.round((retiredCorrect / retired.length) * 1000) / 10 : null,
    voidCount: rows.filter((r) => r.status === "void").length,
    missedCount: rows.filter((r) => r.status === "missed").length,
    eceRaw: computeECE(rawPoints),
    eceCalibrated: computeECE(points),
  };
}

export interface CalibrationBucket {
  label: string;
  min: number;
  max: number;
  n: number;
  avgPredicted: number | null;
  observedAccuracy: number | null;
  /** Absolute difference between avgPredicted and observedAccuracy (0–100 scale). Null when either is null. */
  calibrationError: number | null;
}

/**
 * Buckets predictions by "distance from a coin flip toward the predicted winner" into 5%-wide
 * bands: 50–55%, 55–60%, ..., 95–100%.
 *
 * Each bucket returns avgPredicted (model's stated confidence), observedAccuracy (actual win
 * rate), and calibrationError (absolute gap between the two). The bucket with the smallest
 * calibrationError is the most trustworthy prediction band.
 */
export function computeCalibrationBuckets(rows: EvaluationPredictionRow[]): CalibrationBucket[] {
  const included = rows.filter(
    (r) => (r.status === "graded" || r.status === "void") && r.includedInAccuracy && r.calibratedProbability !== null,
  );

  return BUCKET_EDGES.slice(0, -1).map((min, i) => {
    const max = BUCKET_EDGES[i + 1]!;
    const inBucket = included.filter((r) => {
      const confidence = Math.max(r.calibratedProbability!, 100 - r.calibratedProbability!);
      return confidence >= min && (max === 100 ? confidence <= 100 : confidence < max);
    });
    const correct = inBucket.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;
    const avgPredictedRaw =
      inBucket.length > 0
        ? inBucket.reduce((sum, r) => sum + Math.max(r.calibratedProbability!, 100 - r.calibratedProbability!), 0) /
          inBucket.length
        : null;

    const avgPredicted = avgPredictedRaw !== null ? Math.round(avgPredictedRaw * 10) / 10 : null;
    const observedAccuracy =
      inBucket.length > 0 ? Math.round((correct / inBucket.length) * 1000) / 10 : null;
    const calibrationError =
      avgPredicted !== null && observedAccuracy !== null
        ? Math.round(Math.abs(avgPredicted - observedAccuracy) * 10) / 10
        : null;

    return {
      // Label uses "50–55%" notation (en-dash, both bounds shown) — human-readable band name.
      label: `${min}–${max}%`,
      min,
      max,
      n: inBucket.length,
      avgPredicted,
      observedAccuracy,
      calibrationError,
    };
  });
}

export interface UpsetRiskTierMetrics {
  tier: string;
  n: number;
  /** Share of these predictions where the model's own favorite lost -- the tier is only doing its
   * job if this rises monotonically LOW -> MODERATE -> HIGH -> EXTREME. */
  favoriteLossRate: number | null;
}

const UPSET_RISK_TIER_ORDER = ["LOW", "MODERATE", "HIGH", "EXTREME"];

/**
 * Favorite-loss-rate per upset-risk tier, scoped to the same honestly-graded/accuracy-eligible
 * rows `computeSegmentMetrics` uses (graded-or-void, `includedInAccuracy`, and here additionally
 * requiring a persisted `upsetRiskTier` -- rows written before that column existed are simply
 * excluded rather than silently miscounted into a tier they were never actually assigned).
 * Task 56 validates disagreement/upset-risk purely via this tier-level monotonicity check, since
 * both modules are pure downstream classifiers of the already-calibrated probability and cannot
 * move accuracy/logLoss/Brier themselves (see index.ts: computeUpsetRisk and disagreement.ts's
 * computeWeightedDisagreement never feed back into calibratedProbability).
 */
export function computeUpsetRiskTierMetrics(rows: EvaluationPredictionRow[]): UpsetRiskTierMetrics[] {
  const included = rows.filter((r) => (r.status === "graded" || r.status === "void") && r.includedInAccuracy && r.upsetRiskTier !== null);

  return UPSET_RISK_TIER_ORDER.map((tier) => {
    const inTier = included.filter((r) => r.upsetRiskTier === tier);
    const favoriteLosses = inTier.filter((r) => r.actualWinnerId !== r.predictedWinnerId).length;
    return {
      tier,
      n: inTier.length,
      favoriteLossRate: inTier.length > 0 ? Math.round((favoriteLosses / inTier.length) * 1000) / 10 : null,
    };
  });
}

export interface DisagreementTierMetrics {
  tier: string;
  n: number;
  accuracy: number | null;
  errorRate: number | null;
}

const DISAGREEMENT_TIER_ORDER = ["Strong", "Moderate", "Mixed", "HighDisagreement"];

/**
 * Accuracy/error-rate per model-agreement tier, same scoping rules as
 * `computeUpsetRiskTierMetrics` above (honestly-graded, accuracy-eligible, persisted-tier-only).
 * A healthy engine should show accuracy falling (error rate rising) from Strong toward
 * HighDisagreement -- disagreement tiers exist to flag genuinely harder matchups, not to be
 * decorative.
 */
export function computeDisagreementTierMetrics(rows: EvaluationPredictionRow[]): DisagreementTierMetrics[] {
  const included = rows.filter((r) => (r.status === "graded" || r.status === "void") && r.includedInAccuracy && r.modelAgreement !== null);

  return DISAGREEMENT_TIER_ORDER.map((tier) => {
    const inTier = included.filter((r) => r.modelAgreement === tier);
    const correct = inTier.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;
    return {
      tier,
      n: inTier.length,
      accuracy: inTier.length > 0 ? Math.round((correct / inTier.length) * 1000) / 10 : null,
      errorRate: inTier.length > 0 ? Math.round(((inTier.length - correct) / inTier.length) * 1000) / 10 : null,
    };
  });
}

export interface MarketEdgeSummary {
  /** How many graded/void rows actually had a market-edge value (odds were available at lock time). */
  n: number;
  /**
   * Average market edge (percentage points), oriented to the model's OWN pick -- positive means
   * the model found more value in its pick than the market priced in, negative means the market
   * was more bullish on the model's pick than the model itself was. Null when n=0. This is a
   * metric distinct from accuracy/logLoss/Brier/ECE: it measures agreement with the market, not
   * with the eventual real-world outcome.
   */
  averageEdge: number | null;
}

/**
 * Rolling average of `marketEdge` across graded/void rows that actually have one -- rows with no
 * odds available at lock time are excluded from both the count and the average, never treated as
 * a 0 edge (that would silently understate real average edge whenever odds coverage is partial).
 */
export function computeMarketEdgeSummary(rows: EvaluationPredictionRow[]): MarketEdgeSummary {
  const graded = rows.filter((r) => r.status === "graded" || r.status === "void");
  const withEdge = graded.filter((r): r is EvaluationPredictionRow & { marketEdge: number } => r.marketEdge !== null && r.marketEdge !== undefined);
  if (withEdge.length === 0) return { n: 0, averageEdge: null };

  const sum = withEdge.reduce((acc, r) => acc + r.marketEdge, 0);
  return { n: withEdge.length, averageEdge: Math.round((sum / withEdge.length) * 100) / 100 };
}

export interface StreakSummary {
  currentStreakType: "win" | "loss" | null;
  currentStreakLength: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

/** Chronological (by scheduledStartAt) win/loss streaks across `includedInAccuracy` rows only. */
export function computeStreaks(rows: EvaluationPredictionRow[]): StreakSummary {
  const included = rows
    .filter((r) => (r.status === "graded" || r.status === "void") && r.includedInAccuracy)
    .sort((a, b) => a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime());

  let longestWin = 0;
  let longestLoss = 0;
  let runType: "win" | "loss" | null = null;
  let runLength = 0;

  for (const row of included) {
    const won = row.actualWinnerId === row.predictedWinnerId;
    const type = won ? "win" : "loss";
    if (type === runType) {
      runLength += 1;
    } else {
      runType = type;
      runLength = 1;
    }
    if (type === "win") longestWin = Math.max(longestWin, runLength);
    else longestLoss = Math.max(longestLoss, runLength);
  }

  return {
    currentStreakType: runType,
    currentStreakLength: runLength,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
  };
}
