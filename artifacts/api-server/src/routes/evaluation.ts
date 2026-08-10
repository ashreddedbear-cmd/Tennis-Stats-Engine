import { Router, type IRouter } from "express";
import { resolve as resolvePath, join as joinPath } from "path";
import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db, evaluationPredictionsTable, evaluationRunsTable, calibrationModelsTable, specialistModelsTable, jobRunsTable, historicalMatchesTable } from "@workspace/db";
import { invalidateCalibrationCache } from "../services/evaluation/calibrationCache";
import { logger } from "../lib/logger";
import {
  ListEvaluationPredictionsQueryParams,
  ListEvaluationPredictionsResponse,
  GetEvaluationPredictionParams,
  GetEvaluationPredictionResponse,
  ListEvaluationRunsResponse,
  RunWalkForwardBody,
  RunWalkForwardResponse,
  GetEvaluationDashboardResponse,
  GetEvaluationSettingsResponse,
  UpdateEvaluationSettingsBody,
  UpdateEvaluationSettingsResponse,
  RunPaperTradingCycleResponse,
  ListPaperTradingJobRunsQueryParams,
  ListPaperTradingJobRunsResponse,
  ListCalibrationRefitJobRunsQueryParams,
  ListCalibrationRefitJobRunsResponse,
  GetSimulatorValidationResponse,
  RunAblationAnalysisBody,
  RunAblationAnalysisResponse,
  GetAblationStatusResponse,
  RunShadowReplayBody,
  RunShadowReplayResponse,
  GetShadowReplayDashboardResponse,
} from "@workspace/api-zod";
import { PAPER_TRADING_JOB_NAME } from "../jobs/paperTradingJobName";
import { CALIBRATION_REFIT_JOB_NAME } from "../jobs/calibrationRefitJobName";
import { runWalkForwardEvaluation, MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE } from "../services/evaluation/walkForward";
import { type SpecialistComputedData } from "../services/evaluation/specialistWeights";
import { runPaperTradingCycle } from "../services/evaluation/paperTrading";
import { getPredictionSettings } from "../services/evaluation/settle";
import {
  computeSegmentMetrics,
  computeCalibrationBuckets,
  computeStreaks,
  computeUpsetRiskTierMetrics,
  computeDisagreementTierMetrics,
  computeMarketEdgeSummary,
} from "../services/evaluation/metrics";
import { computeEliteTierBacktest } from "../services/evaluation/eliteTierBacktest";
import { getActiveSpecialistSegments } from "../services/evaluation/specialistWeights";
import { validateAndStoreSimulator } from "../services/evaluation/simulatorValidation";
import { predictionSettingsTable, simulatorValidationTable } from "@workspace/db";
import { startAblationJob, getAblationJobStatus } from "../services/evaluation/ablationJob";
import { runShadowPaperTradingReplay, listShadowReplayBatches } from "../services/evaluation/shadowReplay";
import { isPipelineQuiet, PAPER_TRADE_QUIET_WINDOW_HOURS, sendPipelineQuietAlert, resetAlertCooldown } from "../services/evaluation/paperTradingQuiet";
import { usedHistoricalMatchFallback } from "../services/predictionEngine/playerProfileWarnings";
import { runIncrementalHistoricalBackfill, runHistoricalBackfill, getLatestCoveredMatchDate } from "../services/historicalData/backfill";
import { runSackmannBackfill, runSackmannLocalBackfill, SACKMANN_PROVIDER } from "../services/historicalData/sackmannBackfill";
import { runTennisDataCoUkBackfill, TENNIS_DATA_CO_UK_PROVIDER } from "../services/historicalData/tennisDataCoUkBackfill";
import { runExternalCsvBackfill, EXT_CSV_PROVIDER } from "../services/historicalData/externalCsvBackfill";
import {
  runExternalCsvBridge,
  clearAffectedEvalPredictions,
  orchestrateBridgeRefresh,
  type DbLike as BridgeDbLike,
} from "../services/historicalData/externalCsvBridge";
import { startBridgeRescoreJob, getBridgeRescoreJobStatus, BRIDGE_RESCORE_JOB_NAME } from "../services/evaluation/bridgeRescoreJob";
import { getTennisDataProvider } from "../services/tennisData";
import { HISTORICAL_BACKFILL_JOB_NAME } from "../jobs/historicalBackfillJobName";
import {
  RunHistoricalBackfillCycleResponse,
  RunHistoricalBackfillRangeBody,
  RunHistoricalBackfillRangeResponse,
  ListHistoricalBackfillJobRunsQueryParams,
  ListHistoricalBackfillJobRunsResponse,
  GetHistoricalDataFreshnessResponse,
  GetPredictionStatsResponse,
  RunOptimizerBody,
  GetLatestPatternAnalysisResponse,
  GetLatestThresholdEvaluationResponse,
  StartWalkForwardResponse,
  WalkForwardJobStatusResponse,
  StartOptimizerResponse,
  OptimizerJobStatusResponse,
  GetOptimizerAccuracySummaryResponse,
  GetEvaluationPredictionStatsQueryParams,
  ActivateWalkForwardResponse,
  type PendingCalibrationModelSummary,
} from "@workspace/api-zod";
import { runRankingVerification } from "../services/historicalData/rankingVerification";
import { startWalkForwardJob, getWalkForwardJobStatus } from "../services/evaluation/walkForwardJob";
import { startOptimizerJob, getOptimizerJobStatus } from "../services/evaluation/optimizerJob";
import { getLatestPatternAnalysis } from "../services/evaluation/patternAnalysis";
import { getLatestThresholdEvaluation } from "../services/evaluation/thresholdEvaluation";
import { getOptimizerAccuracySummary } from "../services/evaluation/optimizerSummary";
import { runCalibrationRefitJob, checkRefitCooldown } from "../jobs/runCalibrationRefitJob";
import { refitCalibrationFromExistingEvaluationData } from "../services/evaluation/calibrationRefitFromExisting";
import { computeRecommendation, type Recommendation } from "../services/predictionEngine/recommendation";
import { enforceEntitlement } from "../lib/entitlements";
import { requireAdmin } from "../lib/adminAuth";
import {
  canUseCompetitiveBalance,
  canUseDeveloperAnalytics,
  canUseEliteRecommendations,
  canUseEvidenceReliability,
  canUseOptimizer,
  canUsePredictionHistory,
  canUseShadowReplay,
  canUseWalkForward,
} from "../services/payments/entitlementService";

const router: IRouter = Router();
let calibrationRefitInFlight = false;

/**
 * Task #30: mirrors `withHistoricalMatchFallbackFlag` in `routes/predictions.ts` for evaluation
 * rows -- the real engine warnings live inside `featureSnapshot.engine.warnings` here (a free-form
 * JSONB blob, reduced-shape for historical_test rows and full `EngineBreakdown` for paper_trade/
 * live -- see `historicalScoring.ts`/`paperTrading.ts`), never a new guess.
 */
function withEvaluationHistoricalMatchFallbackFlag<T extends { featureSnapshot: unknown }>(
  row: T,
): T & { usedHistoricalMatchFallback: boolean } {
  const snapshot = row.featureSnapshot as { engine?: { warnings?: unknown } } | null;
  return { ...row, usedHistoricalMatchFallback: usedHistoricalMatchFallback(snapshot?.engine?.warnings) };
}

function deriveRecommendationFromEvaluationRow(row: {
  calibratedProbability: number | null;
  dataQuality: number | null;
  tieBreakerApplied: boolean | null;
  modelAgreement: string | null;
  upsetRiskTier: string | null;
}): Recommendation | null {
  if (typeof row.calibratedProbability !== "number" || !Number.isFinite(row.calibratedProbability)) return null;
  if (typeof row.modelAgreement !== "string" || typeof row.upsetRiskTier !== "string") return null;
  if (typeof row.dataQuality !== "number" || !Number.isFinite(row.dataQuality)) return null;

  const dataQuality = row.dataQuality;
  const dataQualityLabel = dataQuality >= 85 ? "Excellent" : dataQuality >= 65 ? "Strong" : dataQuality >= 45 ? "Acceptable" : dataQuality >= 25 ? "Limited" : "Poor";
  const tieBreakerApplied = row.tieBreakerApplied === true;
  return computeRecommendation(row.calibratedProbability, dataQuality, dataQualityLabel, row.modelAgreement as Parameters<typeof computeRecommendation>[3], tieBreakerApplied);
}

router.get("/evaluation/runs", async (_req, res): Promise<void> => {
  const rows = await db.select().from(evaluationRunsTable).orderBy(desc(evaluationRunsTable.foldIndex));
  res.json(ListEvaluationRunsResponse.parse(rows));
});

/**
 * Stage A2: Fire walk-forward in the background, respond immediately so the browser
 * never hits the Replit proxy timeout. Poll GET /evaluation/walk-forward/status.
 */
router.post("/evaluation/walk-forward/run", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseWalkForward, "walkForward"))) return;

  const parsed = RunWalkForwardBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Guard against silent no-op refit calls: callers must be explicit about evaluation-only
  // behavior. Empty-body POSTs default to true in schema-land and would otherwise silently skip
  // calibration refitting.
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rawBody, "evaluationOnly")) {
    res.status(400).json({
      error:
        "Missing required field 'evaluationOnly'. Pass true for metrics-only walk-forward, or false to refit calibration/specialists.",
    });
    return;
  }

  // Task #127: optional date-range backfill. Both must be YYYY-MM-DD strings if provided.
  const dateRangeRaw = { startDate: rawBody["startDate"], endDate: rawBody["endDate"] };
  const hasStart = dateRangeRaw.startDate !== undefined;
  const hasEnd = dateRangeRaw.endDate !== undefined;
  if (hasStart !== hasEnd) {
    res.status(400).json({ error: "startDate and endDate must both be provided or both omitted." });
    return;
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (hasStart && (typeof dateRangeRaw.startDate !== "string" || !dateRe.test(dateRangeRaw.startDate))) {
    res.status(400).json({ error: "startDate must be a YYYY-MM-DD string." });
    return;
  }
  if (hasEnd && (typeof dateRangeRaw.endDate !== "string" || !dateRe.test(dateRangeRaw.endDate))) {
    res.status(400).json({ error: "endDate must be a YYYY-MM-DD string." });
    return;
  }

  const result = await startWalkForwardJob({
    ...parsed.data,
    ...(hasStart ? { startDate: dateRangeRaw.startDate as string, endDate: dateRangeRaw.endDate as string } : {}),
    // Task #198: training-mode runs require admin approval before the model goes live.
    // evaluationOnly=true runs never write a model, so requireApproval is a no-op for them.
    // Read from rawBody because RunWalkForwardBody Zod schema does not include evaluationOnly.
    requireApproval: rawBody["evaluationOnly"] === false,
  });
  res.json(StartWalkForwardResponse.parse(result));
});

/**
 * POST /evaluation/calibration-refit-from-existing/run
 *
 * Step 1 (2026-08-10): Fast calibration refit from existing evaluation_predictions data.
 * Does NOT need a walk-forward run — reads all validation-segment rows already in the DB,
 * joins to historical_matches to get the source provider, applies the predicted-winner
 * orientation fix (including WINNER_ALWAYS_PLAYER1_PROVIDERS: sackmann, tennis-data-co-uk),
 * fits a new calibration model, and activates it if it passes the quality gates.
 *
 * Runs synchronously (~3-10 seconds). Returns a full diagnostic report including:
 *   - Per-provider row counts and contamination flags
 *   - Fit method, holdout log-loss, sample sizes
 *   - Whether the new model was activated and why/why not
 *   - Reference case outputs before and after (Kostyuk, Rinderknech, Pegula)
 *
 * Requires admin access — this writes to calibration_models and may deactivate the current model.
 */
router.post("/evaluation/calibration-refit-from-existing/run", requireAdmin, async (req, res): Promise<void> => {
  try {
    // Optional minDate (YYYY-MM-DD): restricts fit to rows with scheduledStartAt >= minDate.
    // Prevents full-corpus dilution — recent rows only produce better-calibrated live models.
    const rawBody = req.body as Record<string, unknown>;
    const minDate = typeof rawBody["minDate"] === "string" ? rawBody["minDate"] : undefined;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (minDate !== undefined && !dateRe.test(minDate)) {
      res.status(400).json({ error: "minDate must be a YYYY-MM-DD string." });
      return;
    }
    const report = await refitCalibrationFromExistingEvaluationData(minDate);
    res.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "calibration-refit-from-existing: failed");
    res.status(500).json({ error: message });
  }
});

router.post("/evaluation/calibration-refit/run", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  if (calibrationRefitInFlight) {
    res.json({ started: false, reason: "A calibration-refit run is already in progress." });
    return;
  }

  // Restart-resistant cooldown: query the DB so a server restart doesn't reset the guard.
  // If the most recently fitted calibration model is less than 2 hours old, reject early
  // with a clear "recently completed" response instead of starting a new run that would
  // produce a small, low-quality model.
  const cooldown = await checkRefitCooldown();
  if (cooldown.blocked) {
    const minRemaining = Math.ceil(cooldown.msRemaining / 60_000);
    res.json({
      started: false,
      skipped: true,
      reason: `Cooldown in effect — last fit ${cooldown.lastFittedAt?.toISOString() ?? "unknown"}, ${minRemaining}min remaining`,
      lastFittedAt: cooldown.lastFittedAt?.toISOString() ?? null,
      msRemaining: cooldown.msRemaining,
    });
    return;
  }

  calibrationRefitInFlight = true;
  res.json({ started: true });

  void runCalibrationRefitJob()
    .catch((err) => {
      logger.error({ err }, "Manual calibration-refit trigger failed");
    })
    .finally(() => {
      calibrationRefitInFlight = false;
    });
});

/**
 * Task #198: query DB for any pending model and return a summary for the status response.
 * Called for all non-running states — survives server restarts because it reads from DB.
 */
async function queryPendingModelSummary(): Promise<PendingCalibrationModelSummary | undefined> {
  const [pendingRow] = await db
    .select()
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.pendingActivation, true))
    .limit(1);
  if (!pendingRow) return undefined;

  const rawSpecialists = (pendingRow.pendingSpecialistData as Array<{
    segmentKey: string; meetsThreshold: boolean; logLoss: number | null;
    generalLogLoss: number | null; weight: number;
  }> | null) ?? [];

  return {
    modelId: pendingRow.id,
    fittedAt: pendingRow.fittedAt.toISOString(),
    method: pendingRow.method,
    isotonicHoldoutLogLoss: pendingRow.isotonicHoldoutLogLoss ?? null,
    holdoutSampleSize: pendingRow.holdoutSampleSize,
    validationSampleSize: pendingRow.validationSampleSize,
    specialistSegments: rawSpecialists.map((s) => ({
      segmentKey: s.segmentKey,
      meetsThreshold: s.meetsThreshold,
      logLoss: s.logLoss ?? null,
      generalLogLoss: s.generalLogLoss ?? null,
      weight: s.weight,
    })),
  };
}

router.get("/evaluation/walk-forward/status", async (_req, res): Promise<void> => {
  try {
    const status = getWalkForwardJobStatus();
    if (status.state === "running") {
      // Pull a live DB count so the UI can show real progress without requiring a progress callback
      // wired through the entire walk-forward stack.
      // Use a short timeout to prevent proxy hangs if the DB is slow.
      const [{ count }] = await Promise.race([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(evaluationPredictionsTable)
          .where(eq(evaluationPredictionsTable.runKind, "historical_test")),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Database query timeout")), 5000)
        ),
      ]);
      res.json(WalkForwardJobStatusResponse.parse({ ...status, matchesScored: count ?? 0 }));
      return;
    }
    // Task #198: surface any pending model so admin knows approval is outstanding.
    // Queried from DB so the status survives server restarts.
    const pendingModel = await queryPendingModelSummary();
    res.json(WalkForwardJobStatusResponse.parse({ ...status, pendingModel }));
  } catch (err) {
    logger.warn({ err }, "Walk-forward status query failed, returning current in-memory state");
    res.json(WalkForwardJobStatusResponse.parse(getWalkForwardJobStatus()));
  }
});

/**
 * Task #198: Admin-only endpoint to explicitly activate a pending calibration model.
 *
 * A training walk-forward with requireApproval=true stores the new calibration model with
 * pendingActivation=true instead of auto-activating it. This endpoint allows an admin to
 * review the quality-gate summary shown in GET /evaluation/walk-forward/status and then
 * approve the swap. On success:
 *  1. The currently-active model is deactivated.
 *  2. The pending model is activated (active=true, pendingActivation=false).
 *  3. The pending specialist segment data (stored as JSONB on the pending model row) is
 *     written to specialist_models, atomically replacing the live specialist weights.
 *
 * If the three quality gates fail at activation time (e.g. the active model improved since
 * the pending one was fit), the endpoint returns HTTP 422 with activated=false and the
 * rejection reason. The pending model is NOT cleared — the admin can investigate and
 * optionally trigger a fresh walk-forward instead.
 */
router.post("/evaluation/walk-forward/activate/:modelId", requireAdmin, async (req, res): Promise<void> => {
  const modelId = parseInt((req.params["modelId"] as string) ?? "", 10);
  if (isNaN(modelId)) {
    res.status(400).json({ error: "modelId must be an integer" });
    return;
  }

  // Find and validate the pending model
  const [pendingModel] = await db
    .select()
    .from(calibrationModelsTable)
    .where(and(eq(calibrationModelsTable.id, modelId), eq(calibrationModelsTable.pendingActivation, true)))
    .limit(1);

  if (!pendingModel) {
    res.status(404).json({
      error: `No pending calibration model found with id=${modelId}. Either it does not exist or it has already been activated.`,
    });
    return;
  }

  // Re-check quality gates using stored values (same three gates as walk-forward.ts)
  const [currentActiveModel] = await db
    .select({ id: calibrationModelsTable.id, isotonicHoldoutLogLoss: calibrationModelsTable.isotonicHoldoutLogLoss })
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);

  const gate1 = pendingModel.holdoutSampleSize > 0;
  const gate2 = pendingModel.holdoutSampleSize >= MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE;
  const activeLL = currentActiveModel?.isotonicHoldoutLogLoss ?? null;
  const newLL = pendingModel.isotonicHoldoutLogLoss ?? null;
  const gate3 =
    currentActiveModel === undefined || activeLL === null || (newLL !== null && newLL <= activeLL);

  if (!gate1 || !gate2 || !gate3) {
    const reason = !gate1
      ? `holdoutSampleSize === 0 (degenerate model — too few validation points)`
      : !gate2
        ? `holdoutSampleSize ${pendingModel.holdoutSampleSize} < floor ${MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE} (eligible set too sparse)`
        : `pending model holdout log-loss ${newLL?.toFixed(4) ?? "null"} > current active ${activeLL?.toFixed(4) ?? "null"} (pending model is now worse)`;
    logger.warn({ modelId, gate1, gate2, gate3, reason }, "Task #198: admin walk-forward activation rejected — quality gates failed");
    res.status(422).json(ActivateWalkForwardResponse.parse({ activated: false, modelId, reason }));
    return;
  }

  const specialistData = pendingModel.pendingSpecialistData as SpecialistComputedData[] | null;

  try {
    // All three writes run inside a single transaction so a mid-flight failure can never
    // leave the system without an active calibration model or with partially-written
    // specialist weights.  `invalidateCalibrationCache` is called only AFTER the commit
    // so the cache is never evicted for a transaction that rolled back.
    await db.transaction(async (tx) => {
      // 1. Deactivate the currently-active model (if any).
      await tx.update(calibrationModelsTable).set({ active: false }).where(eq(calibrationModelsTable.active, true));

      // 2. Activate the pending model and clear its pending flag.
      await tx
        .update(calibrationModelsTable)
        .set({ active: true, pendingActivation: false })
        .where(eq(calibrationModelsTable.id, modelId));

      // 3. Write specialist segments from the JSONB blob inside the same transaction so
      //    calibration_models and specialist_models are always consistent with each other.
      if (specialistData && specialistData.length > 0) {
        for (const summary of specialistData) {
          await tx
            .insert(specialistModelsTable)
            .values(summary)
            .onConflictDoUpdate({
              target: specialistModelsTable.segmentKey,
              set: { ...summary, computedAt: new Date() },
            });
        }
      } else {
        logger.warn({ modelId }, "Task #198: pending model has no stored specialist data — specialist_models not updated within transaction");
      }
    });

    // Evict the in-memory calibration cache so the next live prediction immediately fetches
    // the newly-active model.  Called after the transaction commits — never on a rollback.
    invalidateCalibrationCache();

    const activatedAt = new Date().toISOString();
    logger.info(
      { modelId, activatedAt, specialistSegments: specialistData?.length ?? 0, newLL, previousActiveModelId: currentActiveModel?.id ?? null },
      "Task #198: admin activated walk-forward calibration model and specialist segments",
    );
    res.json(ActivateWalkForwardResponse.parse({ activated: true, modelId, activatedAt }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, modelId }, "Task #198: admin walk-forward activation failed");
    res.status(500).json({ error: message });
  }
});

router.get("/evaluation/predictions", async (req, res): Promise<void> => {
  const parsed = ListEvaluationPredictionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { runKind, segment, status, limit } = parsed.data;

  const conditions = [];
  if (runKind) conditions.push(eq(evaluationPredictionsTable.runKind, runKind));
  if (segment) conditions.push(eq(evaluationPredictionsTable.segment, segment));
  if (status) conditions.push(eq(evaluationPredictionsTable.status, status));

  const rows = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(evaluationPredictionsTable.scheduledStartAt))
    .limit(limit);

  res.json(ListEvaluationPredictionsResponse.parse(rows.map(withEvaluationHistoricalMatchFallbackFlag)));
});

router.get("/evaluation/predictions/stats", async (req, res): Promise<void> => {
  const parsed = GetEvaluationPredictionStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions = [];
  if (parsed.data.runKind) conditions.push(eq(evaluationPredictionsTable.runKind, parsed.data.runKind));

  const [totals] = await db
    .select({
      totalPredictions: sql<number>`count(*)`.mapWith(Number),
      resolvedPredictions: sql<number>`count(*) filter (where ${evaluationPredictionsTable.actualWinnerId} is not null)`.mapWith(Number),
      correctPredictions: sql<number>`count(*) filter (where ${evaluationPredictionsTable.actualWinnerId} = ${evaluationPredictionsTable.predictedWinnerId})`.mapWith(Number),
    })
    .from(evaluationPredictionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  // Phase 9 perf fix: extract only the two scalar fields we need from featureSnapshot via
  // PostgreSQL JSONB operators instead of loading the entire blob for all 40k+ rows into Node.
  // This avoids the previous O(n) full-table JSONB load that caused ~19s page load times.
  const recommendationInputs = await db
    .select({
      calibratedProbability: evaluationPredictionsTable.calibratedProbability,
      dataQuality: sql<number | null>`(${evaluationPredictionsTable.featureSnapshot}->>'dataQuality')::real`,
      tieBreakerApplied: sql<boolean | null>`((${evaluationPredictionsTable.featureSnapshot}->'engine'->>'tieBreakerApplied'))::boolean`,
      modelAgreement: evaluationPredictionsTable.modelAgreement,
      upsetRiskTier: evaluationPredictionsTable.upsetRiskTier,
    })
    .from(evaluationPredictionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const byRecommendationCounts = new Map<Recommendation, number>();
  for (const row of recommendationInputs) {
    const recommendation = deriveRecommendationFromEvaluationRow(row);
    if (!recommendation) continue;
    byRecommendationCounts.set(recommendation, (byRecommendationCounts.get(recommendation) ?? 0) + 1);
  }

  const byRecommendationRows = Array.from(byRecommendationCounts.entries()).map(([recommendation, count]) => ({ recommendation, count }));

  const { totalPredictions, resolvedPredictions, correctPredictions } = totals ?? {
    totalPredictions: 0,
    resolvedPredictions: 0,
    correctPredictions: 0,
  };
  const accuracy = resolvedPredictions > 0 ? Math.round((correctPredictions / resolvedPredictions) * 1000) / 10 : null;

  res.json(
    GetPredictionStatsResponse.parse({
      totalPredictions,
      resolvedPredictions,
      correctPredictions,
      accuracy,
      byRecommendation: byRecommendationRows,
    }),
  );
});

router.get("/evaluation/predictions/:predictionId", async (req, res): Promise<void> => {
  const params = GetEvaluationPredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.id, params.data.predictionId));
  if (!row) {
    res.status(404).json({ error: "Evaluation prediction not found" });
    return;
  }
  res.json(GetEvaluationPredictionResponse.parse(withEvaluationHistoricalMatchFallbackFlag(row)));
});

router.get("/evaluation/dashboard", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseWalkForward, "walkForward"))) return;
  if (!(await enforceEntitlement(res, canUseCompetitiveBalance, "competitiveBalance"))) return;
  if (!(await enforceEntitlement(res, canUseEvidenceReliability, "evidenceReliability"))) return;
  if (!(await enforceEntitlement(res, canUseEliteRecommendations, "eliteRecommendations"))) return;
  if (!(await enforceEntitlement(res, canUseDeveloperAnalytics, "developerAnalytics"))) return;

  // Each segment is fetched with its own indexed WHERE (runKind [+ segment]) instead of loading
  // the entire evaluation_predictions table into Node and filtering in JS -- same three segments,
  // same rows per segment, but the query no longer scales with total table size.
  const [historicalValidationRows, historicalTestRows, paperTradeRows] = await Promise.all([
    db
      .select()
      .from(evaluationPredictionsTable)
      .where(and(eq(evaluationPredictionsTable.runKind, "historical_test"), eq(evaluationPredictionsTable.segment, "validation"))),
    db
      .select()
      .from(evaluationPredictionsTable)
      .where(and(eq(evaluationPredictionsTable.runKind, "historical_test"), eq(evaluationPredictionsTable.segment, "test"))),
    db
      .select()
      .from(evaluationPredictionsTable)
      .where(inArray(evaluationPredictionsTable.runKind, ["paper_trade", "live"])),
  ]);

  const segmentDefs = [
    {
      key: "historical_validation",
      label: "Historical Test — Validation (used to fit calibration)",
      isGenuinelyUnseen: false,
      rows: historicalValidationRows,
    },
    {
      key: "historical_test",
      label: "Historical Test — Test (never used for tuning)",
      isGenuinelyUnseen: true,
      rows: historicalTestRows,
    },
    {
      key: "paper_trade",
      label: "Live Paper Trading (real upcoming fixtures)",
      isGenuinelyUnseen: true,
      rows: paperTradeRows,
    },
  ];

  const segments = segmentDefs.map((def) => ({
    key: def.key,
    label: def.label,
    isGenuinelyUnseen: def.isGenuinelyUnseen,
    metrics: computeSegmentMetrics(def.rows),
    calibrationBuckets: computeCalibrationBuckets(def.rows),
    streaks: computeStreaks(def.rows),
  }));

  const [activeCalibration] = await db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1);
  const specialistSegments = await getActiveSpecialistSegments();

  // Task 46: Elite tier backtest, scoped to the SAME genuinely-unseen rows the dashboard already
  // separates out (historical_test test-segment + paper_trade/live) -- never the validation
  // segment, which was used to fit calibration.
  const eliteTierBacktest = computeEliteTierBacktest([...historicalTestRows, ...paperTradeRows]);

  // Task 56: disagreement/upset-risk are pure downstream classifiers of the already-calibrated
  // probability (see disagreement.ts/upsetRisk.ts) -- they cannot move accuracy/logLoss/Brier
  // themselves, so their validation is tier-level monotonicity, scoped to the same genuinely-
  // unseen rows the Elite tier backtest already uses (never the validation segment, which was
  // used to fit calibration).
  const unseenRows = [...historicalTestRows, ...paperTradeRows];
  const upsetRiskTierMetrics = computeUpsetRiskTierMetrics(unseenRows);
  const disagreementTierMetrics = computeDisagreementTierMetrics(unseenRows);

  // Task 47: rolling average market edge. Only paper_trade/live rows ever have real market odds
  // (historical_test replays past matches, for which no live odds source can honestly provide a
  // contemporaneous quote), so this is scoped to paper trading -- computeMarketEdgeSummary already
  // excludes rows with no edge value rather than treating them as 0.
  const marketEdge = computeMarketEdgeSummary(paperTradeRows);

  res.json(
    GetEvaluationDashboardResponse.parse({
      segments,
      activeCalibrationSampleSize: activeCalibration?.validationSampleSize ?? 0,
      activeCalibrationMethod: activeCalibration?.method ?? null,
      activeCalibrationIsotonicHoldoutLogLoss: activeCalibration?.isotonicHoldoutLogLoss ?? null,
      activeCalibrationPlattHoldoutLogLoss: activeCalibration?.plattHoldoutLogLoss ?? null,
      specialistSegments,
      eliteTierBacktest,
      upsetRiskTierMetrics,
      disagreementTierMetrics,
      marketEdge,
    }),
  );
});

router.get("/evaluation/settings", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseWalkForward, "walkForward"))) return;

  const settings = await getPredictionSettings();
  res.json(GetEvaluationSettingsResponse.parse(settings));
});

router.patch("/evaluation/settings", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseWalkForward, "walkForward"))) return;

  const parsed = UpdateEvaluationSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const current = await getPredictionSettings();
  const [updated] = await db
    .update(predictionSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(predictionSettingsTable.id, current.id))
    .returning();

  res.json(UpdateEvaluationSettingsResponse.parse(updated));
});

router.get("/evaluation/simulator", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const [row] = await db.select().from(simulatorValidationTable).limit(1);
  if (!row) {
    res.json(
      GetSimulatorValidationResponse.parse({
        sampleSize: 0,
        minSampleSize: 30,
        simulatorAccuracy: null,
        simulatorLogLoss: null,
        simulatorBrier: null,
        ensembleAccuracy: null,
        ensembleLogLoss: null,
        ensembleBrier: null,
        adopted: false,
        weight: 0,
        note: "No validation run has completed yet -- POST /api/evaluation/simulator/validate to compute one from real graded outcomes.",
        computedAt: null,
      }),
    );
    return;
  }
  res.json(GetSimulatorValidationResponse.parse(row));
});

router.post("/evaluation/simulator/validate", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const summary = await validateAndStoreSimulator();
  res.json(
    GetSimulatorValidationResponse.parse({
      ...summary,
      computedAt: new Date().toISOString(),
    }),
  );
});

router.post("/paper-trading/run-cycle", async (_req, res): Promise<void> => {
  const summary = await runPaperTradingCycle();
  res.json(RunPaperTradingCycleResponse.parse(summary));
});

/**
 * GET /evaluation/paper-trading/status — Task #110
 * Returns last-run time, graded count, and pipeline-quiet alert state.
 * Safe to poll from the admin UI without triggering any side effects.
 */
router.get("/paper-trading/status", async (_req, res): Promise<void> => {
  try {

    // Latest completed paper-trading cycle (from job_runs table)
    const [lastRun] = await db
      .select({ finishedAt: jobRunsTable.finishedAt, status: jobRunsTable.status })
      .from(jobRunsTable)
      .where(and(eq(jobRunsTable.jobName, PAPER_TRADING_JOB_NAME), isNotNull(jobRunsTable.finishedAt)))
      .orderBy(desc(jobRunsTable.finishedAt))
      .limit(1);

    // Fallback: if no job_runs row exists yet, derive last-run from the newest locked prediction
    const [latestLock] = lastRun
      ? [null]
      : await db
          .select({ lockedAt: evaluationPredictionsTable.lockedAt })
          .from(evaluationPredictionsTable)
          .where(eq(evaluationPredictionsTable.runKind, "paper_trade"))
          .orderBy(desc(evaluationPredictionsTable.lockedAt))
          .limit(1);

    const lastRunAt: Date | null = lastRun?.finishedAt ?? latestLock?.lockedAt ?? null;

    const [counts] = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        graded: sql<number>`COUNT(*) FILTER (WHERE ${evaluationPredictionsTable.status} = 'graded')::int`,
      })
      .from(evaluationPredictionsTable)
      .where(eq(evaluationPredictionsTable.runKind, "paper_trade"));

    const quiet = isPipelineQuiet(lastRunAt, PAPER_TRADE_QUIET_WINDOW_HOURS);
    const hoursSinceLastRun = lastRunAt
      ? Math.round(((Date.now() - lastRunAt.getTime()) / (1000 * 60 * 60)) * 10) / 10
      : null;

    // Fire the operator alert (if wired) whenever the status endpoint detects silence.
    // sendPipelineQuietAlert has a built-in cooldown so it won't spam on every poll.
    let alertOutcome: string | undefined;
    if (quiet) {
      const outcome = await sendPipelineQuietAlert(lastRunAt);
      alertOutcome = outcome;
      if (outcome === "fired") {
        logger.warn({ lastRunAt: lastRunAt?.toISOString() ?? null, hoursSinceLastRun }, "Pipeline-quiet alert fired");
      } else if (outcome.startsWith("error:")) {
        logger.error({ outcome, lastRunAt: lastRunAt?.toISOString() ?? null }, "Pipeline-quiet alert send failed");
      }
    }

    res.json({
      lastRunAt: lastRunAt?.toISOString() ?? null,
      hoursSinceLastRun,
      quietWindowHours: PAPER_TRADE_QUIET_WINDOW_HOURS,
      pipelineQuiet: quiet,
      alertOutcome: alertOutcome ?? null,
      gradedCount: counts?.graded ?? 0,
      totalCount: counts?.total ?? 0,
    });
  } catch (e) {
    logger.error({ err: e }, "paper-trading/status query failed");
    res.status(500).json({ error: e instanceof Error ? e.message : "Status query failed" });
  }
});

/**
 * POST /evaluation/paper-trading/test-quiet-alert  (admin-only)
 * Forces a pipeline-quiet alert to fire immediately, bypassing the cooldown.
 * Use this for the live test in Item 2: confirm the alert reaches the webhook,
 * then call this again after a successful cycle to confirm it stops firing.
 */
router.post("/paper-trading/test-quiet-alert", requireAdmin, async (_req, res): Promise<void> => {
  try {
    // Fetch the real last-run timestamp so the alert message has accurate data
    const [lastRun] = await db
      .select({ finishedAt: jobRunsTable.finishedAt })
      .from(jobRunsTable)
      .where(and(eq(jobRunsTable.jobName, PAPER_TRADING_JOB_NAME), isNotNull(jobRunsTable.finishedAt)))
      .orderBy(desc(jobRunsTable.finishedAt))
      .limit(1);

    const lastRunAt: Date | null = lastRun?.finishedAt ?? null;

    resetAlertCooldown();
    const outcome = await sendPipelineQuietAlert(lastRunAt, /* force */ true);

    res.json({
      outcome,
      webhookConfigured: Boolean(process.env.QUIET_PIPELINE_ALERT_WEBHOOK_URL?.trim()),
      lastRunAt: lastRunAt?.toISOString() ?? null,
      firedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Test alert failed" });
  }
});

router.get("/paper-trading/job-runs", async (req, res): Promise<void> => {
  const parsed = ListPaperTradingJobRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, PAPER_TRADING_JOB_NAME))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(parsed.data.limit);

  res.json(ListPaperTradingJobRunsResponse.parse(rows));
});

router.get("/evaluation/bridge-rescore/status", async (_req, res): Promise<void> => {
  const [latestRun] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, BRIDGE_RESCORE_JOB_NAME))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json(latestRun
    ? {
        id: latestRun.id,
        status: latestRun.status,
        startedAt: latestRun.startedAt.toISOString(),
        finishedAt: latestRun.finishedAt?.toISOString() ?? null,
        matchesRescored: (latestRun.summary as { rowsRescored?: number } | null)?.rowsRescored ?? 0,
        errorMessage: latestRun.errorMessage,
      }
    : null);
});

/**
 * Task #33: Admin-only trigger for a full calibration refit (walk-forward with evaluationOnly=false).
 * Protected by requireAdmin (bypasses the subscription entitlement gate) so the owner can always
 * refit the model regardless of payment status. Runs in the background — poll
 * GET /evaluation/walk-forward/status to track progress.
 *
 * This exists separately from POST /evaluation/walk-forward/run (entitlement-gated, defaults
 * evaluationOnly=true via the HTTP body schema) so the admin can refit without navigating the
 * subscription UI and without accidentally triggering an evaluationOnly run.
 */
router.post("/evaluation/calibration-refit", requireAdmin, async (_req, res): Promise<void> => {
  // Use the same in-process flag as the entitlement-gated endpoint so a concurrent call
  // from either path is blocked. The restart-resistant cooldown check below is the durable
  // guard; this flag only prevents two simultaneous in-flight runs within a single process.
  if (calibrationRefitInFlight) {
    res.json({ started: false, reason: "A calibration-refit run is already in progress." });
    return;
  }

  // Restart-resistant cooldown: query the DB so a server restart doesn't reset the guard.
  // If the most recently fitted calibration model is less than 2 hours old, reject early
  // with a clear "recently completed" response instead of starting a new run that would
  // process only the handful of matches added during the restart window and produce a
  // small, low-quality model.
  const cooldown = await checkRefitCooldown();
  if (cooldown.blocked) {
    const minRemaining = Math.ceil(cooldown.msRemaining / 60_000);
    res.json({
      started: false,
      skipped: true,
      reason: `Cooldown in effect — last fit ${cooldown.lastFittedAt?.toISOString() ?? "unknown"}, ${minRemaining}min remaining`,
      lastFittedAt: cooldown.lastFittedAt?.toISOString() ?? null,
      msRemaining: cooldown.msRemaining,
    });
    return;
  }

  // Route through runCalibrationRefitJob so every attempt is recorded in job_runs and is
  // auditable via GET /evaluation/calibration-refit/job-runs. Pass bypassGradeCountGuard:true
  // so the admin can force a refit even without 500+ new graded predictions; the
  // cooldown check above already blocks post-restart redundant calls.
  calibrationRefitInFlight = true;
  res.json({ started: true });

  void runCalibrationRefitJob({ bypassGradeCountGuard: true })
    .catch((err) => {
      logger.error({ err }, "Admin calibration-refit trigger failed");
    })
    .finally(() => {
      calibrationRefitInFlight = false;
    });
});

/**
 * Admin-only trigger for a full walk-forward refit (evaluationOnly=false). Bypasses the
 * subscription entitlement gate so the owner can always refit the model. Runs in the background
 * — poll GET /evaluation/walk-forward/status to track progress.
 *
 * This is the admin counterpart to POST /evaluation/walk-forward/run (entitlement-gated).
 * It always passes evaluationOnly=false so the calibration and specialist models are refitted;
 * it will never silently skip calibration the way a body-less POST to the user-facing endpoint
 * would. Use POST /evaluation/calibration-refit for the cooldown-guarded admin calibration path.
 */
router.post("/evaluation/walk-forward/full-refit", requireAdmin, async (_req, res): Promise<void> => {
  // Task #198: training runs must always go through admin approval — same behaviour as /run.
  const result = startWalkForwardJob({ evaluationOnly: false, requireApproval: true });
  res.json(result);
});

/**
 * Admin-only trigger for an evaluation-only walk-forward: scores all currently unscored
 * historical matches and writes them into evaluation_predictions WITHOUT touching the
 * calibration_models or specialist_models tables.
 *
 * Use this to grow the evaluation corpus (backtest sample weight) safely at any time.
 * Unlike POST /evaluation/calibration-refit (evaluationOnly=false), this never refits or
 * replaces the active calibration model, so it is safe to run while task #78 is open.
 *
 * Poll GET /evaluation/walk-forward/status to track progress.
 */
router.post("/evaluation/walk-forward/score-unscored", requireAdmin, async (_req, res): Promise<void> => {
  const result = startWalkForwardJob({ evaluationOnly: true });
  res.json(result);
});


router.get("/evaluation/calibration-refit/job-runs", async (req, res): Promise<void> => {
  const parsed = ListCalibrationRefitJobRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, CALIBRATION_REFIT_JOB_NAME))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(parsed.data.limit);

  res.json(ListCalibrationRefitJobRunsResponse.parse(rows));
});

router.get("/evaluation/calibration-refit/health", async (_req, res): Promise<void> => {
  const STALE_THRESHOLD_HOURS = 30;
  const now = Date.now();

  const [latestRun, activeCalibration] = await Promise.all([
    db
      .select({
        id: jobRunsTable.id,
        status: jobRunsTable.status,
        startedAt: jobRunsTable.startedAt,
        finishedAt: jobRunsTable.finishedAt,
        attempts: jobRunsTable.attempts,
        summary: jobRunsTable.summary,
        errorMessage: jobRunsTable.errorMessage,
      })
      .from(jobRunsTable)
      .where(eq(jobRunsTable.jobName, CALIBRATION_REFIT_JOB_NAME))
      .orderBy(desc(jobRunsTable.startedAt))
      .limit(1),
    db
      .select({
        id: calibrationModelsTable.id,
        method: calibrationModelsTable.method,
        holdoutSampleSize: calibrationModelsTable.holdoutSampleSize,
        fittedAt: calibrationModelsTable.fittedAt,
      })
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1),
  ]);

  const run = latestRun[0] ?? null;
  const model = activeCalibration[0] ?? null;
  const summary = (run?.summary ?? null) as
    | { skippedNoEligibleMatches?: boolean; foldsRun?: number; evaluationOnly?: boolean }
    | null;

  const ageHours = run?.finishedAt ? (now - run.finishedAt.getTime()) / (60 * 60 * 1000) : null;
  const stale = ageHours === null || ageHours > STALE_THRESHOLD_HOURS;
  const skipped = summary?.skippedNoEligibleMatches === true || (summary?.foldsRun ?? 0) === 0;
  const noop = summary?.evaluationOnly === true;
  const failed = run?.status === "failed";
  const degenerateActiveModel = !!model && (model.holdoutSampleSize ?? 0) === 0;

  const issues: string[] = [];
  if (!run) issues.push("no_recent_refit_job");
  if (stale) issues.push("stale_refit_cadence");
  if (failed) issues.push("last_refit_failed");
  if (skipped) issues.push("last_refit_skipped_or_zero_folds");
  if (noop) issues.push("last_refit_noop_evaluation_only");
  if (degenerateActiveModel) issues.push("degenerate_active_calibration_model");

  const status = degenerateActiveModel || failed ? "fail" : issues.length > 0 ? "warning" : "pass";

  const recommendedAction =
    status === "pass"
      ? "none"
      : degenerateActiveModel
        ? "Run calibration refit and keep degenerate activation guard enabled; do not accept holdoutSampleSize=0 as active."
        : noop
          ? "Ensure calibration-refit trigger runs with evaluationOnly:false explicitly."
          : skipped
            ? "Investigate walk-forward eligibility/data freshness; latest refit skipped or scored zero folds."
            : stale
              ? "Verify Scheduled Deployment cadence and ensure calibration refit runs at least daily."
              : failed
                ? "Inspect last failure in job-runs and rerun calibration refit."
                : "Check calibration refit scheduler and recent run history.";

  res.json({
    status,
    checkedAt: new Date(now).toISOString(),
    staleThresholdHours: STALE_THRESHOLD_HOURS,
    issues,
    recommendedAction,
    latestRun: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
          attempts: run.attempts,
          summary,
          errorMessage: run.errorMessage,
        }
      : null,
    activeCalibration: model
      ? {
          id: model.id,
          method: model.method,
          holdoutSampleSize: model.holdoutSampleSize,
          fittedAt: model.fittedAt.toISOString(),
          degenerate: degenerateActiveModel,
        }
      : null,
  });
});

router.post("/evaluation/historical-backfill/run-cycle", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const provider = getTennisDataProvider();
  const result = await runIncrementalHistoricalBackfill(provider);
  res.json(RunHistoricalBackfillCycleResponse.parse(result));
});

/**
 * Sackmann CSV backfill (Task #107 Phase 1) — downloads Jeff Sackmann's tennis_atp / tennis_wta
 * GitHub CSVs and inserts match history into historical_matches via the same infrastructure as
 * the live-provider backfill. Runs in the background; outcome written to job_runs.
 *
 * POST /evaluation/sackmann-backfill/run
 * Body (all optional): { startYear?: number, endYear?: number, tours?: ("atp"|"wta")[], includeChallengerItf?: boolean }
 *
 * includeChallengerItf defaults to true — fetches atp_matches_qual_chall_YYYY.csv and
 * wta_matches_qual_itf_YYYY.csv in addition to the main-draw files. These files add Challenger
 * and ITF match history for lower-ranked players who rarely appear in the main-draw file.
 */
// requireAdmin: this is a data-pipeline operation, not a subscriber feature; the entitlement
// check is inappropriate here (it requires an active user session/subscription) and would block
// owner-triggered runs. Other job-trigger routes (calibration-refit, walk-forward) already use
// requireAdmin for the same reason.
router.post("/evaluation/sackmann-backfill/run", requireAdmin, async (req, res): Promise<void> => {

  const startYear          = typeof req.body?.startYear          === "number"  ? req.body.startYear          : 2010;
  const endYear            = typeof req.body?.endYear            === "number"  ? req.body.endYear            : new Date().getFullYear();
  const tours              = Array.isArray(req.body?.tours)                    ? req.body.tours               : ["atp", "wta"];
  const includeChallengerItf = typeof req.body?.includeChallengerItf === "boolean" ? req.body.includeChallengerItf : true;

  // Respond immediately — the backfill is long-running.
  res.json({ started: true, startYear, endYear, tours, includeChallengerItf, jobName: `${SACKMANN_PROVIDER}-backfill` });

  const startedAt = new Date();
  runSackmannBackfill({ startYear, endYear, tours, includeChallengerItf })
    .then(async (result) => {
      await db.insert(jobRunsTable).values({
        jobName: `${SACKMANN_PROVIDER}-backfill`,
        startedAt,
        finishedAt: new Date(),
        status: "success",
        attempts: 1,
        summary: {
          fixturesLoaded: result.fixturesLoaded,
          atpYearsLoaded: result.atpYearsLoaded,
          wtaYearsLoaded: result.wtaYearsLoaded,
          atpChallengerYearsLoaded: result.atpChallengerYearsLoaded,
          wtaItfYearsLoaded: result.wtaItfYearsLoaded,
          includeChallengerItf,
          matchesInserted: result.backfill.matchesInserted,
          featureRowsInserted: result.backfill.featureRowsInserted,
          matchesSkippedDuplicate: result.backfill.matchesSkippedDuplicate,
        },
        errorMessage: null,
      });
      logger.info({ result }, "sackmann-backfill: completed");
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "sackmann-backfill: failed");
      await db.insert(jobRunsTable).values({
        jobName: `${SACKMANN_PROVIDER}-backfill`,
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        attempts: 1,
        summary: null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/sackmann-backfill/status
 * Returns the most recent sackmann-backfill job_runs row so the admin UI can show
 * whether a backfill has run, when it finished, and how many matches were imported.
 */
router.get("/evaluation/sackmann-backfill/status", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const [latest] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, `${SACKMANN_PROVIDER}-backfill`))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json({
    hasRun: !!latest,
    lastRun: latest
      ? {
          status: latest.status,
          startedAt: latest.startedAt?.toISOString() ?? null,
          finishedAt: latest.finishedAt?.toISOString() ?? null,
          summary: latest.summary ?? null,
          errorMessage: latest.errorMessage ?? null,
        }
      : null,
  });
});

/**
 * POST /evaluation/sackmann-local-backfill/run
 *
 * Imports match CSVs from the locally-extracted Sackmann ZIP
 * (attached_assets/sackmann_local/ by default).
 *
 * Body (all optional):
 *   localDir?   string   – default: "attached_assets/sackmann_local"
 *   fileTypes?  string[] – default: all. Options: "atp","wta","challenger","quali","amateur","ongoing"
 *   yearFrom?   number   – default: 1967
 *   yearTo?     number   – default: current year
 *   dryRun?     boolean  – default: false. If true, count rows without writing.
 *
 * dryRun=true → synchronous response with counts (fast — no DB writes).
 * dryRun=false → fire-and-forget; final counts stored in job_runs (retrieve via status endpoint).
 */
router.post("/evaluation/sackmann-local-backfill/run", requireAdmin, async (req, res): Promise<void> => {
  const localDir   = typeof req.body?.localDir   === "string"  ? req.body.localDir   : undefined;
  const fileTypes  = Array.isArray(req.body?.fileTypes)        ? req.body.fileTypes  : undefined;
  const yearFrom   = typeof req.body?.yearFrom   === "number"  ? req.body.yearFrom   : undefined;
  const yearTo     = typeof req.body?.yearTo     === "number"  ? req.body.yearTo     : undefined;
  const dryRun     = typeof req.body?.dryRun     === "boolean" ? req.body.dryRun     : false;

  const opts = { localDir, fileTypes, yearFrom, yearTo, dryRun };

  // dryRun is fast (no DB writes) — respond synchronously so callers see row counts immediately.
  if (dryRun) {
    try {
      const result = await runSackmannLocalBackfill(opts);
      res.json(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "sackmann-local-backfill: dry-run failed");
      res.status(500).json({ error: errorMessage });
    }
    return;
  }

  // Non-dryRun: fire-and-forget (full import can take 30+ minutes).
  // Final counts are stored in job_runs and retrievable via the status endpoint.
  const jobName   = "sackmann-local-backfill";
  const startedAt = new Date();
  res.json({ started: true, opts, jobName, message: "Import started. Check /evaluation/sackmann-local-backfill/status for final counts." });

  runSackmannLocalBackfill(opts)
    .then(async (result) => {
      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "success",
        attempts: 1,
        summary: result as unknown as Record<string, unknown>,
        errorMessage: null,
      });
      logger.info({ result }, "sackmann-local-backfill: completed");
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "sackmann-local-backfill: failed");
      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        attempts: 1,
        summary: null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/sackmann-local-backfill/status
 * Returns the most recent sackmann-local-backfill job_runs row.
 */
router.get("/evaluation/sackmann-local-backfill/status", requireAdmin, async (_req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, "sackmann-local-backfill"))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json({
    hasRun: !!latest,
    lastRun: latest
      ? {
          status:       latest.status,
          startedAt:    latest.startedAt?.toISOString()  ?? null,
          finishedAt:   latest.finishedAt?.toISOString() ?? null,
          summary:      latest.summary       ?? null,
          errorMessage: latest.errorMessage  ?? null,
        }
      : null,
  });
});

/**
 * GET /evaluation/matches/search
 *
 * Query historical matches with optional filters.
 *
 * Query params (all optional):
 *   player        string  – ILIKE search in player1_name OR player2_name
 *   surface       string  – exact match (Hard/Clay/Grass/IndoorHard)
 *   tournamentLevel string – exact match (GrandSlam/Masters1000/ATP500/ATP250/Challenger/ITF/WTA1000/WTA500)
 *   round         string  – exact match (R128/R64/R32/R16/QF/SF/F/RR/Q1/Q2/Q3)
 *   tour          string  – exact match (ATP/WTA)
 *   yearFrom      number  – min year of scheduled_start_at
 *   yearTo        number  – max year of scheduled_start_at
 *   provider      string  – exact match (sackmann/api-tennis/ext-csv/…)
 *   limit         number  – default 50, max 200
 *   offset        number  – default 0
 */
router.get("/evaluation/matches/search", requireAdmin, async (req, res): Promise<void> => {
  const player          = typeof req.query.player          === "string" ? req.query.player.trim()          : null;
  const surface         = typeof req.query.surface         === "string" ? req.query.surface.trim()         : null;
  const tournamentLevel = typeof req.query.tournamentLevel === "string" ? req.query.tournamentLevel.trim() : null;
  const round           = typeof req.query.round           === "string" ? req.query.round.trim()           : null;
  const tour            = typeof req.query.tour            === "string" ? req.query.tour.trim()            : null;
  const providerFilter  = typeof req.query.provider        === "string" ? req.query.provider.trim()        : null;
  const yearFrom        = typeof req.query.yearFrom        === "string" ? parseInt(req.query.yearFrom, 10)  : null;
  const yearTo          = typeof req.query.yearTo          === "string" ? parseInt(req.query.yearTo, 10)    : null;
  const limit           = Math.min(typeof req.query.limit  === "string" ? parseInt(req.query.limit, 10) || 50 : 50, 200);
  const offset          = typeof req.query.offset          === "string" ? parseInt(req.query.offset, 10) || 0 : 0;

  const conditions = [];

  if (player) {
    const pat = `%${player}%`;
    conditions.push(
      sql`(${historicalMatchesTable.player1Name} ILIKE ${pat} OR ${historicalMatchesTable.player2Name} ILIKE ${pat})`,
    );
  }
  if (surface)         conditions.push(eq(historicalMatchesTable.surface,         surface));
  if (tournamentLevel) conditions.push(eq(historicalMatchesTable.tournamentLevel, tournamentLevel));
  if (round)           conditions.push(eq(historicalMatchesTable.round,           round));
  if (tour)            conditions.push(eq(historicalMatchesTable.tour,            tour));
  if (providerFilter)  conditions.push(eq(historicalMatchesTable.provider,        providerFilter));
  if (yearFrom && !Number.isNaN(yearFrom)) {
    conditions.push(sql`EXTRACT(YEAR FROM ${historicalMatchesTable.scheduledStartAt}) >= ${yearFrom}`);
  }
  if (yearTo && !Number.isNaN(yearTo)) {
    conditions.push(sql`EXTRACT(YEAR FROM ${historicalMatchesTable.scheduledStartAt}) <= ${yearTo}`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id:              historicalMatchesTable.id,
      externalId:      historicalMatchesTable.externalId,
      provider:        historicalMatchesTable.provider,
      tour:            historicalMatchesTable.tour,
      player1Name:     historicalMatchesTable.player1Name,
      player2Name:     historicalMatchesTable.player2Name,
      winnerId:        historicalMatchesTable.winnerId,
      score:           historicalMatchesTable.score,
      surface:         historicalMatchesTable.surface,
      tournamentName:  historicalMatchesTable.tournamentName,
      tournamentLevel: historicalMatchesTable.tournamentLevel,
      round:           historicalMatchesTable.round,
      matchDate:       historicalMatchesTable.scheduledStartAt,
      player1Rank:     historicalMatchesTable.player1Rank,
      player2Rank:     historicalMatchesTable.player2Rank,
    })
    .from(historicalMatchesTable)
    .where(whereClause)
    .orderBy(desc(historicalMatchesTable.scheduledStartAt))
    .limit(limit)
    .offset(offset);

  res.json({ matches: rows, count: rows.length, limit, offset });
});

/**
 * POST /evaluation/external-csv-backfill/run
 * Imports uploaded CSV files from attached_assets/ (or any workspace-relative paths) into
 * historical_matches. Same Elo / feature-snapshot / idempotency guarantees as the Sackmann path.
 *
 * Body: { files: string[] }  — workspace-relative paths, e.g.
 *   ["attached_assets/2024-atp-season_xxx.csv", "attached_assets/2024-wta-season_xxx.csv"]
 *
 * Player ID resolution: surnames are matched against existing historical_matches rows so that
 * known Sackmann / API-Tennis player IDs are reused — keeping Elo chains intact across years.
 * New players fall back to "ext-{csvId}" (stable within and across files from this source).
 */
router.post("/evaluation/external-csv-backfill/run", requireAdmin, async (req, res): Promise<void> => {
  const requestedFiles: string[] = Array.isArray(req.body?.files) ? req.body.files : [];
  if (requestedFiles.length === 0) {
    res.status(400).json({ error: "Provide at least one file path in the 'files' array" });
    return;
  }

  // process.cwd() in the API server is artifacts/api-server — go up two levels to workspace root
  const workspaceRoot = resolvePath(process.cwd(), "../..");
  const absFiles      = requestedFiles.map((f: string) => joinPath(workspaceRoot, f));
  const jobName    = `${EXT_CSV_PROVIDER}-backfill`;

  res.json({ started: true, files: requestedFiles, jobName });

  const startedAt = new Date();
  runExternalCsvBackfill({ files: absFiles })
    .then(async (result) => {
      const bridgeRefresh = await orchestrateBridgeRefresh({
        affectedMatchIds: result.bridge.affectedMatchIds,
        resolved: result.bridge.resolved,
        db: db as unknown as BridgeDbLike,
        isJobRunning: () =>
          getWalkForwardJobStatus().state === "running" ||
          getBridgeRescoreJobStatus().state === "running",
        clearPredictions: (dbLike, ids) => clearAffectedEvalPredictions(dbLike, ids),
        startJob: (ids) => startBridgeRescoreJob(ids),
      });

      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "success",
        attempts: 1,
        summary: {
          filesLoaded:             result.filesLoaded,
          fixturesParsed:          result.fixturesParsed,
          playersMatched:          result.playersMatched,
          playersUnmatched:        result.playersUnmatched,
          matchesInserted:         result.backfill.matchesInserted,
          featureRowsInserted:     result.backfill.featureRowsInserted,
          matchesSkippedDuplicate: result.backfill.matchesSkippedDuplicate,
          bridge: {
            extPlayerSlotsFound: result.bridge.extPlayerSlotsFound,
            resolved:            result.bridge.resolved,
            unresolved:          result.bridge.unresolved,
            matchRowsUpdated:    result.bridge.matchRowsUpdated,
            featureRowsUpdated:  result.bridge.featureRowsUpdated,
            atpMatchRate:        result.bridge.atpMatchRate,
            wtaMatchRate:        result.bridge.wtaMatchRate,
            affectedEvalRowsCleared: bridgeRefresh.affectedEvalRowsCleared,
            walkForwardStarted:      bridgeRefresh.walkForwardStarted,
            walkForwardSkipReason:   bridgeRefresh.walkForwardSkipReason ?? null,
          },
        },
        errorMessage: null,
      });
      logger.info({ result }, "ext-csv-backfill: completed");
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "ext-csv-backfill: failed");
      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        attempts: 1,
        summary: null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/external-csv-backfill/status
 * Most recent job_runs row for the external CSV backfill.
 */
router.get("/evaluation/external-csv-backfill/status", requireAdmin, async (_req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, `${EXT_CSV_PROVIDER}-backfill`))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json({
    hasRun: !!latest,
    lastRun: latest
      ? {
          status:       latest.status,
          startedAt:    latest.startedAt?.toISOString()  ?? null,
          finishedAt:   latest.finishedAt?.toISOString() ?? null,
          summary:      latest.summary      ?? null,
          errorMessage: latest.errorMessage ?? null,
        }
      : null,
  });
});

/**
 * POST /evaluation/external-csv-backfill/bridge
 *
 * Post-import bridge: re-resolves ext-{id} player IDs in historical_matches to existing
 * Sackmann / API-Tennis IDs using surname + first-initial disambiguation.
 *
 * Safe to run repeatedly — idempotent once all ext-{id}s have been replaced.
 * Runs in the background; result is logged and stored in job_runs under "ext-csv-bridge".
 *
 * Typical use-case: run AFTER the initial CSV backfill to raise the player-ID match rate
 * from ~11% (surname-only) to ≥70% ATP / ≥50% WTA, so Elo chains continue across years.
 */
router.post("/evaluation/external-csv-backfill/bridge", requireAdmin, async (_req, res): Promise<void> => {
  const jobName   = "ext-csv-bridge";
  const startedAt = new Date();
  res.json({ started: true, jobName });

  runExternalCsvBridge()
    .then(async (result) => {
      // ── Bridge-specific full refresh ───────────────────────────────────────
      // Delegate to orchestrateBridgeRefresh which handles:
      //   • Skipping entirely when no matches were resolved.
      //   • NOT deleting rows when a job is already running (would orphan rows
      //     that the in-flight run already excluded from its eligible set).
      //   • Awaiting clearAffectedEvalPredictions before scheduling the job
      //     (ensures the rescore job's DB queries see the post-deletion state).
      //   • Using startBridgeRescoreJob (not walk-forward) so the rescore
      //     loads the FULL historical context for Elo/h2h/form and scores
      //     only the affected matches — with no fold minimums or warmup floors.
      const refresh = await orchestrateBridgeRefresh({
        affectedMatchIds: result.affectedMatchIds,
        resolved: result.resolved,
        db: db as unknown as BridgeDbLike,
        isJobRunning: () =>
          getWalkForwardJobStatus().state === "running" ||
          getBridgeRescoreJobStatus().state === "running",
        clearPredictions: (dbLike, ids) => clearAffectedEvalPredictions(dbLike, ids),
        startJob: (ids) => startBridgeRescoreJob(ids),
      });

      const { affectedEvalRowsCleared, walkForwardStarted, walkForwardSkipReason } = refresh;

      if (walkForwardStarted) {
        logger.info(
          { affectedMatchCount: result.affectedMatchIds.length, affectedEvalRowsCleared },
          "ext-csv-bridge: cleared stale eval rows + triggered targeted walk-forward re-score",
        );
      } else if (walkForwardSkipReason === "walk_forward_already_running") {
        logger.warn(
          { affectedMatchCount: result.affectedMatchIds.length },
          "ext-csv-bridge: walk-forward already running — full refresh deferred to avoid orphaned eval rows",
        );
      } else if (walkForwardSkipReason === "clear_failed") {
        logger.error(
          { affectedMatchCount: result.affectedMatchIds.length },
          "ext-csv-bridge: failed to clear stale eval predictions — walk-forward skipped",
        );
      } else if (walkForwardSkipReason === "no_resolved_matches") {
        logger.info({ resolved: result.resolved },
          "ext-csv-bridge: no new resolutions — skipping eval-prediction clear and walk-forward");
      } else if (walkForwardSkipReason) {
        logger.warn({ reason: walkForwardSkipReason },
          "ext-csv-bridge: walk-forward started concurrently — cleared rows will be re-scored by that run");
      }

      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "success",
        attempts: 1,
        summary: {
          extPlayerSlotsFound:     result.extPlayerSlotsFound,
          resolved:                result.resolved,
          unresolved:              result.unresolved,
          matchRowsUpdated:        result.matchRowsUpdated,
          featureRowsUpdated:      result.featureRowsUpdated,
          atpMatchRate:            result.atpMatchRate,
          wtaMatchRate:            result.wtaMatchRate,
          affectedEvalRowsCleared,
          walkForwardStarted,
          walkForwardSkipReason:   walkForwardSkipReason ?? null,
        },
        errorMessage: null,
      });
      logger.info({ result }, "ext-csv-bridge: completed");
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "ext-csv-bridge: failed");
      await db.insert(jobRunsTable).values({
        jobName,
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        attempts: 1,
        summary: null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/external-csv-backfill/bridge/status
 * Most recent job_runs row for the ext-csv bridge.
 */
router.get("/evaluation/external-csv-backfill/bridge/status", requireAdmin, async (_req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, "ext-csv-bridge"))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json({
    hasRun: !!latest,
    lastRun: latest
      ? {
          status:       latest.status,
          startedAt:    latest.startedAt?.toISOString()  ?? null,
          finishedAt:   latest.finishedAt?.toISOString() ?? null,
          summary:      latest.summary      ?? null,
          errorMessage: latest.errorMessage ?? null,
        }
      : null,
  });
});

/**
 * tennis-data.co.uk XLSX backfill (Phase 5 item 2) — downloads ATP + WTA XLSX files and
 * inserts match records with embedded market odds into historical_matches.
 * No API key required. Runs in the background; outcome written to job_runs.
 *
 * POST /evaluation/tennis-data-co-uk-backfill/run
 * Body (all optional): { startYear?: number, endYear?: number, tours?: ("atp"|"wta")[] }
 * Defaults: startYear=2015, endYear=<current year>, tours=["atp","wta"]
 *
 * Market odds (B365, Pinnacle, market avg/max) are stored in raw_source JSONB under _marketOdds.
 * Query: WHERE provider='tennis-data-co-uk' AND (raw_source->'_marketOdds'->>'avgWinner')::float IS NOT NULL
 */
router.post("/evaluation/tennis-data-co-uk-backfill/run", requireAdmin, async (req, res): Promise<void> => {
  const startYear = typeof req.body?.startYear === "number" ? req.body.startYear : 2015;
  const endYear   = typeof req.body?.endYear   === "number" ? req.body.endYear   : new Date().getFullYear();
  const tours     = Array.isArray(req.body?.tours)          ? req.body.tours      : ["atp", "wta"];

  res.json({ started: true, startYear, endYear, tours, jobName: `${TENNIS_DATA_CO_UK_PROVIDER}-backfill` });

  const startedAt = new Date();
  runTennisDataCoUkBackfill({ startYear, endYear, tours })
    .then(async (result) => {
      await db.insert(jobRunsTable).values({
        jobName:    `${TENNIS_DATA_CO_UK_PROVIDER}-backfill`,
        startedAt,
        finishedAt: new Date(),
        status:     "success",
        attempts:   1,
        summary: {
          fixturesLoaded:   result.fixturesLoaded,
          fixturesWithOdds: result.fixturesWithOdds,
          atpYearsLoaded:   result.atpYearsLoaded,
          wtaYearsLoaded:   result.wtaYearsLoaded,
          matchesInserted:          result.backfill.matchesInserted,
          featureRowsInserted:      result.backfill.featureRowsInserted,
          matchesSkippedDuplicate:  result.backfill.matchesSkippedDuplicate,
        },
        errorMessage: null,
      });
      logger.info({ result }, "tennis-data-co-uk-backfill: completed");
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "tennis-data-co-uk-backfill: failed");
      await db.insert(jobRunsTable).values({
        jobName:    `${TENNIS_DATA_CO_UK_PROVIDER}-backfill`,
        startedAt,
        finishedAt: new Date(),
        status:     "failed",
        attempts:   1,
        summary:    null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/tennis-data-co-uk-backfill/status
 * Returns the most recent job_runs row for the tennis-data.co.uk backfill.
 */
router.get("/evaluation/tennis-data-co-uk-backfill/status", requireAdmin, async (_req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, `${TENNIS_DATA_CO_UK_PROVIDER}-backfill`))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  res.json({
    hasRun: !!latest,
    lastRun: latest
      ? {
          status:       latest.status,
          startedAt:    latest.startedAt?.toISOString()  ?? null,
          finishedAt:   latest.finishedAt?.toISOString() ?? null,
          summary:      latest.summary      ?? null,
          errorMessage: latest.errorMessage ?? null,
        }
      : null,
  });
});

/**
 * Targeted range backfill -- fires `runHistoricalBackfill` for an explicit [dateStart, dateStop]
 * window in the background and returns immediately. Designed for closing known coverage gaps
 * (e.g. 2020–2025) where the window is too long for a synchronous HTTP response. The outcome
 * (summary or error) is written to job_runs so it's inspectable via
 * GET /evaluation/historical-backfill/job-runs when it completes.
 */
router.post("/evaluation/historical-backfill/run-range", async (req, res): Promise<void> => {
  const parsed = RunHistoricalBackfillRangeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { dateStart, dateStop, chunkDays } = parsed.data;

  // Respond immediately -- the backfill runs fully in the background.
  res.json(RunHistoricalBackfillRangeResponse.parse({ started: true, dateStart, dateStop }));

  // Fire-and-forget: mirrors the pattern in index.ts where the historical backfill job runs on
  // an in-process interval. Any error is recorded to job_runs so it's not silently swallowed.
  // Task #64: the live-progress endpoint detects "running" via `triggeredAt` from the client —
  // no in-progress row needed (finishedAt column is NOT NULL in the schema).
  const provider = getTennisDataProvider();
  const startedAt = new Date();
  runHistoricalBackfill(provider, { dateStart, dateStop, ...(chunkDays ? { chunkDays } : {}) })
    .then(async (summary) => {
      await db.insert(jobRunsTable).values({
        jobName: HISTORICAL_BACKFILL_JOB_NAME,
        startedAt,
        finishedAt: new Date(),
        status: "success",
        attempts: 1,
        summary: { skipped: false, summary },
        errorMessage: null,
      });
    })
    .catch(async (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, dateStart, dateStop }, "Targeted historical-backfill run-range failed");
      await db.insert(jobRunsTable).values({
        jobName: HISTORICAL_BACKFILL_JOB_NAME,
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        attempts: 1,
        summary: null,
        errorMessage,
      });
    });
});

/**
 * GET /evaluation/historical-backfill/live-progress?triggeredAt=<ISO>
 *
 * Task #64: after the frontend triggers a run-range backfill it polls this every 5 s, passing
 * the ISO timestamp of when it fired the trigger. We look for a job_runs completion row with
 * finishedAt > triggeredAt. If none exists yet → still running. If one does → done.
 * The `triggeredAt` param is required; without it the endpoint returns the most-recent row only.
 */
router.get("/evaluation/historical-backfill/live-progress", async (req, res): Promise<void> => {
  const triggeredAtRaw = typeof req.query["triggeredAt"] === "string" ? req.query["triggeredAt"] : null;
  const triggeredAt = triggeredAtRaw ? new Date(triggeredAtRaw) : null;

  const [lastCompleted] = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, HISTORICAL_BACKFILL_JOB_NAME))
    .orderBy(desc(jobRunsTable.finishedAt))
    .limit(1);

  // isRunning = triggered after known last completion, so no completion exists for this trigger yet
  const lastCompletedAt = lastCompleted?.finishedAt ?? null;
  const isRunning = triggeredAt != null
    ? (lastCompletedAt == null || lastCompletedAt < triggeredAt)
    : false;

  res.json({
    isRunning,
    lastCompletedStatus: lastCompleted?.status ?? null,
    lastCompletedAt: lastCompletedAt?.toISOString() ?? null,
    activeJobId: null,
    activeStartedAt: null,
    activeDateRange: null,
  });
});

router.get("/evaluation/historical-backfill/job-runs", async (req, res): Promise<void> => {
  const parsed = ListHistoricalBackfillJobRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, HISTORICAL_BACKFILL_JOB_NAME))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(parsed.data.limit);

  res.json(ListHistoricalBackfillJobRunsResponse.parse(rows));
});

router.get("/evaluation/historical-backfill/freshness", async (_req, res): Promise<void> => {
  const asOf = new Date();

  // Run count queries and gap detection in parallel -- each is a simple indexed scan.
  const [latestCoveredDate, missingRankRow, missingSurfaceRow, rawGaps] = await Promise.all([
    getLatestCoveredMatchDate(),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(historicalMatchesTable)
      .where(
        and(
          isNotNull(historicalMatchesTable.winnerId),
          eq(historicalMatchesTable.cancelled, false),
          isNull(historicalMatchesTable.player1Rank),
          isNull(historicalMatchesTable.player2Rank),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(historicalMatchesTable)
      .where(and(isNotNull(historicalMatchesTable.winnerId), eq(historicalMatchesTable.cancelled, false), isNull(historicalMatchesTable.surface))),
    // Distinct-date gap detection: at most ~3,650 rows for a decade of data, manageable in memory.
    db
      .select({ matchDate: sql<string>`(scheduled_start_at AT TIME ZONE 'UTC')::date::text` })
      .from(historicalMatchesTable)
      .groupBy(sql`(scheduled_start_at AT TIME ZONE 'UTC')::date`)
      .orderBy(sql`(scheduled_start_at AT TIME ZONE 'UTC')::date`),
  ]);

  let daysBehind: number | null = null;
  if (latestCoveredDate) {
    const todayUtc = asOf.toISOString().slice(0, 10);
    const msPerDay = 24 * 60 * 60 * 1000;
    daysBehind = Math.round((Date.parse(`${todayUtc}T00:00:00.000Z`) - Date.parse(`${latestCoveredDate}T00:00:00.000Z`)) / msPerDay);
  }

  const dateGapsOver30Days: Array<{ fromDate: string; toDate: string; dayCount: number }> = [];
  for (let i = 1; i < rawGaps.length; i++) {
    const dayCount = Math.round(
      (Date.parse(`${rawGaps[i].matchDate}T00:00:00.000Z`) - Date.parse(`${rawGaps[i - 1].matchDate}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000),
    );
    if (dayCount > 30) dateGapsOver30Days.push({ fromDate: rawGaps[i - 1].matchDate, toDate: rawGaps[i].matchDate, dayCount });
  }

  res.json(
    GetHistoricalDataFreshnessResponse.parse({
      latestCoveredDate,
      daysBehind,
      asOf: asOf.toISOString(),
      matchesMissingOpponentRank: latestCoveredDate ? (missingRankRow[0]?.count ?? null) : null,
      matchesMissingSurface: latestCoveredDate ? (missingSurfaceRow[0]?.count ?? null) : null,
      dateGapsOver30Days,
    }),
  );
});

router.post("/evaluation/ranking-verification", async (_req, res): Promise<void> => {
  const provider = getTennisDataProvider();
  const result = await runRankingVerification(provider);
  res.json(result);
});

// ── Task #12: Continuous outcome-learning endpoints ───────────────────────────────────────────────

/**
 * Task #12: Run the optimizer — full training-mode walk-forward + candidate config generation.
 * Does NOT auto-promote any config. Writes a new candidate_configs row and runs threshold
 * evaluation. The production calibration/specialist weights ARE updated by this call
 * (training mode, unlike the evaluation-only walk-forward).
 */
/**
 * Stage A2: Fire optimizer in the background, respond immediately.
 * Poll GET /evaluation/optimizer/status for progress and result.
 */
router.post("/evaluation/optimizer/run", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  const parsed = RunOptimizerBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = startOptimizerJob(parsed.data);
  res.json(StartOptimizerResponse.parse(result));
});

router.get("/evaluation/optimizer/status", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;
  res.json(OptimizerJobStatusResponse.parse(getOptimizerJobStatus()));
});

router.get("/evaluation/optimizer/summary", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  const summary = await getOptimizerAccuracySummary();
  res.json(GetOptimizerAccuracySummaryResponse.parse(summary));
});

/**
 * Task #12: Get the most recent correct-vs-incorrect pattern analysis run.
 * Returns null when no pattern analysis has run yet (walk-forward must be run first).
 */
router.get("/evaluation/pattern-analysis/latest", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  const result = await getLatestPatternAnalysis();
  res.json(GetLatestPatternAnalysisResponse.parse(result));
});

/**
 * Task #12: Get the most recent threshold evaluation run.
 * Returns null when no threshold evaluation has run yet (optimizer must be run first).
 */
router.get("/evaluation/threshold-evaluation/latest", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  const result = await getLatestThresholdEvaluation();
  res.json(GetLatestThresholdEvaluationResponse.parse(result));
});

router.post("/evaluation/ablation/run", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  const parsed = RunAblationAnalysisBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = startAblationJob(parsed.data.sampleSize ?? undefined);
  res.json(RunAblationAnalysisResponse.parse(result));
});

router.get("/evaluation/ablation/status", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  res.json(GetAblationStatusResponse.parse(getAblationJobStatus()));
});

router.post("/evaluation/shadow-replay/run", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseShadowReplay, "shadowReplay"))) return;

  const parsed = RunShadowReplayBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const summary = await runShadowPaperTradingReplay(parsed.data);
    res.json(RunShadowReplayResponse.parse(summary));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Shadow replay failed" });
  }
});

router.get("/evaluation/shadow-replay/dashboard", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseShadowReplay, "shadowReplay"))) return;

  // Deliberately its own endpoint, never folded into GET /evaluation/dashboard: shadow-replay
  // evidence must never be mixed into the "genuinely unseen" segments/Elite-tier/upset-risk/
  // disagreement/market-edge aggregates that endpoint computes from historical_test/paper_trade
  // rows only (see shadowReplay.ts's top doc for why this evidence is simulated, not live).
  const shadowRows = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"));
  const batches = await listShadowReplayBatches();

  res.json(
    GetShadowReplayDashboardResponse.parse({
      overall: computeSegmentMetrics(shadowRows),
      calibrationBuckets: computeCalibrationBuckets(shadowRows),
      batches,
    }),
  );
});

export default router;
