import type { CalibrationKnot } from "./types";

/**
 * Rows locked before this date and with `tieBreakerApplied=true` in their engine breakdown were
 * scored by the old directional tie-break cascade (removed 2026-07-15), which achieved only
 * ~30.8% accuracy on close matchups vs a 76.9% baseline — far below even a coin flip. Excluding
 * them from calibration training prevents the fitted curve from learning incorrect patterns.
 *
 * The date matches the cascade removal commit (Task #5, 2026-07-15). Any row locked at or after
 * this date was scored by the current engine, which passes tie-band probabilities through
 * unchanged and is not affected.
 */
export const CASCADE_CUTOFF_DATE = new Date("2026-07-15T00:00:00.000Z");

/**
 * Returns true when a row should be excluded from calibration training because it was scored by
 * the old directional tie-break cascade (locked before CASCADE_CUTOFF_DATE) and has
 * `tieBreakerApplied=true` in its stored `engine` breakdown.
 *
 * Accepts either:
 *  - A raw `featureSnapshot` JSONB object (e.g. from evaluationPredictionsTable) whose
 *    `engine.tieBreakerApplied` field is inspected, OR
 *  - A plain `boolean` shorthand when the caller has already extracted the flag directly.
 */
export function isKnownBadCascadeRow(lockedAt: Date, featureSnapshotOrFlag: unknown): boolean {
  if (lockedAt >= CASCADE_CUTOFF_DATE) return false;
  if (typeof featureSnapshotOrFlag === "boolean") return featureSnapshotOrFlag;
  if (!featureSnapshotOrFlag || typeof featureSnapshotOrFlag !== "object") return false;
  const snap = featureSnapshotOrFlag as Record<string, unknown>;
  const engine = snap["engine"] as Record<string, unknown> | undefined;
  return engine?.["tieBreakerApplied"] === true;
}

export interface CalibrationPoint {
  /** Raw predicted probability that player1 wins, 0-1. */
  rawProbability: number;
  /** 1 if player1 actually won, 0 otherwise. */
  outcome: 0 | 1;
}

/**
 * 5%-wide reliability-bucket boundaries for both display (calibration chart / table) and for
 * the calibration-fitting full-range grid. Defined here (not in metrics.ts) so calibration
 * fitting can reuse the exact same boundaries without a circular import — metrics.ts imports
 * this constant for its own bucketing.
 *
 * Previously [50,55,60,65,70,75,80,100] — expanded to 5% bands through 100 so the high-
 * confidence tail (80–100%) gets the same granularity as lower bands.
 * These edges are identical to what was `ECE_BUCKET_EDGES` in metrics.ts, so that constant
 * has been removed and this one is used everywhere.
 */
export const BUCKET_EDGES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

/**
 * Same interval structure as `BUCKET_EDGES`, mirrored around 50 so it spans the full 0-1
 * raw-probability range that calibration fitting operates on (the display buckets only cover
 * 50-100 "confidence"). E.g. [0, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 100].
 */
const FULL_RANGE_BUCKET_EDGES: number[] = (() => {
  const upper = BUCKET_EDGES;
  const lower = [0, ...upper.slice(1, -1).map((e) => 100 - e).reverse()];
  return [...lower, ...upper];
})();

interface WeightedPoint {
  x: number;
  y: number;
  weight: number;
}

/**
 * Weighted Pool Adjacent Violators Algorithm (PAVA) -- the standard non-parametric isotonic
 * regression method (used by scikit-learn's IsotonicRegression). Each input "point" carries a
 * weight (sample count), so a binned reliability curve pools correctly (a bucket built from 400
 * points pulls the fit harder than one built from 8) instead of every bucket counting equally.
 * Anchors the ends to the full [0,1] domain so `applyCalibration` never has to extrapolate.
 */
function pavaFit(weighted: WeightedPoint[]): CalibrationKnot[] {
  if (weighted.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }

  const sorted = [...weighted].sort((a, b) => a.x - b.x);
  const blocks: Array<{ sumX: number; sumY: number; count: number }> = [];
  for (const p of sorted) {
    blocks.push({ sumX: p.x * p.weight, sumY: p.y * p.weight, count: p.weight });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      const lastMean = last.sumY / last.count;
      const prevMean = prev.sumY / prev.count;
      if (prevMean <= lastMean) break;
      prev.sumX += last.sumX;
      prev.sumY += last.sumY;
      prev.count += last.count;
      blocks.pop();
    }
  }

  const knots: CalibrationKnot[] = blocks.map((b) => ({ x: b.sumX / b.count, y: b.sumY / b.count }));
  if (knots[0].x > 0) knots.unshift({ x: 0, y: knots[0].y });
  if (knots[knots.length - 1].x < 1) knots.push({ x: 1, y: knots[knots.length - 1].y });
  return knots;
}

/**
 * Fits an isotonic calibration curve directly on raw per-point outcomes (each point weighted
 * equally). Input must be validation-only points; the caller is responsible for never mixing in
 * test/live data here. Kept alongside `fitIsotonicCalibrationBinned` for callers (e.g. Phase 6
 * specialist segments) that intentionally fit on raw points at smaller per-segment sample sizes.
 *
 * Returns knots sorted ascending by x (raw probability). Apply with `applyCalibration`, which
 * linearly interpolates between knots and clamps outside the observed range.
 */
export function fitIsotonicCalibration(points: CalibrationPoint[]): CalibrationKnot[] {
  if (points.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }
  return pavaFit(points.map((p) => ({ x: p.rawProbability, y: p.outcome, weight: 1 })));
}

/**
 * Reduces validation points to per-bucket (avg predicted, observed rate, N) triples using
 * `FULL_RANGE_BUCKET_EDGES` before returning them as PAVA-ready weighted points. This is what
 * makes the binned isotonic fit reuse "the same bucket boundaries computeCalibrationBuckets
 * already uses for display" -- just mirrored to cover the full raw-probability domain.
 */
export function binCalibrationPoints(points: CalibrationPoint[]): WeightedPoint[] {
  const edges = FULL_RANGE_BUCKET_EDGES.map((e) => e / 100);
  const bins: WeightedPoint[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const min = edges[i];
    const max = edges[i + 1];
    const inBucket = points.filter((p) => p.rawProbability >= min && (max === 1 ? p.rawProbability <= 1 : p.rawProbability < max));
    if (inBucket.length === 0) continue;
    const avgX = inBucket.reduce((sum, p) => sum + p.rawProbability, 0) / inBucket.length;
    const avgY = inBucket.reduce((sum, p) => sum + p.outcome, 0) / inBucket.length;
    bins.push({ x: avgX, y: avgY, weight: inBucket.length });
  }
  return bins;
}

/**
 * Bin-then-fit isotonic calibration: groups validation points into the reliability-bucket
 * structure (see `binCalibrationPoints`), then runs PAVA on those per-bucket (avg predicted,
 * observed rate) pairs weighted by each bucket's own N. This reduces curve jaggedness at current
 * sample sizes compared to fitting on thousands of raw individual points. Used for both per-fold
 * and pooled/live fits (see `fitBestCalibration`).
 */
export function fitIsotonicCalibrationBinned(points: CalibrationPoint[]): CalibrationKnot[] {
  if (points.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }
  const binned = binCalibrationPoints(points);
  if (binned.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }
  return pavaFit(binned);
}

export interface CalibrationSplit {
  fitPoints: CalibrationPoint[];
  holdoutPoints: CalibrationPoint[];
}

/** Fraction of validation data reserved purely for comparing calibration methods -- never used to fit either. */
const HOLDOUT_FRACTION = 0.2;
/** Fixed floor so small per-fold validation sets still hold back a comparison-worthy slice. */
const MIN_HOLDOUT_COUNT = 100;

/**
 * Splits validation points into a fit-only slice and a genuinely held-out comparison slice
 * (20% or `MIN_HOLDOUT_COUNT`, whichever is larger). The holdout slice is never touched by
 * either calibration method's fitting step -- it exists purely so the isotonic-vs-Platt
 * comparison in `fitBestCalibration` isn't measuring a method against data it already saw.
 *
 * Splits by predicted-probability rank (not insertion/chronological order, which could bias the
 * holdout toward one time window) so the held-out slice samples the full probability range --
 * deterministic, no RNG/seed needed.
 */
export function splitForCalibrationHoldout(points: CalibrationPoint[]): CalibrationSplit {
  if (points.length === 0) return { fitPoints: [], holdoutPoints: [] };

  const holdoutSize = Math.max(MIN_HOLDOUT_COUNT, Math.ceil(points.length * HOLDOUT_FRACTION));
  if (holdoutSize >= points.length) {
    // Too little data to genuinely hold anything back -- fit on everything and skip the
    // comparison (caller falls back to isotonic, the already-shipped default) rather than trust
    // a comparison made on a near-empty or fully-overlapping slice.
    return { fitPoints: points, holdoutPoints: [] };
  }

  const sorted = [...points].sort((a, b) => a.rawProbability - b.rawProbability);
  const stride = points.length / holdoutSize;
  const holdoutPoints: CalibrationPoint[] = [];
  const fitPoints: CalibrationPoint[] = [];
  let nextHoldoutMark = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (holdoutPoints.length < holdoutSize && i >= Math.round(nextHoldoutMark)) {
      holdoutPoints.push(sorted[i]);
      nextHoldoutMark += stride;
    } else {
      fitPoints.push(sorted[i]);
    }
  }
  return { fitPoints, holdoutPoints };
}

export interface PlattParams {
  a: number;
  b: number;
}

/**
 * Fits a Platt/sigmoid calibration curve: P(y=1) = sigmoid(a * logit(x) + b), via batch gradient
 * descent (this is a convex 2-parameter logistic regression, so plain gradient descent converges
 * reliably). Internally standardizes the logit inputs (zero mean, unit variance) purely to
 * condition the gradient descent -- the returned `a`/`b` are transformed back to operate on raw
 * `logit(x)` directly, so `applyPlattScaling` needs no knowledge of the standardization.
 */
export function fitPlattScaling(points: CalibrationPoint[]): PlattParams {
  if (points.length === 0) return { a: 1, b: 0 };

  const eps = 1e-3;
  const zs = points.map((p) => {
    const x = Math.max(eps, Math.min(1 - eps, p.rawProbability));
    return Math.log(x / (1 - x));
  });
  const ys = points.map((p) => p.outcome);
  const n = zs.length;

  const mean = zs.reduce((sum, z) => sum + z, 0) / n;
  const variance = zs.reduce((sum, z) => sum + (z - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance) || 1;
  const standardized = zs.map((z) => (z - mean) / std);

  let aPrime = 1;
  let bPrime = 0;
  const learningRate = 0.3;
  const iterations = 400;
  for (let iter = 0; iter < iterations; iter++) {
    let gradA = 0;
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const pred = 1 / (1 + Math.exp(-(aPrime * standardized[i] + bPrime)));
      const err = pred - ys[i];
      gradA += err * standardized[i];
      gradB += err;
    }
    aPrime -= (learningRate * gradA) / n;
    bPrime -= (learningRate * gradB) / n;
  }

  return { a: aPrime / std, b: bPrime - (aPrime * mean) / std };
}

/** Applies a fitted Platt/sigmoid mapping to a new raw probability, clamped to [eps, 1-eps] before the logit transform. */
export function applyPlattScaling(params: PlattParams, rawProbability: number): number {
  const eps = 1e-3;
  const x = Math.max(eps, Math.min(1 - eps, rawProbability));
  const z = Math.log(x / (1 - x));
  const logit = params.a * z + params.b;
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Samples the fitted Platt sigmoid onto a fixed knot grid so it can be stored/applied through
 * the exact same `CalibrationKnot[]` + `applyCalibration` machinery every downstream consumer
 * (specialist segments, live prediction engine, recalibration) already uses -- no separate
 * "if method is platt" branch needed anywhere outside this module.
 */
export function plattToKnots(params: PlattParams, resolution = 100): CalibrationKnot[] {
  const knots: CalibrationKnot[] = [];
  for (let i = 0; i <= resolution; i++) {
    const x = i / resolution;
    knots.push({ x, y: applyPlattScaling(params, x) });
  }
  return knots;
}

/** Applies a fitted isotonic mapping to a new raw probability via linear interpolation, clamped to [0,1]. */
export function applyCalibration(mapping: CalibrationKnot[], rawProbability: number): number {
  const x = Math.max(0, Math.min(1, rawProbability));
  if (mapping.length === 0) return x;
  if (x <= mapping[0].x) return mapping[0].y;
  if (x >= mapping[mapping.length - 1].x) return mapping[mapping.length - 1].y;

  for (let i = 0; i < mapping.length - 1; i++) {
    const a = mapping[i];
    const b = mapping[i + 1];
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return a.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return x;
}

export function logLoss(points: CalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  const eps = 1e-9;
  let sum = 0;
  for (const p of points) {
    const prob = Math.max(eps, Math.min(1 - eps, p.rawProbability));
    sum += p.outcome === 1 ? -Math.log(prob) : -Math.log(1 - prob);
  }
  return sum / points.length;
}

export function brierScore(points: CalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  const sum = points.reduce((acc, p) => acc + (p.rawProbability - p.outcome) ** 2, 0);
  return sum / points.length;
}

export interface CalibrationFitResult {
  knots: CalibrationKnot[];
  method: "isotonic" | "platt";
  isotonicHoldoutLogLoss: number | null;
  plattHoldoutLogLoss: number | null;
  /** Weighted mean absolute calibration gap (predicted vs. observed) on the holdout slice, binned with `binCalibrationPoints`. Null whenever there's no holdout slice. */
  isotonicHoldoutEce: number | null;
  plattHoldoutEce: number | null;
  fitSampleSize: number;
  holdoutSampleSize: number;
}

/**
 * Weighted mean absolute calibration gap (|avg predicted - avg observed|) across the same
 * reliability-bucket structure `binCalibrationPoints` already uses, applied to a mapping's
 * OUTPUT on a held-out slice. This is what makes the Platt-vs-isotonic comparison catch a
 * failure mode plain average log loss can miss: a smooth, globally-monotonic Platt sigmoid can
 * win on average log loss while still bridging over a real local non-monotonic dip in one
 * narrow probability band (Task #128 -- a fold's own validation data showed raw ~62% predictions
 * only won ~51% of the time, a real local violation isotonic's PAVA step is built to absorb but
 * Platt's fixed sigmoid shape cannot represent). Log loss alone doesn't penalize that enough
 * when it's confined to one band, because it's averaged over every point, not every band.
 */
function holdoutCalibrationError(mapping: CalibrationKnot[], holdoutPoints: CalibrationPoint[]): number | null {
  const calibratedPoints: CalibrationPoint[] = holdoutPoints.map((p) => ({
    rawProbability: applyCalibration(mapping, p.rawProbability),
    outcome: p.outcome,
  }));
  const bins = binCalibrationPoints(calibratedPoints);
  if (bins.length === 0) return null;
  let totalWeight = 0;
  let weightedGap = 0;
  for (const bin of bins) {
    weightedGap += Math.abs(bin.x - bin.y) * bin.weight;
    totalWeight += bin.weight;
  }
  return totalWeight > 0 ? weightedGap / totalWeight : null;
}

/**
 * Fits both a binned isotonic curve and a Platt/sigmoid curve on the same fit-only slice of
 * validation data (see `splitForCalibrationHoldout`), evaluates both on the genuinely held-out
 * slice via log loss AND per-bucket calibration error (ECE), and activates whichever generalizes
 * better -- the choice is never hand-picked. Platt only wins when it beats isotonic on log loss
 * AND does not have a worse holdout ECE: Task #128 found a real fold where Platt won on average
 * log loss alone while being meaningfully *more* miscalibrated than isotonic in one specific
 * probability band (a narrow local dip in the true win rate that Platt's smooth sigmoid bridges
 * over but isotonic's PAVA step correctly absorbs) -- exactly the failure mode this ECE guard is
 * for. When there isn't enough data to hold out a meaningful comparison slice, isotonic
 * (the already-shipped default) is used without a comparison, and that is recorded explicitly
 * (`holdoutSampleSize: 0`, all holdout metrics `null`) rather than silently guessed.
 */
export function fitBestCalibration(points: CalibrationPoint[]): CalibrationFitResult {
  if (points.length === 0) {
    return {
      knots: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      method: "isotonic",
      isotonicHoldoutLogLoss: null,
      plattHoldoutLogLoss: null,
      isotonicHoldoutEce: null,
      plattHoldoutEce: null,
      fitSampleSize: 0,
      holdoutSampleSize: 0,
    };
  }

  const { fitPoints, holdoutPoints } = splitForCalibrationHoldout(points);
  const isotonicKnots = fitIsotonicCalibrationBinned(fitPoints);

  if (holdoutPoints.length === 0) {
    return {
      knots: isotonicKnots,
      method: "isotonic",
      isotonicHoldoutLogLoss: null,
      plattHoldoutLogLoss: null,
      isotonicHoldoutEce: null,
      plattHoldoutEce: null,
      fitSampleSize: fitPoints.length,
      holdoutSampleSize: 0,
    };
  }

  const plattParams = fitPlattScaling(fitPoints);
  const plattKnots = plattToKnots(plattParams);

  const isotonicHoldoutLogLoss = logLoss(
    holdoutPoints.map((p) => ({ rawProbability: applyCalibration(isotonicKnots, p.rawProbability), outcome: p.outcome })),
  );
  const plattHoldoutLogLoss = logLoss(
    holdoutPoints.map((p) => ({ rawProbability: applyCalibration(plattKnots, p.rawProbability), outcome: p.outcome })),
  );
  const isotonicHoldoutEce = holdoutCalibrationError(isotonicKnots, holdoutPoints);
  const plattHoldoutEce = holdoutCalibrationError(plattKnots, holdoutPoints);

  const plattBeatsLogLoss =
    plattHoldoutLogLoss !== null && (isotonicHoldoutLogLoss === null || plattHoldoutLogLoss < isotonicHoldoutLogLoss);
  const plattNotWorseCalibrated = plattHoldoutEce === null || isotonicHoldoutEce === null || plattHoldoutEce <= isotonicHoldoutEce;
  const plattWins = plattBeatsLogLoss && plattNotWorseCalibrated;

  return {
    knots: plattWins ? plattKnots : isotonicKnots,
    method: plattWins ? "platt" : "isotonic",
    isotonicHoldoutLogLoss,
    plattHoldoutLogLoss,
    isotonicHoldoutEce,
    plattHoldoutEce,
    fitSampleSize: fitPoints.length,
    holdoutSampleSize: holdoutPoints.length,
  };
}
