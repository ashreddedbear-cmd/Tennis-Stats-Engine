/**
 * Hand-written Zod schemas that extend the auto-generated API contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generated/api.ts` is fully owned by Orval (`orval.config.ts` runs with `clean: true` and
 * overwrites every file in `generated/`). Any schema written directly into a `generated/` file
 * is silently wiped the next time `pnpm orval` is run. (Task #66)
 *
 * RULE: all hand-written Zod schemas live HERE, never in `generated/api.ts` or anywhere under
 * `generated/`. This file is re-exported from `src/index.ts` alongside the generated output, so
 * callers importing `@workspace/api-zod` see both without any path changes.
 *
 * HOW TO ADD NEW SCHEMAS
 * ----------------------
 * 1. Define them in this file.
 * 2. They are automatically available as `import { ... } from "@workspace/api-zod"`.
 * 3. If/when the OpenAPI spec is updated to cover the same contract, remove the schema from here
 *    and re-run `pnpm orval` — the generated file will take over.
 */

import * as zod from "zod";

// ── Task #12: Continuous outcome-learning system ──────────────────────────────────────────────────

/**
 * @summary Run the optimizer (training-mode walk-forward + candidate config generation)
 */
export const RunOptimizerBody = zod.object({
  foldCount: zod.number().min(1).max(20).optional(),
  warmupFraction: zod.number().min(0.05).max(0.95).optional(),
  notes: zod.string().optional(),
});

export const RunOptimizerResponse = zod.object({
  candidateConfigId: zod.number(),
  candidateConfigIds: zod.array(zod.number()).optional(),
  generatedCount: zod.number().optional(),
  duplicateRejectedCount: zod.number().optional(),
  nearDuplicateRejectedCount: zod.number().optional(),
  retestCount: zod.number().optional(),
  diversity: zod
    .object({
      requiredFamilies: zod.array(zod.string()),
      presentFamilies: zod.array(zod.string()),
      minimumFamilyCount: zod.number(),
      familyCoveragePassed: zod.boolean(),
      noveltyFloor: zod.number(),
      noveltyRate: zod.number(),
      noveltyPassed: zod.boolean(),
    })
    .optional(),
  thresholdEvaluationId: zod.number(),
  walkForward: zod.object({
    foldsRun: zod.number(),
    foldIds: zod.array(zod.number()),
    skippedNoEligibleMatches: zod.boolean(),
    fallbackRate: zod.number(),
    warnings: zod.array(zod.string()),
  }),
});

/**
 * One per-segment breakdown row from a pattern analysis run.
 */
export const PatternSegmentItem = zod.object({
  dimension: zod.string(),
  value: zod.string(),
  n: zod.number(),
  correct: zod.number(),
  accuracy: zod.number().nullable(),
  logLoss: zod.number().nullable(),
  brier: zod.number().nullable(),
  ece: zod.number().nullable(),
  ciLow: zod.number().nullable(),
  ciHigh: zod.number().nullable(),
  evidenceStrength: zod.enum(["Strong", "Moderate", "Weak", "Insufficient"]),
});

export const GetLatestPatternAnalysisResponse = zod
  .object({
    id: zod.number(),
    totalAnalyzed: zod.number(),
    segments: zod.array(PatternSegmentItem),
    runKindsIncluded: zod.array(zod.string()),
    createdAt: zod.string(),
  })
  .nullable();

/**
 * One threshold evaluation entry from a threshold evaluation run.
 */
export const ThresholdEvalEntryItem = zod.object({
  tierId: zod.string(),
  tierLabel: zod.string(),
  currentValue: zod.union([zod.number(), zod.string()]),
  candidateValue: zod.union([zod.number(), zod.string()]),
  isWidening: zod.boolean(),
  affectedN: zod.number(),
  currentAccuracy: zod.number().nullable(),
  candidateAccuracy: zod.number().nullable(),
  currentLogLoss: zod.number().nullable(),
  candidateLogLoss: zod.number().nullable(),
  accuracyDelta: zod.number().nullable(),
  logLossDelta: zod.number().nullable(),
  classification: zod.enum(["Deploy", "Continue shadow", "Needs more data", "Reject", "Investigate"]),
  note: zod.string(),
});

export const GetLatestThresholdEvaluationResponse = zod
  .object({
    id: zod.number(),
    totalGraded: zod.number(),
    thresholds: zod.array(ThresholdEvalEntryItem),
    createdAt: zod.string(),
  })
  .nullable();

// ── Task #38: Seed player_stats from historical match data ────────────────────────────────────────

/**
 * Response from POST /players/stats/seed.
 * `queued` is the number of distinct canonical player IDs dispatched to the background job.
 * Re-triggering while a previous seed is still running is safe (idempotent upserts).
 */
export const SeedPlayerStatsResponse = zod.object({
  queued: zod.number().describe("Distinct canonical player IDs dispatched to the background stats-seed job."),
  message: zod.string(),
});

// ── Stage A2: Async job wrappers for walk-forward and optimizer ───────────────────────────────────

/**
 * Response from POST /evaluation/walk-forward/run (now fires the job in the background).
 * Returns immediately so the browser never hits a proxy timeout.
 */
export const StartWalkForwardResponse = zod.object({
  started: zod.boolean(),
  reason: zod.string().optional(),
});

/**
 * Response from GET /evaluation/walk-forward/status.
 * Mirrors the ablation job pattern (startAblationJob / getAblationJobStatus).
 */
export const WalkForwardJobStatusResponse = zod.discriminatedUnion("state", [
  zod.object({ state: zod.literal("idle") }),
  zod.object({
    state: zod.literal("running"),
    startedAt: zod.string(),
    evaluationOnly: zod.boolean(),
    matchesScored: zod.number(),
  }),
  zod.object({
    state: zod.literal("done"),
    startedAt: zod.string(),
    finishedAt: zod.string(),
    evaluationOnly: zod.boolean(),
    result: zod.object({
      foldsRun: zod.number(),
      foldIds: zod.array(zod.number()),
      skippedNoEligibleMatches: zod.boolean(),
      fallbackRate: zod.number(),
      warnings: zod.array(zod.string()),
      evaluationOnly: zod.boolean(),
    }),
  }),
  zod.object({
    state: zod.literal("error"),
    startedAt: zod.string(),
    finishedAt: zod.string(),
    evaluationOnly: zod.boolean(),
    error: zod.string(),
  }),
]);

/** Response from POST /evaluation/optimizer/run (fires in background). */
export const StartOptimizerResponse = zod.object({
  started: zod.boolean(),
  reason: zod.string().optional(),
});

/** Response from GET /evaluation/optimizer/status. */
export const OptimizerJobStatusResponse = zod.discriminatedUnion("state", [
  zod.object({ state: zod.literal("idle") }),
  zod.object({
    state: zod.literal("running"),
    startedAt: zod.string(),
    phase: zod.string(),
  }),
  zod.object({
    state: zod.literal("done"),
    startedAt: zod.string(),
    finishedAt: zod.string(),
    result: zod.object({
      candidateConfigId: zod.number(),
      candidateConfigIds: zod.array(zod.number()),
      generatedCount: zod.number(),
      duplicateRejectedCount: zod.number(),
      nearDuplicateRejectedCount: zod.number(),
      retestCount: zod.number(),
      diversity: zod.object({
        requiredFamilies: zod.array(zod.string()),
        presentFamilies: zod.array(zod.string()),
        minimumFamilyCount: zod.number(),
        familyCoveragePassed: zod.boolean(),
        noveltyFloor: zod.number(),
        noveltyRate: zod.number(),
        noveltyPassed: zod.boolean(),
      }),
      thresholdEvaluationId: zod.number(),
      walkForward: zod.object({
        foldsRun: zod.number(),
        foldIds: zod.array(zod.number()),
        skippedNoEligibleMatches: zod.boolean(),
        fallbackRate: zod.number(),
        warnings: zod.array(zod.string()),
      }),
    }),
  }),
  zod.object({
    state: zod.literal("error"),
    startedAt: zod.string(),
    finishedAt: zod.string(),
    error: zod.string(),
  }),
]);

// ── Task #9 + Stage 3: optimizer/accuracy integrated summary ─────────────────────────────────────

const OptimizerStrategyPick = zod.object({
  id: zod.number().nullable(),
  name: zod.string().nullable(),
  status: zod.string().nullable(),
  accuracy: zod.number().nullable(),
  brier: zod.number().nullable(),
  logLoss: zod.number().nullable(),
  calibrationError: zod.number().nullable(),
  createdAt: zod.string().nullable(),
});

export const GetOptimizerAccuracySummaryResponse = zod.object({
  production: zod.object({
    strategyName: zod.string().nullable(),
    strategyVersion: zod.string().nullable(),
    dateImplemented: zod.string().nullable(),
    lastValidationDate: zod.string().nullable(),
    overallAccuracy: zod.number().nullable(),
    walkForwardAccuracy: zod.number().nullable(),
    shadowReplayAccuracy: zod.number().nullable(),
    paperTradingAccuracy: zod.number().nullable(),
    liveGradedAccuracy: zod.number().nullable(),
    brierScore: zod.number().nullable(),
    logLoss: zod.number().nullable(),
    ece: zod.number().nullable(),
    calibrationError: zod.number().nullable(),
    coverage: zod.number().nullable(),
    abstentionRate: zod.number().nullable(),
    totalPredictions: zod.number(),
    totalGradedPredictions: zod.number(),
  }),
  optimizer: zod.object({
    status: zod.enum(["idle", "running", "completed"]),
    lastRunAt: zod.string().nullable(),
    currentStage: zod.string().nullable(),
    strategiesGenerated: zod.number(),
    strategiesTested: zod.number(),
    uniqueStrategies: zod.number(),
    duplicateStrategiesRejected: zod.number(),
    strategiesAwaitingValidation: zod.number(),
    strategiesInShadowMode: zod.number(),
    challengers: zod.number(),
    archivedStrategies: zod.number(),
    failedStrategies: zod.number(),
    bestNewStrategy: OptimizerStrategyPick,
    bestHistoricalStrategy: OptimizerStrategyPick,
    largestAccuracyImprovement: zod.number().nullable(),
    largestBrierImprovement: zod.number().nullable(),
    largestLogLossImprovement: zod.number().nullable(),
    nextScheduledOptimizerRun: zod.string().nullable(),
  }),
  comparison: zod.object({
    production: OptimizerStrategyPick,
    challenger: OptimizerStrategyPick,
  }),
  bestByCategory: zod.object({
    currentProductionStrategy: OptimizerStrategyPick,
    currentChallengerStrategy: OptimizerStrategyPick,
    bestHistoricalStrategy: OptimizerStrategyPick,
    bestNewlyGeneratedStrategy: OptimizerStrategyPick,
    bestBySurface: OptimizerStrategyPick,
    bestByTourLevel: OptimizerStrategyPick,
    bestByCompetitiveBalanceTier: OptimizerStrategyPick,
    bestByEvidenceReliabilityTier: OptimizerStrategyPick,
    bestByRecommendationType: OptimizerStrategyPick,
    bestByCalibrationQuality: OptimizerStrategyPick,
    bestByRawWinnerAccuracy: OptimizerStrategyPick,
  }),
  validation600: zod.object({
    sampleTarget: zod.number(),
    sampleSize: zod.number(),
    sampleReady: zod.boolean(),
    status: zod.string(),
    timestamp: zod.string().nullable(),
    datasetRangeStart: zod.string().nullable(),
    datasetRangeEnd: zod.string().nullable(),
    baseline: zod.object({
      accuracy: zod.number().nullable(),
      logLoss: zod.number().nullable(),
      brier: zod.number().nullable(),
      ece: zod.number().nullable(),
      coverage: zod.number().nullable(),
      abstentionRate: zod.number().nullable(),
      gradedRows: zod.number(),
    }),
    candidate: zod.object({
      id: zod.number().nullable(),
      name: zod.string().nullable(),
      strategyVersion: zod.string().nullable(),
      status: zod.string().nullable(),
      accuracy: zod.number().nullable(),
      logLoss: zod.number().nullable(),
      brier: zod.number().nullable(),
      ece: zod.number().nullable(),
      coverage: zod.number().nullable(),
      abstentionRate: zod.number().nullable(),
    }),
    deltas: zod.object({
      accuracy: zod.number().nullable(),
      logLoss: zod.number().nullable(),
      brier: zod.number().nullable(),
      ece: zod.number().nullable(),
    }),
    tradesRejected: zod.number().nullable(),
    tradesRejectedEstimated: zod.boolean(),
    lossesAvoided: zod.number().nullable(),
    lossesAvoidedEstimated: zod.boolean(),
    promotionRecommendation: zod.enum(["Promote", "Hold"]),
    limitation: zod.string().nullable(),
  }),
  updatedAt: zod.string(),
});

// ── Task #64: live backfill status polling ────────────────────────────────────────────────────────

/**
 * Response from GET /evaluation/historical-backfill/live-progress.
 * Returns whether a range backfill is currently running (job_runs row with finishedAt IS NULL),
 * and summary of the most recently completed one, so the frontend can show live status.
 */
export const GetBackfillLiveProgressResponse = zod.object({
  /**
   * True when `triggeredAt` was passed and no completed job_runs row exists with
   * finishedAt > triggeredAt yet — i.e. the job is still in progress.
   */
  isRunning: zod.boolean(),
  activeJobId: zod.number().nullable(),
  activeStartedAt: zod.string().nullable(),
  activeDateRange: zod.object({ dateStart: zod.string(), dateStop: zod.string() }).nullable(),
  lastCompletedStatus: zod.string().nullable(),
  lastCompletedAt: zod.string().nullable(),
});

export const GetEvaluationPredictionStatsQueryParams = zod.object({
  runKind: zod.enum(["historical_test", "paper_trade", "live"]).optional(),
});
