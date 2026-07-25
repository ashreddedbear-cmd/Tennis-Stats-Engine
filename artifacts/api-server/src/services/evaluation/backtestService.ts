/**
 * Backtest service — evaluation-only mode.
 *
 * Runs the current frozen model/calibration over a slice of historical matches selected by
 * date range + filters. Never touches calibration_models or specialist_models. Writing
 * progress to backtest_runs.processed_rows / current_stage as the run proceeds so the
 * client can poll for status updates.
 *
 * Safety invariants:
 *  - No writes to evaluation_predictions (walk-forward's ledger)
 *  - No writes to calibration_models or specialist_models
 *  - All predictions stored in backtest_predictions, linked by backtest_run_id
 *  - DELETE on a run never touches backtest_predictions rows (soft-delete only)
 */
import { db, historicalMatchesTable, calibrationModelsTable, backtestRunsTable, backtestPredictionsTable, candidateConfigsTable } from "@workspace/db";
import { asc, and, gte, lte, eq, isNull } from "drizzle-orm";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { computeSegmentMetrics, computeCalibrationBuckets } from "./metrics";
import { applyCalibration } from "./calibration";
import { getPredictionSettings } from "./settle";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { getActiveSpecialistSegments } from "./specialistWeights";
import { HISTORICAL_MODEL_VERSION, type RetirementRule } from "./types";
import { logger } from "../../lib/logger";

export interface BacktestFilters {
  surface?: string;
  tour?: string;
  tournamentLevel?: string;
  bestOf?: number;
  includeRetirements?: boolean;
  includeWalkovers?: boolean;
  minCalibrated?: number; // only include predictions where calibrated prob >= this
  maxCalibrated?: number;
}

export interface BacktestDateRange {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface BacktestPreviewResult {
  total: number;
  eligible: number;
  excluded: number;
  exclusionReasons: Record<string, number>;
}

export interface BacktestRunOptions {
  runId: number;
  dateRange: BacktestDateRange;
  filters: BacktestFilters;
  mode: "evaluation" | "optimization";
  candidateConfigId?: number; // Optional: use a candidate config instead of defaults
}

/**
 * Minimal match shape used by the scoring loop. The real DB rows satisfy this
 * interface; tests can inject plain objects of the same shape.
 */
export interface BacktestMatchLike {
  id: number;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  winnerId: string | null;
  cancelled: boolean;
  walkover: boolean;
  retired: boolean;
  surface: string | null;
  matchFormat: string | null;
  tournamentLevel: string | null;
  tournamentName: string | null;
  scheduledStartAt: Date;
}

/**
 * Dependency-injection hooks for testing only.
 * Production callers pass undefined; the function falls back to real DB calls.
 */
export interface BacktestTestHooks {
  /** Supply a fixed list of matches, bypassing the DB historical-match queries. */
  matchesForTest?: BacktestMatchLike[];
  /**
   * Override the cancellation poll. Return 'cancelled' to trigger cooperative exit.
   * Called at each progress checkpoint and before the final status write.
   */
  getCancellationStatus?: (runId: number) => Promise<string | null>;
  /** Called after each prediction row is processed (real or no-op in tests). */
  onPredictionInserted?: (totalInserted: number) => void;
  /** Called for each run-status DB update (real in prod; can be a no-op in tests). */
  onRunUpdated?: (data: Record<string, unknown>) => Promise<void>;
}

/** Preview how many rows a set of filters would capture, without running anything */
export async function previewBacktest(
  dateRange: BacktestDateRange,
  filters: BacktestFilters,
): Promise<BacktestPreviewResult> {
  const conditions = buildDateConditions(dateRange);
  const allMatches = await db
    .select()
    .from(historicalMatchesTable)
    .where(and(...conditions))
    .orderBy(asc(historicalMatchesTable.scheduledStartAt));

  const exclusionReasons: Record<string, number> = {};
  let eligible = 0;

  for (const m of allMatches) {
    const reason = getExclusionReason(m, filters);
    if (reason) {
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    } else {
      eligible++;
    }
  }

  return {
    total: allMatches.length,
    eligible,
    excluded: allMatches.length - eligible,
    exclusionReasons,
  };
}

function buildDateConditions(dateRange: BacktestDateRange) {
  const conditions = [];
  if (dateRange.start) {
    conditions.push(gte(historicalMatchesTable.scheduledStartAt, new Date(`${dateRange.start}T00:00:00.000Z`)));
  }
  if (dateRange.end) {
    conditions.push(lte(historicalMatchesTable.scheduledStartAt, new Date(`${dateRange.end}T23:59:59.999Z`)));
  }
  return conditions;
}

function getExclusionReason(
  match: { cancelled: boolean; walkover: boolean; retired: boolean; surface: string | null; matchFormat: string | null; tournamentLevel: string | null },
  filters: BacktestFilters,
): string | null {
  if (match.cancelled) return "cancelled";
  if (match.walkover && !filters.includeWalkovers) return "walkover";
  if (match.retired && !filters.includeRetirements) return "retirement";
  if (filters.surface && match.surface !== filters.surface) return `surface_not_${filters.surface}`;
  if (filters.tournamentLevel && match.tournamentLevel !== filters.tournamentLevel) return `level_not_${filters.tournamentLevel}`;
  return null;
}

/** Thrown internally when the run row has been set to 'cancelled' by the API. */
class BacktestCancelledError extends Error {
  constructor() {
    super("Backtest cancelled by user");
    this.name = "BacktestCancelledError";
  }
}

/** Re-read the run row and throw if it has been cancelled. */
async function assertNotCancelled(
  runId: number,
  getStatus?: (id: number) => Promise<string | null>,
): Promise<void> {
  let status: string | null;
  if (getStatus) {
    status = await getStatus(runId);
  } else {
    const [row] = await db
      .select({ status: backtestRunsTable.status })
      .from(backtestRunsTable)
      .where(eq(backtestRunsTable.id, runId));
    status = row?.status ?? null;
  }
  if (status === "cancelled") throw new BacktestCancelledError();
}

/** Run a full evaluation-only backtest. Writes progress to the DB row as it runs. */
export async function runEvaluationBacktest(
  options: BacktestRunOptions,
  _hooks?: BacktestTestHooks,
): Promise<void> {
  const { runId, dateRange, filters, candidateConfigId } = options;

  const updateStatus = async (status: string, stage?: string, processed?: number, total?: number) => {
    if (_hooks?.onRunUpdated) {
      await _hooks.onRunUpdated({
        status,
        ...(stage !== undefined ? { currentStage: stage } : {}),
        ...(processed !== undefined ? { processedRows: processed } : {}),
        ...(total !== undefined ? { totalRows: total } : {}),
      });
      return;
    }
    await db
      .update(backtestRunsTable)
      .set({
        status,
        currentStage: stage ?? null,
        ...(processed !== undefined ? { processedRows: processed } : {}),
        ...(total !== undefined ? { totalRows: total } : {}),
      })
      .where(eq(backtestRunsTable.id, runId));
  };

  try {
    if (!_hooks?.onRunUpdated) {
      await db.update(backtestRunsTable).set({ startedAt: new Date() }).where(eq(backtestRunsTable.id, runId));
    }
    await updateStatus("validating", "Loading historical data");

    const settings = await getPredictionSettings();
    let effectiveConfig: Record<string, unknown> | null = null;
    
    if (candidateConfigId) {
      const [candidateConfig] = await db
        .select()
        .from(candidateConfigsTable)
        .where(eq(candidateConfigsTable.id, candidateConfigId))
        .limit(1);
      if (candidateConfig?.proposedConfig) {
        effectiveConfig = candidateConfig.proposedConfig;
      }
    }

    // Load data slice for this date range
    // If test hooks provide matches, use them directly to avoid needing DB data.
    const allMatchesForContext: BacktestMatchLike[] = _hooks?.matchesForTest
      ? _hooks.matchesForTest
      : await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt));

    let sliceMatches: BacktestMatchLike[];
    if (_hooks?.matchesForTest) {
      sliceMatches = _hooks.matchesForTest;
    } else {
      const conditions = buildDateConditions(dateRange);
      sliceMatches = conditions.length > 0
        ? await db
            .select()
            .from(historicalMatchesTable)
            .where(and(...conditions))
            .orderBy(asc(historicalMatchesTable.scheduledStartAt))
        : await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt));
    }

    // Apply user filters
    const eligibleMatches = sliceMatches.filter((m) => !getExclusionReason(m, filters));

    const rowCounts = {
      total: sliceMatches.length,
      eligible: eligibleMatches.length,
      excluded: sliceMatches.length - eligibleMatches.length,
      exclusionReasons: sliceMatches.reduce<Record<string, number>>((acc, m) => {
        const reason = getExclusionReason(m, filters);
        if (reason) acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
      }, {}),
    };

    await db.update(backtestRunsTable).set({ rowCounts }).where(eq(backtestRunsTable.id, runId));

    if (eligibleMatches.length === 0) {
      await db
        .update(backtestRunsTable)
        .set({
          status: "completed-with-warnings",
          completedAt: new Date(),
          currentStage: "No eligible matches in date range",
          metrics: { n: 0, accuracy: null, logLoss: null, brier: null },
          errors: [{ message: "No eligible matches found for the selected date range and filters" }],
        })
        .where(eq(backtestRunsTable.id, runId));
      return;
    }

    // Check cancellation before expensive setup (uses hook if in test mode)
    await assertNotCancelled(runId, _hooks?.getCancellationStatus);
    await updateStatus("preparing", "Building scoring context", 0, eligibleMatches.length);

    // Build scoring context (FROZEN — never writes calibration/specialist rows)
    const identityIndex = await buildPlayerIdentityIndex();
    const previousSpecialistRows = await getActiveSpecialistSegments();
    const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
    const scoringContext: HistoricalScoringContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      matchHistory: buildMatchHistoryIndex(allMatchesForContext as any),
      eloHistory: await buildEloHistoryIndex(identityIndex),
      identityIndex,
      specialistRowsBySegmentKey,
    };

    // Get the current active calibration (frozen — not refit during this run)
    const [activeCalibration] = await db
      .select()
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1);
    const calibrationKnots = activeCalibration?.mapping ?? null;

    await updateStatus("running", "Scoring matches", 0, eligibleMatches.length);

    const retirementRule = (settings.retirementRule as RetirementRule) ?? "excluded";
    
    // Log effective config for audit
    if (candidateConfigId || effectiveConfig) {
      logger.info({ runId, candidateConfigId, configPresent: !!effectiveConfig }, "Backtest running with candidate config");
    }

    // Score matches and write to backtest_predictions
    const predictionRows: Array<{ player1Won: boolean; calibratedProbability: number; includedInAccuracy: boolean }> = [];
    const errors: Array<{ message: string; matchId?: string }> = [];

    let processed = 0;
    let loopIteration = 0;
    const PROGRESS_INTERVAL = 10;

    for (const match of eligibleMatches) {
      loopIteration++;
      try {
        const resultType = match.cancelled ? "cancelled" : match.walkover ? "walkover" : match.retired ? "retired" : "normal";
        const isVoid = resultType === "walkover" || resultType === "cancelled";
        const player1Won = match.winnerId === match.player1Id;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scored = scoreHistoricalMatch(match as any, scoringContext);
        const rawProbability = scored?.rawProbability ?? null;

        let calibratedProbability = rawProbability;
        if (rawProbability !== null && calibrationKnots && calibrationKnots.length > 0) {
          calibratedProbability = applyCalibration(calibrationKnots as Array<{ x: number; y: number }>, rawProbability);
        }

        const predictedWinnerId = calibratedProbability !== null ? (calibratedProbability >= 0.5 ? match.player1Id : match.player2Id) : null;
        const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included") && calibratedProbability !== null;

        // Skip real DB insert in test mode (matchesForTest provided) — avoids FK constraints.
        if (!_hooks?.matchesForTest) {
          await db.insert(backtestPredictionsTable).values({
            backtestRunId: runId,
            historicalMatchId: String(match.id),
            player1Id: match.player1Id,
            player1Name: match.player1Name,
            player2Id: match.player2Id,
            player2Name: match.player2Name,
            surface: match.surface,
            matchFormat: match.matchFormat,
            tournamentLevel: match.tournamentLevel,
            tournamentName: match.tournamentName,
            scheduledStartAt: match.scheduledStartAt,
            modelVersion: HISTORICAL_MODEL_VERSION,
            rawProbability: rawProbability !== null ? rawProbability * 100 : null,
            calibratedProbability: calibratedProbability !== null ? calibratedProbability * 100 : null,
            predictedWinnerId,
            predictedWinnerName: predictedWinnerId === match.player1Id ? match.player1Name : predictedWinnerId === match.player2Id ? match.player2Name : null,
            actualWinnerId: match.winnerId,
            actualWinnerName: match.winnerId === match.player1Id ? match.player1Name : match.winnerId === match.player2Id ? match.player2Name : null,
            resultType,
            includedInAccuracy,
            player1Won: match.winnerId !== null ? player1Won : null,
            featureSnapshot: scored?.snapshot ?? null,
          });
        }

        if (includedInAccuracy && calibratedProbability !== null) {
          predictionRows.push({ player1Won, calibratedProbability: calibratedProbability * 100, includedInAccuracy });
        }

        processed++;
      } catch (err) {
        // Re-throw cancellation — do not swallow it into the error array.
        if (err instanceof BacktestCancelledError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ message, matchId: String(match.id) });
        logger.warn({ err, matchId: match.id }, "Backtest scoring error for match");
      }

      // Hook fires after every match attempt (success or scoring error), giving tests a
      // reliable loop-iteration counter regardless of whether real DB inserts are active.
      // We use `loopIteration` (not `processed`) so the count is always 1-based and monotonic.
      _hooks?.onPredictionInserted?.(loopIteration);

      if (loopIteration % PROGRESS_INTERVAL === 0 || loopIteration === eligibleMatches.length) {
        if (!_hooks?.onRunUpdated) {
          await db
            .update(backtestRunsTable)
            .set({ processedRows: processed, currentStage: `Scoring matches ${processed} / ${eligibleMatches.length}` })
            .where(eq(backtestRunsTable.id, runId));
        }
        // Cooperative cancellation: check status every PROGRESS_INTERVAL matches.
        // Production: re-reads from DB. Tests: calls getCancellationStatus hook.
        await assertNotCancelled(runId, _hooks?.getCancellationStatus);
      }
    }

    await updateStatus("generating-report", "Computing metrics");

    // Compute aggregate metrics from scored predictions
    // We re-read from the DB to use the full evaluation_predictions-style metrics computation
    const backtestRows = await db.select().from(backtestPredictionsTable).where(eq(backtestPredictionsTable.backtestRunId, runId));

    // Adapt backtest rows to the shape computeSegmentMetrics expects
    const adaptedRows = backtestRows.map((r) => ({
      ...r,
      // Fields computeSegmentMetrics needs but backtestPredictions doesn't have as separate columns
      status: r.includedInAccuracy ? "graded" : "void",
      runKind: "backtest" as const,
      segment: "test",
      foldId: null,
      player1Won: r.player1Won,
      missedCount: 0,
      // Map boolean player1Won → actualWinnerId semantics that computeSegmentMetrics uses
    }));

    // Compute close-match accuracy (calibrated prob 45-55%)
    const closeMatchRows = backtestRows.filter(
      (r) => r.includedInAccuracy && r.calibratedProbability !== null && r.calibratedProbability >= 45 && r.calibratedProbability <= 55,
    );
    const closeMatchCorrect = closeMatchRows.filter(
      (r) => r.predictedWinnerId === r.actualWinnerId,
    ).length;
    const closeMatchAccuracy = closeMatchRows.length > 0 ? Math.round((closeMatchCorrect / closeMatchRows.length) * 1000) / 10 : null;

    // Compute retirement-adjusted accuracy (include retirements)
    const retiredRows = backtestRows.filter((r) => r.resultType === "retired" && r.calibratedProbability !== null && r.actualWinnerId !== null);
    const retiredCorrect = retiredRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;

    // Core accuracy from includedInAccuracy rows
    const accuracyRows = backtestRows.filter((r) => r.includedInAccuracy && r.actualWinnerId !== null);
    const correct = accuracyRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;
    const accuracy = accuracyRows.length > 0 ? Math.round((correct / accuracyRows.length) * 1000) / 10 : null;

    // Log loss (using calibratedProbability)
    const llRows = backtestRows.filter((r) => r.includedInAccuracy && r.calibratedProbability !== null && r.actualWinnerId !== null);
    let logLoss: number | null = null;
    if (llRows.length > 0) {
      const sum = llRows.reduce((acc, r) => {
        const p = (r.calibratedProbability as number) / 100;
        const y = r.actualWinnerId === r.player1Id ? 1 : 0;
        const clipped = Math.max(1e-7, Math.min(1 - 1e-7, p));
        return acc + -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
      }, 0);
      logLoss = Math.round((sum / llRows.length) * 1e5) / 1e5;
    }

    // Brier score
    let brier: number | null = null;
    if (llRows.length > 0) {
      const sum = llRows.reduce((acc, r) => {
        const p = (r.calibratedProbability as number) / 100;
        const y = r.actualWinnerId === r.player1Id ? 1 : 0;
        return acc + Math.pow(p - y, 2);
      }, 0);
      brier = Math.round((sum / llRows.length) * 1e5) / 1e5;
    }

    const dateRangeStart = eligibleMatches.length > 0 ? eligibleMatches[0].scheduledStartAt.toISOString() : null;
    const dateRangeEnd = eligibleMatches.length > 0 ? eligibleMatches[eligibleMatches.length - 1].scheduledStartAt.toISOString() : null;

    const retiredCount = backtestRows.filter((r) => r.resultType === "retired").length;
    const voidCount = backtestRows.filter((r) => !r.includedInAccuracy && r.resultType !== null).length;

    // Calibration buckets for chart
    const bucketEdges = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
    const calibrationBuckets = bucketEdges.slice(0, -1).map((edge, i) => {
      const lo = edge;
      const hi = bucketEdges[i + 1];
      const buckRows = llRows.filter((r) => {
        const p = r.calibratedProbability as number;
        const dist = p >= 50 ? p : 100 - p;
        return dist >= lo && dist < hi;
      });
      const buckCorrect = buckRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;
      return {
        label: `${lo}–${hi}%`,
        n: buckRows.length,
        observedAccuracy: buckRows.length > 0 ? Math.round((buckCorrect / buckRows.length) * 1000) / 10 : null,
        avgPredicted: buckRows.length > 0 ? buckRows.reduce((a, r) => a + (r.calibratedProbability as number) / 100, 0) / buckRows.length : null,
      };
    });

    const metrics = {
      n: accuracyRows.length,
      accuracy,
      logLoss,
      brier,
      closeMatchAccuracy,
      retirementAdjustedAccuracy:
        retiredRows.length > 0 ? Math.round(((correct + retiredCorrect) / (accuracyRows.length + retiredRows.length)) * 1000) / 10 : accuracy,
      retiredCount,
      voidCount,
      dateRangeStart,
      dateRangeEnd,
      calibrationBuckets,
    };

    const finalStatus = errors.length > 0 ? "completed-with-warnings" : "completed";

    // Guard: check status before writing the terminal state. If the run was cancelled
    // while we were computing metrics, do not overwrite it with 'completed'.
    // Uses the hook in test mode; re-reads from DB in production.
    const currentStatusBeforeFinalWrite = _hooks?.getCancellationStatus
      ? await _hooks.getCancellationStatus(runId)
      : await db
          .select({ status: backtestRunsTable.status })
          .from(backtestRunsTable)
          .where(eq(backtestRunsTable.id, runId))
          .then((rows) => rows[0]?.status ?? null);

    if (currentStatusBeforeFinalWrite === "cancelled") {
      logger.info({ runId }, "Backtest run was cancelled before final write — preserving cancelled status");
      return;
    }

    if (_hooks?.onRunUpdated) {
      await _hooks.onRunUpdated({ status: finalStatus, currentStage: "Completed", processedRows: processed, metrics, rowCounts });
    } else {
      await db
        .update(backtestRunsTable)
        .set({
          status: finalStatus,
          completedAt: new Date(),
          processedRows: processed,
          currentStage: "Completed",
          metrics,
          errors: errors.length > 0 ? errors : null,
          rowCounts,
        })
        .where(eq(backtestRunsTable.id, runId));
    }
  } catch (err) {
    // Cancellation is intentional — do not overwrite the 'cancelled' status the
    // API already wrote, and do not mark the run as 'failed'.
    if (err instanceof BacktestCancelledError) {
      logger.info({ runId }, "Backtest run exited cooperatively due to cancellation");
      // The API route already wrote status='cancelled'; nothing more to do.
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId }, "Backtest run failed");
    if (!_hooks?.onRunUpdated) {
      await db
        .update(backtestRunsTable)
        .set({
          status: "failed",
          completedAt: new Date(),
          currentStage: "Failed",
          errors: [{ message }],
        })
        .where(eq(backtestRunsTable.id, runId));
    }
    throw err;
  }
}
