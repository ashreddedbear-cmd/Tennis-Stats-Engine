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

// ── Task #44: Targeted historical-backfill range ──────────────────────────────────────────────────

/**
 * Request body for POST /evaluation/historical-backfill/run-range.
 * Fires runHistoricalBackfill for the explicit [dateStart, dateStop] window in the background
 * and returns immediately -- designed for closing known coverage gaps (e.g. 2020–2025) where
 * the window is too long for a synchronous HTTP response.
 */
export const RunHistoricalBackfillRangeBody = zod.object({
  dateStart: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First date to backfill, inclusive (YYYY-MM-DD)."),
  dateStop: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last date to backfill, inclusive (YYYY-MM-DD)."),
  chunkDays: zod
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Provider chunk window in days. Defaults to 5 (the safe limit for busy periods)."),
});

export const RunHistoricalBackfillRangeResponse = zod.object({
  started: zod.boolean(),
  dateStart: zod.string(),
  dateStop: zod.string(),
});

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

// ── Task #? Payments v2 ───────────────────────────────────────────────────────

export const PaymentEntitlements = zod.object({
  predictionHistory: zod.boolean(),
  walkForward: zod.boolean(),
  shadowReplay: zod.boolean(),
  optimizer: zod.boolean(),
  competitiveBalance: zod.boolean(),
  evidenceReliability: zod.boolean(),
  developerAnalytics: zod.boolean(),
  eliteRecommendations: zod.boolean(),
  alerts: zod.boolean(),
  teamWorkspace: zod.boolean(),
});

export const PaymentWebhookEventSummary = zod.object({
  id: zod.number(),
  stripeEventId: zod.string(),
  eventType: zod.string(),
  livemode: zod.boolean(),
  processingStatus: zod.string(),
  stripeCustomerId: zod.string().nullable(),
  stripeSubscriptionId: zod.string().nullable(),
  errorMessage: zod.string().nullable(),
  receivedAt: zod.coerce.date(),
  processedAt: zod.coerce.date().nullable(),
  createdAt: zod.coerce.date(),
});

export const PaymentsStatusAccount = zod.object({
  id: zod.number(),
  accountKey: zod.string(),
  displayName: zod.string(),
  stripeCustomerId: zod.string().nullable(),
  stripeSubscriptionId: zod.string().nullable(),
  stripePriceId: zod.string().nullable(),
  planKey: zod.string().nullable(),
  planName: zod.string().nullable(),
  subscriptionStatus: zod.string().nullable(),
  accessGrantedAt: zod.coerce.date().nullable(),
  currentPeriodStartAt: zod.coerce.date().nullable(),
  currentPeriodEndAt: zod.coerce.date().nullable(),
  trialEndAt: zod.coerce.date().nullable(),
  canceledAt: zod.coerce.date().nullable(),
  cancelAtPeriodEnd: zod.boolean(),
  entitlementSnapshot: zod.record(zod.boolean()),
  metadata: zod.record(zod.string(), zod.unknown()),
  lastWebhookEventId: zod.string().nullable(),
  lastCheckoutSessionId: zod.string().nullable(),
  createdAt: zod.coerce.date(),
  updatedAt: zod.coerce.date(),
});

export const GetPaymentsStatusResponse = zod.object({
  featureFlagEnabled: zod.boolean(),
  configured: zod.boolean(),
  active: zod.boolean(),
  account: PaymentsStatusAccount.nullable(),
  entitlements: PaymentEntitlements,
  stripe: zod.object({
    priceId: zod.string().nullable(),
    webhookSecretConfigured: zod.boolean(),
    secretKeyConfigured: zod.boolean(),
    planKey: zod.string(),
    planName: zod.string(),
  }),
  recentWebhookEvents: zod.array(PaymentWebhookEventSummary),
});

export const CreatePaymentsCheckoutSessionBody = zod.object({
  returnPath: zod.string().optional(),
  customerEmail: zod.string().email().optional(),
});

export const CreatePaymentsCheckoutSessionResponse = zod.object({
  sessionId: zod.string(),
  url: zod.string().nullable(),
});

export const CreateBillingPortalSessionBody = zod.object({
  returnPath: zod.string().optional(),
});

export const CreateBillingPortalSessionResponse = zod.object({
  url: zod.string(),
});

export const PaymentsWebhookResponse = zod.object({
  received: zod.boolean(),
  processed: zod.boolean(),
  duplicate: zod.boolean().optional(),
});

export const GetEvaluationPredictionStatsQueryParams = zod.object({
  runKind: zod.enum(["historical_test", "paper_trade", "live"]).optional(),
});

// ── Parlay Builder: Cross-Engine Agreement (Feature) ──────────────────────────

/**
 * Score breakdown for a single factor considered by the parlay builder
 * when validating whether a selectedPlayerId is well-supported by the evidence.
 */
export const FactorScore = zod.object({
  name: zod.string(),
  weight: zod.number(),
  score: zod.number(),
  reasoning: zod.string(),
});

/**
 * Diagnostics breakdown for data sources used in builder scoring.
 */
export const DataSourceDiagnostics = zod.object({
  headsToHeadsCount: zod.number(),
  recentFormSampleCount: zod.number(),
  surfaceEloReliability: zod.number(),
  fatigueDataAvailable: zod.boolean(),
  availabilityDataAvailable: zod.boolean(),
  styleMatchupReliability: zod.number(),
});

/**
 * BuilderResult: outcome of the parlay builder's validation of a proposed selectedPlayerId.
 * The builder is a VALIDATOR, not an independent predictor — it takes a selectedPlayerId
 * and rates how well that side is supported by various factors (head-to-head, recent form,
 * surface Elo, fatigue, availability, style matchup, etc.). It does NOT independently
 * declare a winner; instead, it evaluates whether the proposed selectedPlayerId is robust.
 *
 * For cross-engine agreement: take the prediction-engine's selectedPlayerId and pass it
 * into the builder. Then:
 *   - decision === "KEEP" or "BORDERLINE" → agreement = true
 *   - decision === "REMOVE" → agreement = false
 *   - decision === "DATA_UNAVAILABLE" → agreement = null (unknown, not false)
 */
export const BuilderResult = zod.object({
  /** 0-100 scale: how well the selectedPlayerId is supported by the evidence. */
  validationScore: zod.number().min(0).max(100),
  /** 0-100 scale: risk score for the selectedPlayerId (opposite direction from validationScore). */
  riskScore: zod.number().min(0).max(100),
  /** 0-100 scale: how close the matchup is (0=blowout, 100=coin flip). */
  matchupCloseness: zod.number().min(0).max(100),
  /** Reliability grade for the selectedPlayerId's support profile. */
  reliabilityGrade: zod.enum(["A", "B", "C", "D", "F"]),
  /** Overall parlay grade for including this match in a parlay. */
  parlayGrade: zod.enum(["Elite", "Strong", "Moderate", "Weak", "Reject"]),
  /** Probability (0-1) that the selectedPlayerId should be removed from a parlay. */
  removalProbability: zod.number().min(0).max(1),
  /**
   * Final decision on the selectedPlayerId's viability:
   * - KEEP: strong support, include in parlay
   * - BORDERLINE: acceptable support, include with caution
   * - REMOVE: weak support or evidence favors opponent, exclude from parlay
   * - DATA_UNAVAILABLE: insufficient data to decide
   */
  decision: zod.enum(["KEEP", "BORDERLINE", "REMOVE", "DATA_UNAVAILABLE"]),
  /** Reasons supporting the decision (human-readable explanations). */
  reasons: zod.array(zod.string()),
  /** Critical flags (e.g. "missing head-to-head", "extreme fatigue concern"). */
  criticalFlags: zod.array(zod.string()),
  /** Data coverage percentage: 0-100 scale indicating how complete the available data is. */
  dataCoverage: zod.number().min(0).max(100),
  /**
   * Agreement score: what fraction of evaluated factors support the selectedPlayerId
   * (0-1 scale). Higher = more factors agree on selectedPlayerId.
   */
  sourceAgreement: zod.number().min(0).max(1),
  /** Count of factors that support the selectedPlayerId. */
  sourcesAgreeing: zod.number().nonnegative(),
  /** Total count of factors evaluated. */
  sourcesTotal: zod.number().positive(),
  /** Per-factor scoring breakdown. */
  factorScores: zod.array(FactorScore),
  /** Diagnostic information about data sources used in the analysis. */
  dataSourceDiagnostics: DataSourceDiagnostics,
  /** Version identifier for the builder logic (for tracking changes over time). */
  builderVersion: zod.string(),
});
