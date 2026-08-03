import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db, evaluationPredictionsTable, evaluationRunsTable, calibrationModelsTable, jobRunsTable, historicalMatchesTable } from "@workspace/db";
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
import { runWalkForwardEvaluation } from "../services/evaluation/walkForward";
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
import { usedHistoricalMatchFallback } from "../services/predictionEngine/playerProfileWarnings";
import { runIncrementalHistoricalBackfill, runHistoricalBackfill, getLatestCoveredMatchDate } from "../services/historicalData/backfill";
import { getTennisDataProvider } from "../services/tennisData";
import { HISTORICAL_BACKFILL_JOB_NAME } from "../jobs/historicalBackfillJobName";
import {
  RunHistoricalBackfillCycleResponse,
  RunHistoricalBackfillRangeBody,
  RunHistoricalBackfillRangeResponse,
  ListHistoricalBackfillJobRunsQueryParams,
  ListHistoricalBackfillJobRunsResponse,
  GetHistoricalDataFreshnessResponse,
  GetRankingVerificationResponse,
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
} from "@workspace/api-zod";
import { runRankingVerification } from "../services/historicalData/rankingVerification";
import { startWalkForwardJob, getWalkForwardJobStatus } from "../services/evaluation/walkForwardJob";
import { startOptimizerJob, getOptimizerJobStatus } from "../services/evaluation/optimizerJob";
import { getLatestPatternAnalysis } from "../services/evaluation/patternAnalysis";
import { getLatestThresholdEvaluation } from "../services/evaluation/thresholdEvaluation";
import { getOptimizerAccuracySummary } from "../services/evaluation/optimizerSummary";
import { runCalibrationRefitJob } from "../jobs/runCalibrationRefitJob";
import { computeRecommendation, type Recommendation } from "../services/predictionEngine/recommendation";
import { enforceEntitlement } from "../lib/entitlements";
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
  return computeRecommendation(row.calibratedProbability, dataQuality, dataQualityLabel, row.upsetRiskTier as Parameters<typeof computeRecommendation>[3], row.modelAgreement as Parameters<typeof computeRecommendation>[4], tieBreakerApplied);
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

  const result = await startWalkForwardJob(parsed.data);
  res.json(StartWalkForwardResponse.parse(result));
});

router.post("/evaluation/calibration-refit/run", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseOptimizer, "optimizer"))) return;

  if (calibrationRefitInFlight) {
    res.json({ started: false, reason: "A calibration-refit run is already in progress." });
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
    res.json(WalkForwardJobStatusResponse.parse(status));
  } catch (err) {
    logger.warn({ err }, "Walk-forward status query failed, returning current in-memory state");
    res.json(WalkForwardJobStatusResponse.parse(getWalkForwardJobStatus()));
  }
});

router.get("/evaluation/predictions", async (req, res): Promise<void> => {
  const parsed = ListEvaluationPredictionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { runKind, segment, status, limit, offset } = parsed.data;

  const conditions = [];
  if (runKind) conditions.push(eq(evaluationPredictionsTable.runKind, runKind));
  if (segment) conditions.push(eq(evaluationPredictionsTable.segment, segment));
  if (status) conditions.push(eq(evaluationPredictionsTable.status, status));

  const rows = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(evaluationPredictionsTable.scheduledStartAt))
    .limit(limit)
    .offset(offset ?? 0);

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
          finishedAt: run.finishedAt.toISOString(),
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
  res.json(GetRankingVerificationResponse.parse(result));
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
