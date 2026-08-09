import { db, evaluationPredictionsTable, historicalMatchesTable, specialistModelsTable, type SpecialistModelRow } from "@workspace/db";
import { and, eq, sql, gte } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { fitBestCalibration, splitForCalibrationHoldout, applyCalibration, logLoss, brierScore, isKnownBadCascadeRow, CASCADE_CUTOFF_DATE, type CalibrationPoint } from "./calibration";
// Note: applyCalibration (not applyCalibrationOriented) is correct in the scoringPoints
// comparison loops below — those points are already in predicted-winner space (x in [0.5,1.0])
// after the training fix, so no re-orientation is needed for the internal log-loss comparison.
import { listCandidateSegments, resolveSegment, type SegmentDefinition } from "../predictionEngine/segments";
import type { CalibrationKnot } from "./types";
import type { SegmentSpecialistInput } from "../predictionEngine/types";
import type { Surface } from "../tennisData/types";

/**
 * A segment needs at least this many real historical matches (Phase 3 coverage, regardless of
 * whether they were ever scored) before it's even considered for a dedicated specialist. Below
 * this, a segment-specific calibration curve would be fit on noise -- the general model's much
 * larger pooled sample is the more honest estimate. This mirrors `runWalkForwardEvaluation`'s own
 * floor (it refuses to run at all under 20 matches total) scaled up per segment, since a segment
 * is inherently a slice of that same corpus.
 */
export const MIN_HISTORICAL_MATCHES_FOR_SEGMENT = 150;

/**
 * A segment also needs at least this many validation-window predictions with a known outcome
 * before its own isotonic curve is trusted -- fitting PAVA on a handful of points produces a
 * curve that just memorizes those points rather than generalizing. 30 is the same rough floor
 * used elsewhere in this codebase for "low-confidence but non-trivial" sample sizes (e.g.
 * `computeSegmentMetrics`'s callers already treat sub-30 samples as too thin to headline).
 */
export const MIN_VALIDATION_SAMPLES_FOR_SEGMENT = 30;

/**
 * Task #68: a specialist that achieves less than this raw accuracy on its own held-out slice is
 * rejected as too close to random to be worth blending. At 53% (barely above a coin flip) the
 * segment adds measurement noise rather than signal -- even at 0.809 blend weight it pulls
 * predictions away from the general model's better-calibrated estimate. 55% is the minimum
 * threshold at which a specialist shows meaningful, separable skill beyond the base rate.
 * `computeOneSegment` checks this BEFORE calling `computeSpecialistWeight` so the segment is
 * cleanly excluded even when log-loss degradation is within noise.
 */
export const MIN_SPECIALIST_ACCURACY = 55;

export interface SpecialistSegmentSummary extends SpecialistModelRow {}

/**
 * Recomputes every candidate tour/surface specialist segment from the walk-forward runner's own
 * validation-segment output and persists the result. Must be called only after
 * `runWalkForwardEvaluation` has finished writing its historical_test rows for this run -- this
 * function does not run any evaluation itself, it only measures and weights what Phase 4 already
 * produced.
 *
 * For each candidate segment:
 *  - Counts real historical matches in that tour+surface (the Phase 3 coverage check).
 *  - Below `MIN_HISTORICAL_MATCHES_FOR_SEGMENT` or `MIN_VALIDATION_SAMPLES_FOR_SEGMENT`: persisted
 *    with `meetsThreshold=false` and `weight=0` -- the live engine falls back to the general model
 *    entirely for this segment, with a visible disclaimer, rather than fitting an under-trained
 *    curve silently.
 *  - Otherwise: fits a segment-only calibration (isotonic or Platt, holdout-validated exactly like
 *    the general model -- see `fitBestCalibration`) from that segment's validation points, and
 *    compares its logLoss against the pooled/general mapping applied to the SAME held-out slice
 *    (when the segment has enough points to hold one back) -- the fair, apples-to-apples,
 *    non-overfit baseline. The specialist's blend weight is derived only from that measured
 *    improvement (or lack of it), never hand-picked.
 */
export async function computeAndStoreSpecialistSegments(generalMapping: CalibrationKnot[]): Promise<SpecialistSegmentSummary[]> {
  const segments = listCandidateSegments();
  const results: SpecialistSegmentSummary[] = [];

  for (const segment of segments) {
    const summary = await computeOneSegment(segment, generalMapping);
    const [upserted] = await db
      .insert(specialistModelsTable)
      .values(summary)
      .onConflictDoUpdate({
        target: specialistModelsTable.segmentKey,
        set: { ...summary, computedAt: new Date() },
      })
      .returning();
    results.push(upserted);
  }

  logger.info(
    { segments: results.map((r) => ({ key: r.segmentKey, meetsThreshold: r.meetsThreshold, weight: r.weight, n: r.validationSampleSize })) },
    "Recomputed Phase 6 specialist segment weights",
  );

  return results;
}

async function computeOneSegment(segment: SegmentDefinition, generalMapping: CalibrationKnot[]) {
  // historical_matches.tour stores the generic tour label ('ATP', 'WTA', 'Challenger', 'ITF').
  // Use eq(col, segment.tour) — 'ATP' / 'WTA' — not inArray with tournament_level values like
  // 'ATP250'/'Masters1000', which live in the separate tournament_level column.
  const [{ count: historicalMatchCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(historicalMatchesTable)
    .where(and(eq(historicalMatchesTable.tour, segment.tour), eq(historicalMatchesTable.surface, segment.surface)));

  const base = {
    segmentKey: segment.segmentKey,
    tour: segment.tour,
    surface: segment.surface,
    label: segment.label,
    historicalMatchCount,
  };

  if (historicalMatchCount < MIN_HISTORICAL_MATCHES_FOR_SEGMENT) {
    return {
      ...base,
      meetsThreshold: false,
      validationSampleSize: 0,
      accuracy: null,
      logLoss: null,
      brier: null,
      generalAccuracy: null,
      generalLogLoss: null,
      generalBrier: null,
      calibrationMapping: [],
      weight: 0,
    };
  }

  // Validation-segment rows for this tour+surface: historical_test rows only (paper_trade rows
  // aren't tied to a historicalMatchId and haven't yet accumulated their own leak-proof corpus),
  // joined back to historicalMatches for the authoritative per-match tour.
  //
  // Task #56: mirrors the same cascade-exclusion filter walkForward.ts applies during general
  // calibration training. Rows locked before CASCADE_CUTOFF_DATE with tieBreakerApplied=true
  // were scored by the old directional cascade (~30.8% accuracy on close matchups) and must not
  // contaminate specialist fitting. SQL pre-filters pre-cutoff rows at query time; isKnownBadCascadeRow
  // double-checks the tieBreakerApplied flag in-memory for any pre-cutoff rows that do appear.
  const rows = await db
    .select({
      rawProbability: evaluationPredictionsTable.rawProbability,
      player1Id: evaluationPredictionsTable.player1Id,
      actualWinnerId: evaluationPredictionsTable.actualWinnerId,
      includedInAccuracy: evaluationPredictionsTable.includedInAccuracy,
      lockedAt: evaluationPredictionsTable.lockedAt,
      // Extract only the single boolean flag we need from the JSONB — avoids pulling the full
      // (potentially large) featureSnapshot just for a cascade-exclusion check.
      tieBreakerApplied: sql<boolean | null>`(${evaluationPredictionsTable.featureSnapshot}->'engine'->>'tieBreakerApplied')::boolean`,
    })
    .from(evaluationPredictionsTable)
    .innerJoin(historicalMatchesTable, eq(evaluationPredictionsTable.historicalMatchId, historicalMatchesTable.id))
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        eq(evaluationPredictionsTable.segment, "validation"),
        eq(evaluationPredictionsTable.includedInAccuracy, true),
        eq(historicalMatchesTable.tour, segment.tour),
        eq(historicalMatchesTable.surface, segment.surface),
      ),
    );

  const cascadeBadCount = rows.filter((r) => isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied ?? false)).length;
  if (cascadeBadCount > 0) {
    logger.warn(
      { segmentKey: segment.segmentKey, cascadeBadCount, total: rows.length },
      "Task #56: excluding known-bad pre-cascade rows from specialist calibration fitting",
    );
  }

  const points: CalibrationPoint[] = rows
    .filter((r) => r.rawProbability !== null && r.actualWinnerId !== null)
    .filter((r) => !isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied ?? false))
    .map((r) => {
      // Orientation fix (2026-08-09): train in predicted-winner space, not player1 space.
      // x = max(raw01, 1-raw01): model's confidence in its own pick, always in [0.5, 1.0].
      // outcome = 1 if the predicted winner actually won.
      const raw = (r.rawProbability as number) / 100; // normalize DB 0-100 → 0-1
      const predictedPlayer1 = raw >= 0.5;
      const actualPlayer1Won = r.actualWinnerId === r.player1Id;
      return {
        rawProbability: predictedPlayer1 ? raw : 1 - raw,
        outcome: (predictedPlayer1 === actualPlayer1Won ? 1 : 0) as 0 | 1,
      };
    });

  if (points.length < MIN_VALIDATION_SAMPLES_FOR_SEGMENT) {
    return {
      ...base,
      meetsThreshold: false,
      validationSampleSize: points.length,
      accuracy: null,
      logLoss: null,
      brier: null,
      generalAccuracy: null,
      generalLogLoss: null,
      generalBrier: null,
      calibrationMapping: [],
      weight: 0,
    };
  }

  // Task #151: was `fitIsotonicCalibration(points)` fit AND scored on the exact same points --
  // in-sample, unlike the pooled/general model (`fitBestCalibration`), which always fits on a
  // held-out-aware split. The 2026-07-13 ablation report caught the consequence: the Active
  // Segment Specialist looked well-calibrated at fit time (this in-sample scoring) but was
  // measurably overconfident when replayed against fresh matches (60.1% predicted vs. 56.8%
  // observed, n=2,036, 3.3pt gap). Switched to the same holdout-validated `fitBestCalibration`
  // pipeline the general model uses (isotonic vs. Platt, picked by genuinely held-out log loss +
  // ECE) so a segment gets exactly the same non-overfit treatment.
  //
  // Task #157 re-check (2026-07-15, docs/audit-task157-confidence-discount-revalidation.md): this
  // fix is currently UNVERIFIABLE against live/backtest data -- `specialist_models` has zero rows
  // in the current environment (no walk-forward run has called `computeAndStoreSpecialistSegments`
  // since this fix landed), confirmed by a fresh ablation replay where the Active Segment
  // Specialist voted on zero matches. Populating it requires a real walk-forward run, which was
  // deliberately NOT triggered here: `runWalkForwardEvaluation` wipes all prior evaluation history
  // on every call (Task #135, still open), so running it just to satisfy this check would trade a
  // small verification gap for a much bigger, unrelated one. See the audit doc for the follow-up.
  const fitResult = fitBestCalibration(points);
  const segmentMapping = fitResult.knots;

  // Score against the SAME held-out slice `fitBestCalibration` used to pick its method -- never
  // the points the curve was fit on, so this reported accuracy/logLoss/brier (and the weight
  // derived from them below) are a fair, non-overfit comparison against the general mapping.
  // `splitForCalibrationHoldout` is deterministic (rank-based, no RNG), so calling it again here
  // reproduces the exact same split `fitBestCalibration` used internally. Below ~125 validation
  // points there isn't enough data to hold a meaningful slice back at all (the same floor
  // `splitForCalibrationHoldout` itself applies) -- degrades to the prior in-sample scoring
  // rather than fabricating a comparison on a slice too small to trust, matching
  // `fitBestCalibration`'s own documented fallback.
  const { holdoutPoints } = splitForCalibrationHoldout(points);
  const scoringPoints = holdoutPoints.length > 0 ? holdoutPoints : points;

  const segmentPredictions = scoringPoints.map((p) => ({ ...p, calibrated: applyCalibration(segmentMapping, p.rawProbability) }));
  const generalPredictions = scoringPoints.map((p) => ({ ...p, calibrated: applyCalibration(generalMapping, p.rawProbability) }));

  const segmentAccuracy = accuracyOf(segmentPredictions);
  const generalAccuracy = accuracyOf(generalPredictions);
  const segmentLogLoss = logLoss(segmentPredictions.map((p) => ({ rawProbability: p.calibrated, outcome: p.outcome })));
  const generalLogLoss = logLoss(generalPredictions.map((p) => ({ rawProbability: p.calibrated, outcome: p.outcome })));
  const segmentBrier = brierScore(segmentPredictions.map((p) => ({ rawProbability: p.calibrated, outcome: p.outcome })));
  const generalBrier = brierScore(generalPredictions.map((p) => ({ rawProbability: p.calibrated, outcome: p.outcome })));

  // Task #68: absolute accuracy floor — a specialist below MIN_SPECIALIST_ACCURACY is too close
  // to random to add value; reject it before calling computeSpecialistWeight so the outcome is
  // clearly attributed to the accuracy gate rather than the logLoss comparison.
  // Accuracy numbers are stored for diagnostics even when the segment is rejected.
  if (segmentAccuracy !== null && segmentAccuracy < MIN_SPECIALIST_ACCURACY) {
    logger.warn(
      { segmentKey: segment.segmentKey, segmentAccuracy, minRequired: MIN_SPECIALIST_ACCURACY, n: points.length },
      "Task #68: specialist rejected — accuracy below minimum threshold; falling back to general model",
    );
    return {
      ...base,
      meetsThreshold: false,
      validationSampleSize: points.length,
      accuracy: segmentAccuracy,
      logLoss: segmentLogLoss,
      brier: segmentBrier,
      generalAccuracy,
      generalLogLoss,
      generalBrier,
      calibrationMapping: [],
      weight: 0,
    };
  }

  const weight = computeSpecialistWeight(points.length, segmentLogLoss, generalLogLoss);

  // Task #68: also downgrade `meetsThreshold` when `computeSpecialistWeight` rejects the segment
  // due to logLoss degradation (weight=0). Storing false here ensures the engine correctly falls
  // back to the general model and preserves the reliability discounts that would be skipped if a
  // "met" specialist were active with a no-op 0 weight. The accuracy/logLoss numbers are still
  // stored for diagnostic purposes.
  if (weight === 0 && segmentLogLoss !== null && generalLogLoss !== null) {
    logger.warn(
      { segmentKey: segment.segmentKey, segmentLogLoss, generalLogLoss, degradation: segmentLogLoss - generalLogLoss },
      "Task #68: specialist rejected — segment logLoss exceeds general model threshold; falling back to general model",
    );
  }

  return {
    ...base,
    meetsThreshold: weight > 0,
    validationSampleSize: points.length,
    accuracy: segmentAccuracy,
    logLoss: segmentLogLoss,
    brier: segmentBrier,
    generalAccuracy,
    generalLogLoss,
    generalBrier,
    calibrationMapping: segmentMapping,
    weight,
  };
}

function accuracyOf(predictions: Array<{ calibrated: number; outcome: 0 | 1 }>): number | null {
  if (predictions.length === 0) return null;
  const correct = predictions.filter((p) => (p.calibrated >= 0.5 ? 1 : 0) === p.outcome).length;
  return Math.round((correct / predictions.length) * 1000) / 10;
}

/**
 * Task #68: a specialist that measurably degrades the general model (segment logLoss exceeds
 * general logLoss by more than this) is rejected entirely rather than blended in at the 0.1
 * floor. Sized at 5 milli-nats — half the granularity of `perfAdjustment`'s own adjustment step
 * — so genuine degradation is caught while measurement noise on a thin holdout slice is not.
 * Returning 0 causes `computeOneSegment` to mark the segment `meetsThreshold: false`, which
 * prevents the engine from applying the specialist at all and preserves the fallback discounts
 * that would otherwise be skipped when a specialist appears to be active.
 */
export const MAX_LOGOSS_DEGRADATION = 0.005;

/**
 * Derives the specialist's share (0-1) of the live blend purely from measured validation
 * performance -- never hand-picked or tuned against any later test window.
 *
 * `baseWeight` grows with sample size (more validation data earns more trust, asymptoting at 0.7
 * so the general model always retains at least some say). `perfAdjustment` then shifts that base
 * up when the segment's own calibration measurably beats the general mapping's logLoss on the
 * same points, or down when it's worse -- capped at +/-0.2 so one segment's noisy logLoss swing
 * can't flip the blend to an extreme. The result is clamped to [0.1, 0.85]: even a strong
 * specialist never fully silences the general model's agreement check, and even a weak one still
 * contributes a signal worth voting on transparency's sake.
 *
 * Exception (Task #68): when the specialist is worse than the general model by more than
 * `MAX_LOGOSS_DEGRADATION`, returns 0 instead of the 0.1 floor. The caller treats 0 as a
 * rejection signal and downgrades `meetsThreshold` to false so the engine falls back cleanly.
 */
/** Exported for unit-testing only — call `computeAndStoreSpecialistSegments` in production code. */
export function computeSpecialistWeight(sampleSize: number, segmentLogLoss: number | null, generalLogLoss: number | null): number {
  const baseWeight = Math.min(0.7, sampleSize / (sampleSize + 50));
  if (segmentLogLoss === null || generalLogLoss === null) return Math.round(Math.max(0.1, Math.min(0.85, baseWeight)) * 1000) / 1000;

  const improvement = generalLogLoss - segmentLogLoss; // positive => segment calibrates better

  // Task #68: reject silently-harmful specialists outright rather than blending them at the floor.
  if (improvement < -MAX_LOGOSS_DEGRADATION) return 0;

  const perfAdjustment = Math.max(-0.2, Math.min(0.2, (improvement / 0.05) * 0.2));
  return Math.round(Math.max(0.1, Math.min(0.85, baseWeight + perfAdjustment)) * 1000) / 1000;
}

export async function getActiveSpecialistSegments(): Promise<SpecialistSegmentSummary[]> {
  return db.select().from(specialistModelsTable);
}

export async function getSpecialistForSegment(segmentKeyValue: string): Promise<SpecialistSegmentSummary | null> {
  const [row] = await db.select().from(specialistModelsTable).where(eq(specialistModelsTable.segmentKey, segmentKeyValue)).limit(1);
  return row ?? null;
}

/**
 * Resolves the caller-facing `SegmentSpecialistInput` the prediction engine expects, for a given
 * tour/surface. Returns null when the tour/surface isn't one of Phase 6's candidate segments at
 * all (e.g. Challenger/ITF/Exhibition, or an unrecognized surface) -- distinct from a resolved
 * segment that just hasn't cleared its data threshold yet, which still returns an object (with
 * `meetsThreshold: false`) so the engine can show a specific, honest disclaimer either way.
 */
export async function resolveSegmentSpecialistInput(tour: string | null | undefined, surface: Surface | null | undefined): Promise<SegmentSpecialistInput | null> {
  const segment = resolveSegment(tour, surface);
  if (!segment) return null;
  const row = await getSpecialistForSegment(segment.segmentKey);
  return toSegmentSpecialistInput(segment, row);
}

/**
 * Pure, DB-free version of the mapping `resolveSegmentSpecialistInput` does, given a row already
 * in hand (or null). Factored out so callers who need to resolve this for thousands of matches in
 * one run (Task #65: walk-forward scoring) can preload every segment's row ONCE up front instead
 * of round-tripping the DB per match.
 */
export function toSegmentSpecialistInput(segment: SegmentDefinition, row: SpecialistModelRow | null): SegmentSpecialistInput {
  if (!row) {
    // No walk-forward run has ever computed this segment yet -- same honest "not enough data"
    // disclaimer as a segment that was computed but fell short of threshold.
    return {
      segmentKey: segment.segmentKey,
      label: segment.label,
      meetsThreshold: false,
      historicalMatchCount: 0,
      validationSampleSize: 0,
      minHistoricalMatches: MIN_HISTORICAL_MATCHES_FOR_SEGMENT,
      minValidationSamples: MIN_VALIDATION_SAMPLES_FOR_SEGMENT,
    };
  }

  return {
    segmentKey: row.segmentKey,
    label: row.label,
    meetsThreshold: row.meetsThreshold,
    historicalMatchCount: row.historicalMatchCount,
    validationSampleSize: row.validationSampleSize,
    minHistoricalMatches: MIN_HISTORICAL_MATCHES_FOR_SEGMENT,
    minValidationSamples: MIN_VALIDATION_SAMPLES_FOR_SEGMENT,
    calibrationMapping: row.meetsThreshold ? (row.calibrationMapping as CalibrationKnot[]) : undefined,
    weight: row.meetsThreshold ? row.weight : undefined,
  };
}

/**
 * Sync counterpart of `resolveSegmentSpecialistInput` for callers holding a preloaded
 * segmentKey -> row map (Task #65's walk-forward scoring). Returns null under the exact same
 * condition `resolveSegmentSpecialistInput` would (tour/surface isn't a candidate segment at
 * all), never a fabricated "not enough data" result for a non-candidate segment.
 */
export function resolveSegmentSpecialistInputSync(
  tour: string | null | undefined,
  surface: Surface | null | undefined,
  rowsBySegmentKey: ReadonlyMap<string, SpecialistModelRow>,
): SegmentSpecialistInput | null {
  const segment = resolveSegment(tour, surface);
  if (!segment) return null;
  return toSegmentSpecialistInput(segment, rowsBySegmentKey.get(segment.segmentKey) ?? null);
}
