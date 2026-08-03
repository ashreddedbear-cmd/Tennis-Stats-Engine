import { db, evaluationPredictionsTable, evaluationRunsTable, calibrationModelsTable, historicalMatchesTable } from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { fitBestCalibration, applyCalibration, isKnownBadCascadeRow, type CalibrationPoint } from "./calibration";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { getPredictionSettings } from "./settle";
import { computeAndStoreSpecialistSegments, getActiveSpecialistSegments } from "./specialistWeights";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { defaultPredictionMode, derivePredictionStrategyIdentity } from "./strategyIdentity";
import { eloFallbackTracker, fallbackRateWarning } from "../predictionEngine/fallbackTracking";
import { HISTORICAL_MODEL_VERSION, type ResultType, type RetirementRule } from "./types";
import type { CalibrationKnot } from "./types";

export interface WalkForwardOptions {
  /** Number of expanding-window folds to run over the back portion of the timeline. */
  foldCount?: number;
  /** Fraction of the earliest history reserved as train-only warmup, never scored. */
  warmupFraction?: number;
  /** Optional optimizer run identifier when this walk-forward is executed as part of optimizer training. */
  optimizerRunId?: string | null;
  /**
   * Task #12: when true, run all folds and compute metrics using the currently-active
   * (frozen) calibration without touching calibration_models, specialist_models, or any
   * threshold value. The "Run Walk-Forward" button on the Accuracy Dashboard always uses
   * evaluationOnly=true. The separate "Run Optimizer" action uses evaluationOnly=false.
   *
   * Defaults to false for backward compatibility, but the dashboard wires it as true.
   */
  evaluationOnly?: boolean;
}

export interface WalkForwardSummary {
  foldsRun: number;
  foldIds: number[];
  skippedNoEligibleMatches: boolean;
  /** Share (0-1) of opponent Elo lookups across this run that hit #76's last-resort fallback baseline (Task #77). 0 when nothing was scored. */
  fallbackRate: number;
  /** Data-quality warnings for this run -- e.g. the fallback-rate threshold warning (Task #77) -- surfaced the same way per-prediction module warnings are, never a new UI surface. */
  warnings: string[];
  /** Task #12: true when this run was evaluation-only (frozen calibration/specialist weights), false when it was a full optimizer/training run. */
  evaluationOnly: boolean;
}

function classifyResult(match: { winnerId: string | null; retired: boolean; walkover: boolean; cancelled: boolean }): ResultType {
  if (match.cancelled) return "cancelled";
  if (match.walkover) return "walkover";
  if (match.retired) return "retired";
  return "normal";
}

/**
 * Runs a fresh sequence of expanding-window walk-forward folds over the entire leak-proof
 * historical store and persists per-fold results. Each run supersedes prior evaluation_runs /
 * evaluation_predictions rows of runKind='historical_test' (deleted up front) so re-running
 * after a model change never mixes stale and fresh fold results together.
 *
 * Task #12: when `options.evaluationOnly=true`, folds are scored against the currently-active
 * (frozen) calibration mapping without touching calibration_models, specialist_models, or any
 * threshold value. The dashboard "Run Walk-Forward" button always uses evaluation-only mode.
 * The separate "Run Optimizer" endpoint uses the full training mode (evaluationOnly=false).
 */
export async function runWalkForwardEvaluation(options: WalkForwardOptions = {}): Promise<WalkForwardSummary> {
  const foldCount = options.foldCount ?? 4;
  const warmupFraction = options.warmupFraction ?? 0.4;
  const evaluationOnly = options.evaluationOnly ?? false;
  const optimizerRunId = options.optimizerRunId ?? null;
  if (foldCount < 1) throw new Error("foldCount must be >= 1");
  if (warmupFraction <= 0 || warmupFraction >= 1) throw new Error("warmupFraction must be between 0 and 1 (exclusive)");

  // Task #12: in evaluation-only mode, load the currently-active calibration once up front.
  // This mapping is used for ALL folds (instead of per-fold refitting). Never touched/updated.
  let frozenCalibrationMapping: CalibrationKnot[] | null = null;
  if (evaluationOnly) {
    const [activeCalibration] = await db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1);
    frozenCalibrationMapping = activeCalibration ? (activeCalibration.mapping as CalibrationKnot[]) : null;
    logger.info({ hasFrozenMapping: frozenCalibrationMapping !== null, knots: frozenCalibrationMapping?.length ?? 0 }, "Task #12: evaluation-only walk-forward — calibration is frozen, no writes to calibration_models or specialist_models");
  }

  const settings = await getPredictionSettings();

  const allMatches = await db
    .select()
    .from(historicalMatchesTable)
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  const eligible = allMatches.filter((m) => !m.cancelled); // cancelled matches never even reach scoring; walkovers/retirements are scored but voided/flagged downstream
  if (eligible.length < 20) {
    logger.warn({ count: eligible.length }, "Not enough historical matches to run a meaningful walk-forward evaluation");
    return { foldsRun: 0, foldIds: [], skippedNoEligibleMatches: true, fallbackRate: 0, warnings: [], evaluationOnly };
  }

  // Wipe prior historical_test evaluation state so a re-run never mixes fold generations.
  await db.delete(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runKind, "historical_test"));
  await db.delete(evaluationRunsTable);

  // Task #77: run-scoped fallback tracker, reset here so this run's rate never mixes with a
  // prior run's (e.g. a live prediction request scored moments before).
  eloFallbackTracker.reset();

  // Preload the whole corpus ONCE for this run -- a run scores thousands of matches, each
  // needing two players' full prior histories, their H2H, and opponent-Elo lookups. Re-querying
  // the DB per match would turn a run that should take seconds into one that takes hours; see
  // `HistoricalScoringContext`. The identity index is built once here too (Task #77) and reused
  // both for `eloHistory`'s own canonicalized grouping and for every match's opponent-resolution
  // lookup below, so a fragmented player's Elo trajectory is merged and resolved consistently.
  const identityIndex = await buildPlayerIdentityIndex();
  // Task #65: snapshot the PREVIOUS cycle's specialist fit before this run's own fold scoring --
  // `computeAndStoreSpecialistSegments` below (which fits fresh specialists FROM this run's own
  // validation output) only overwrites `specialist_models` at the very end of this function, so
  // this read is guaranteed to see last cycle's rows, never this cycle's own. That's what makes
  // applying it in `scoreHistoricalMatch` non-circular.
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
  const scoringContext: HistoricalScoringContext = {
    matchHistory: buildMatchHistoryIndex(allMatches),
    eloHistory: await buildEloHistoryIndex(identityIndex),
    identityIndex,
    specialistRowsBySegmentKey,
  };

  const warmupEndIdx = Math.floor(eligible.length * warmupFraction);
  const scorable = eligible.slice(warmupEndIdx);
  if (scorable.length < foldCount * 6) {
    logger.warn({ scorable: scorable.length, foldCount }, "Not enough post-warmup matches for the requested fold count");
    return { foldsRun: 0, foldIds: [], skippedNoEligibleMatches: true, fallbackRate: 0, warnings: [], evaluationOnly };
  }

  const chunkSize = Math.floor(scorable.length / foldCount);
  const foldIds: number[] = [];
  const allValidationPoints: CalibrationPoint[] = [];

  for (let fold = 0; fold < foldCount; fold++) {
    const chunkStart = fold * chunkSize;
    const chunkEnd = fold === foldCount - 1 ? scorable.length : chunkStart + chunkSize;
    const chunk = scorable.slice(chunkStart, chunkEnd);
    if (chunk.length < 4) continue;

    const half = Math.floor(chunk.length / 2);
    const validationMatches = chunk.slice(0, half);
    const testMatches = chunk.slice(half);

    const trainEnd = validationMatches[0].scheduledStartAt;
    const validationStart = validationMatches[0].scheduledStartAt;
    const validationEnd = validationMatches[validationMatches.length - 1].scheduledStartAt;
    const testStart = testMatches[0]?.scheduledStartAt ?? validationEnd;
    const testEnd = testMatches[testMatches.length - 1]?.scheduledStartAt ?? validationEnd;
    const trainStart = allMatches[0].scheduledStartAt;

    const validationRows = await scoreAndInsert(validationMatches, "validation", null, settings.retirementRule as RetirementRule);

    let mapping: CalibrationKnot[];
    if (evaluationOnly) {
      // Task #12: evaluation-only mode -- use the frozen calibration (never refit).
      // When no active calibration exists yet (fresh env), fall back to the identity curve so
      // the run still completes with honest "uncalibrated" metrics rather than crashing.
      mapping = frozenCalibrationMapping ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    } else {
      // Training mode: fit calibration ONLY on this fold's validation-segment, accuracy-eligible
      // points. Never touches test data.
      // Exclude known-bad pre-cascade rows: predictions locked before 2026-07-15 with
      // tieBreakerApplied=true were scored by the old directional cascade (removed Task #5)
      // which achieved only ~30.8% accuracy on close matchups vs a 76.9% baseline.
      const foldEligible = validationRows.filter((r) => r.includedInAccuracy && r.rawProbability !== null);
      const foldCascadeBad = foldEligible.filter((r) => isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied));
      if (foldCascadeBad.length > 0) {
        logger.warn(
          { fold, excludedCascadeRows: foldCascadeBad.length, kept: foldEligible.length - foldCascadeBad.length },
          "Excluded known-bad pre-cascade rows from fold calibration training data",
        );
      }
      const foldValidationPoints: CalibrationPoint[] = foldEligible
        .filter((r) => !isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied))
        .map((r) => ({ rawProbability: r.rawProbability as number, outcome: r.player1Won ? 1 : 0 }));
      mapping = fitBestCalibration(foldValidationPoints).knots;
      allValidationPoints.push(...foldValidationPoints);
    }

    // Apply calibration to validation rows (in-sample for training mode, against-frozen for eval)
    // and to test rows (always out-of-sample).
    await recalibrateRows(validationRows.map((r) => r.id), mapping);
    const testRows = await scoreAndInsert(testMatches, "test", null, settings.retirementRule as RetirementRule);
    await recalibrateRows(testRows.map((r) => r.id), mapping);

    const [insertedFold] = await db
      .insert(evaluationRunsTable)
      .values({
        foldIndex: fold,
        modelVersion: HISTORICAL_MODEL_VERSION,
        trainStart,
        trainEnd,
        validationStart,
        validationEnd,
        testStart,
        testEnd,
        calibrationMapping: mapping,
        validationMetrics: await summarizeSegment("historical_test", "validation", null),
        testMetrics: {},
      })
      .returning({ id: evaluationRunsTable.id });

    // Backfill foldId + fold-scoped metrics now that we have the fold's id.
    await db
      .update(evaluationPredictionsTable)
      .set({ foldId: insertedFold.id })
      .where(inArray(evaluationPredictionsTable.id, [...validationRows.map((r) => r.id), ...testRows.map((r) => r.id)]));

    await db
      .update(evaluationRunsTable)
      .set({
        validationMetrics: await summarizeSegment("historical_test", "validation", insertedFold.id),
        testMetrics: await summarizeSegment("historical_test", "test", insertedFold.id),
      })
      .where(eq(evaluationRunsTable.id, insertedFold.id));

    foldIds.push(insertedFold.id);
  }

  if (evaluationOnly) {
    // Task #12: evaluation-only -- calibration_models and specialist_models are frozen.
    // No writes to either table. The run's purpose is purely to produce fresh metrics against
    // the current deployed calibration without touching it.
    logger.info({ foldsRun: foldIds.length }, "Task #12: evaluation-only walk-forward complete — skipped calibration refit and specialist recompute");
  } else {
    // Training mode: refit the single "live" calibration model from every fold's pooled
    // validation data -- this is what future paper-trade/live predictions will be calibrated with.
    // allValidationPoints was already filtered per-fold to exclude known-bad cascade rows.
    logger.info(
      { pooledValidationPoints: allValidationPoints.length },
      "Fitting pooled calibration model (cascade-bad rows already excluded per fold)",
    );
    const liveFit = fitBestCalibration(allValidationPoints);
    // Hard safety guard: never let a degenerate calibration (known collapsed case from prior
    // audits: holdoutSampleSize === 0, often a constant y=1 isotonic mapping) replace a working
    // active model. Failing closed here keeps the previous active model in place.
    if (liveFit.holdoutSampleSize === 0) {
      throw new Error(
        "Refusing to activate degenerate calibration model: holdoutSampleSize is 0 (collapsed fit guard)",
      );
    }
    const liveMapping = liveFit.knots;
    const dates = allMatches.map((m) => m.scheduledStartAt.getTime());

    // Only now (after passing the guard) swap active calibration rows.
    await db.update(calibrationModelsTable).set({ active: false }).where(eq(calibrationModelsTable.active, true));
    await db.insert(calibrationModelsTable).values({
      method: liveFit.method,
      mapping: liveMapping,
      validationSampleSize: allValidationPoints.length,
      validationDateRangeStart: dates.length ? new Date(Math.min(...dates)) : null,
      validationDateRangeEnd: dates.length ? new Date(Math.max(...dates)) : null,
      active: true,
      isotonicHoldoutLogLoss: liveFit.isotonicHoldoutLogLoss,
      plattHoldoutLogLoss: liveFit.plattHoldoutLogLoss,
      holdoutSampleSize: liveFit.holdoutSampleSize,
    });

    // Phase 6: recompute every tour/surface specialist segment from the fold's freshly-written
    // validation-segment data, comparing each against this SAME newly-fit general/pooled mapping.
    await computeAndStoreSpecialistSegments(liveMapping);
  }

  // Task #12: run pattern analysis automatically after every walk-forward (both modes).
  // Import lazily to avoid a circular dep and keep this file focused on fold mechanics.
  try {
    const { runPatternAnalysis } = await import("./patternAnalysis");
    await runPatternAnalysis();
  } catch (err) {
    // Pattern analysis failure is non-fatal -- the walk-forward result is still valid.
    logger.warn({ err }, "Task #12: post-walk-forward pattern analysis failed (non-fatal)");
  }

  // Task #77: surface a data-quality warning through this run's own existing summary output
  // (the same "warnings" shape every per-prediction module already uses) whenever more than 1%
  // of this run's opponent Elo lookups needed the last-resort fallback -- the run still completes
  // either way, it's never silently swallowed nor a reason to halt.
  const fallbackStats = eloFallbackTracker.getStats();
  const fallbackWarning = fallbackRateWarning(fallbackStats);
  const warnings = fallbackWarning ? [fallbackWarning] : [];
  if (fallbackWarning) {
    logger.warn({ fallbackRate: fallbackStats.fallbackRate, fallbackCount: fallbackStats.fallbackCount, totalAttempts: fallbackStats.totalAttempts }, fallbackWarning);
  }

  return { foldsRun: foldIds.length, foldIds, skippedNoEligibleMatches: false, fallbackRate: fallbackStats.fallbackRate, warnings, evaluationOnly };

  // --- helpers (closures over allMatches context) ---

  async function scoreAndInsert(
    matches: (typeof allMatches)[number][],
    segment: "validation" | "test",
    foldId: number | null,
    retirementRule: RetirementRule,
  ): Promise<Array<{ id: number; rawProbability: number | null; player1Won: boolean; includedInAccuracy: boolean; tieBreakerApplied: boolean; lockedAt: Date }>> {
    const results: Array<{ id: number; rawProbability: number | null; player1Won: boolean; includedInAccuracy: boolean; tieBreakerApplied: boolean; lockedAt: Date }> = [];


    for (const match of matches) {
      const resultType = classifyResult(match);
      const isVoid = resultType === "walkover" || resultType === "cancelled";
      const player1Won = match.winnerId === match.player1Id;

      const scored = scoreHistoricalMatch(match, scoringContext);
      const rawProbability = scored?.rawProbability ?? null;
      const predictedWinnerId = rawProbability !== null ? (rawProbability >= 0.5 ? match.player1Id : match.player2Id) : null;
      const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included") && rawProbability !== null;
      // Capture tieBreakerApplied from the engine breakdown so calibration training can exclude
      // rows that were scored by the old directional cascade (see isKnownBadCascadeRow).
      const tieBreakerApplied = scored?.snapshot.engine.tieBreakerApplied ?? false;
      const lockedAt = new Date();
      const player1Id = typeof match.player1Id === "string" ? match.player1Id : null;
      const player1Name = typeof match.player1Name === "string" ? match.player1Name : null;
      const player2Id = typeof match.player2Id === "string" ? match.player2Id : null;
      const player2Name = typeof match.player2Name === "string" ? match.player2Name : null;

      if (!player1Id || !player1Name || !player2Id || !player2Name) {
        logger.warn({ historicalMatchId: match.id }, "Skipping historical evaluation row with missing required player identifiers");
        continue;
      }

      // Sanitize and validate the persistence object to avoid fatal DB errors
      const toInsert = {
        predictionMode: defaultPredictionMode("historical_test"),
        strategyId: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("historical_test"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: lockedAt }).strategyId,
        strategyVersion: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("historical_test"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: lockedAt }).strategyVersion,
        strategyFingerprint: HISTORICAL_MODEL_VERSION,
        optimizerRunId,
        calibrationVersion: null,
        competitiveBalanceVersion: null,
        evidenceReliabilityVersion: null,
        runKind: "historical_test",
        foldId,
        segment,
        historicalMatchId: typeof match.id === "number" ? match.id : null,
        player1Id,
        player1Name,
        player2Id,
        player2Name,
        surface: typeof match.surface === "string" ? match.surface : null,
        matchFormat: typeof match.matchFormat === "string" ? match.matchFormat : null,
        tournamentLevel: typeof match.tournamentLevel === "string" ? match.tournamentLevel : null,
        tournamentName: typeof match.tournamentName === "string" ? match.tournamentName : null,
        scheduledStartAt: match.scheduledStartAt instanceof Date ? match.scheduledStartAt : new Date(match.scheduledStartAt),
        cutoffAt: match.cutoffAt instanceof Date ? match.cutoffAt : new Date(match.cutoffAt),
        lockedAt,
        modelVersion: HISTORICAL_MODEL_VERSION,
        // featureSnapshot may be large; keep it but avoid logging it on error
        featureSnapshot: scored?.snapshot ?? null,
        modelAgreement: typeof scored?.modelAgreement === "string" ? scored.modelAgreement : null,
        upsetRiskTier: typeof scored?.upsetRiskTier === "string" ? scored.upsetRiskTier : null,
        rawProbability: rawProbability !== null && Number.isFinite(rawProbability) ? rawProbability * 100 : null,
        calibratedProbability: rawProbability !== null && Number.isFinite(rawProbability) ? rawProbability * 100 : null,
        predictedWinnerId: predictedWinnerId ?? null,
        predictedWinnerName: predictedWinnerId ? (predictedWinnerId === player1Id ? player1Name : player2Name) : null,
        status: rawProbability === null ? "void" : isVoid ? "void" : "graded",
        actualWinnerId: typeof match.winnerId === "string" ? match.winnerId : null,
        actualWinnerName:
          match.winnerId && typeof match.winnerId === "string"
            ? match.winnerId === player1Id
              ? player1Name
              : player2Name
            : null,
        resultType: rawProbability === null ? null : resultType,
        includedInAccuracy: typeof includedInAccuracy === "boolean" ? includedInAccuracy : false,
        gradedAt: new Date(),
      };

      try {
        const [inserted] = await db.insert(evaluationPredictionsTable).values(toInsert).returning({ id: evaluationPredictionsTable.id });
        results.push({ id: inserted.id, rawProbability, player1Won, includedInAccuracy, tieBreakerApplied, lockedAt });
      } catch (err: any) {
        // Capture concise DB error metadata without logging the full feature snapshot or payload
        const errInfo: Record<string, any> = {
          message: err?.message ?? String(err),
          code: err?.code ?? null,
          constraint: err?.constraint ?? null,
          runKind: toInsert.runKind,
          historicalMatchId: toInsert.historicalMatchId,
          scheduledStartAt: toInsert.scheduledStartAt,
          fieldChecks: {
            rawProbabilityFinite: Number.isFinite(toInsert.rawProbability),
            scheduledStartAtValid: toInsert.scheduledStartAt instanceof Date && !isNaN((toInsert.scheduledStartAt as Date).getTime()),
            cutoffAtValid: toInsert.cutoffAt instanceof Date && !isNaN((toInsert.cutoffAt as Date).getTime()),
          },
        };
        logger.error(errInfo, "evaluation_predictions insert failed (concise)");
        // Try a smallest-safe repair: drop `featureSnapshot` (common cause for JSON/serialization issues)
        try {
          const repair = { ...toInsert, featureSnapshot: null };
          const [recovered] = await db.insert(evaluationPredictionsTable).values(repair).returning({ id: evaluationPredictionsTable.id });
          logger.warn({ recoveredId: recovered.id, historicalMatchId: toInsert.historicalMatchId }, "evaluation_predictions insert recovered by dropping featureSnapshot");
          results.push({ id: recovered.id, rawProbability, player1Won, includedInAccuracy, tieBreakerApplied, lockedAt });
        } catch (repairErr: any) {
          // If repair also fails, surface the original concise error and re-throw the repair error
          logger.error({ repairMessage: repairErr?.message ?? String(repairErr) }, "evaluation_predictions repair attempt failed");
          throw err;
        }
      }
    }

    return results;
  }

  async function recalibrateRows(ids: number[], mapping: CalibrationKnot[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await db
      .select({ id: evaluationPredictionsTable.id, rawProbability: evaluationPredictionsTable.rawProbability })
      .from(evaluationPredictionsTable)
      .where(inArray(evaluationPredictionsTable.id, ids));

    for (const row of rows) {
      if (row.rawProbability === null) continue;
      const calibrated = applyCalibration(mapping, row.rawProbability / 100) * 100;
      await db
        .update(evaluationPredictionsTable)
        .set({ calibratedProbability: calibrated })
        .where(eq(evaluationPredictionsTable.id, row.id));
    }
  }

  async function summarizeSegment(_runKind: string, segment: string, foldId: number | null) {
    const { computeSegmentMetrics } = await import("./metrics");
    if (foldId === null) return computeSegmentMetrics([]);
    const rows = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.foldId, foldId));
    const filtered = rows.filter((r) => r.segment === segment);
    return computeSegmentMetrics(filtered);
  }
}
