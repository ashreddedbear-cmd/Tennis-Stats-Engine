import { pgTable, serial, text, integer, real, boolean, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { historicalMatchesTable } from "./historicalMatches";

export interface CalibrationKnotJson {
  x: number;
  y: number;
}

/**
 * Phase 4: out-of-sample testing, paper trading, calibration.
 *
 * One row per walk-forward fold. Folds are expanding-window: fold N's train window is
 * everything before its validation window (including every earlier fold's validation+test
 * data), so later folds are trained on strictly more history than earlier ones -- but a fold's
 * own validation/test windows are always chronologically AFTER its train window, and test is
 * never read until after validation-only calibration has already been fit and frozen.
 */
export const evaluationRunsTable = pgTable("evaluation_runs", {
  id: serial("id").primaryKey(),

  foldIndex: integer("fold_index").notNull(),
  modelVersion: text("model_version").notNull(),

  trainStart: timestamp("train_start", { withTimezone: true }).notNull(),
  trainEnd: timestamp("train_end", { withTimezone: true }).notNull(),
  validationStart: timestamp("validation_start", { withTimezone: true }).notNull(),
  validationEnd: timestamp("validation_end", { withTimezone: true }).notNull(),
  testStart: timestamp("test_start", { withTimezone: true }).notNull(),
  testEnd: timestamp("test_end", { withTimezone: true }).notNull(),

  // Isotonic calibration knots fit ONLY on this fold's validation-segment predictions, e.g.
  // [{ x: 0.52, y: 0.5 }, { x: 0.71, y: 0.68 }, ...]. Applied to this fold's test-segment
  // predictions -- never refit or adjusted using test data.
  calibrationMapping: jsonb("calibration_mapping").$type<CalibrationKnotJson[]>().notNull(),

  // Per-segment metrics computed at fold-completion time and never recomputed retroactively --
  // { n, accuracy, logLoss, brier, dateRangeStart, dateRangeEnd, retiredCount, voidCount,
  //   insufficientDataCount, retiredAccuracy }.
  validationMetrics: jsonb("validation_metrics").notNull(),
  testMetrics: jsonb("test_metrics").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEvaluationRunSchema = createInsertSchema(evaluationRunsTable).omit({ id: true, createdAt: true });
export type InsertEvaluationRun = z.infer<typeof insertEvaluationRunSchema>;
export type EvaluationRunRow = typeof evaluationRunsTable.$inferSelect;

/**
 * Task #12: one row per pattern-analysis run. Generated automatically after every
 * walk-forward (both evaluation-only and optimizer/training modes). Stores per-segment
 * correct-vs-incorrect breakdowns so the AccuracyDashboard can surface the top diverging
 * patterns without re-querying the whole evaluation_predictions table on every request.
 */
export const patternAnalysisRunsTable = pgTable("pattern_analysis_runs", {
  id: serial("id").primaryKey(),

  /** Total evaluation_predictions rows included (graded, includedInAccuracy=true, non-shadow) */
  totalAnalyzed: integer("total_analyzed").notNull(),

  /** Array of per-segment breakdowns. Each element: { dimension, value, n, correct, accuracy,
   *  logLoss, brier, ece, ciLow, ciHigh, evidenceStrength } */
  segments: jsonb("segments").notNull(),

  /** Which runKind values were included in this analysis run */
  runKindsIncluded: jsonb("run_kinds_included").$type<string[]>().notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PatternAnalysisRunRow = typeof patternAnalysisRunsTable.$inferSelect;

/**
 * Task #12: one row per threshold-evaluation run. Generated automatically after every
 * optimizer run (training mode). Stores how each tier threshold performs at candidate values
 * relative to the current deployed value so the dashboard can show Deploy/Reject/Shadow
 * classifications without re-scoring everything on every request.
 */
export const thresholdEvaluationRunsTable = pgTable("threshold_evaluation_runs", {
  id: serial("id").primaryKey(),

  /** Total graded predictions available in the cohort used for this evaluation */
  totalGraded: integer("total_graded").notNull(),

  /** Array of threshold evaluation entries. Each element:
   *  { tierId, tierLabel, currentValue, candidateValue, affectedN, currentAccuracy,
   *    candidateAccuracy, currentLogLoss, candidateLogLoss, classification } */
  thresholds: jsonb("thresholds").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ThresholdEvaluationRunRow = typeof thresholdEvaluationRunsTable.$inferSelect;

/**
 * The immutable prediction ledger for out-of-sample testing AND live paper trading. A row is
 * inserted exactly once, before its result is knowable (a historical-test row uses only
 * pre-cutoff feature snapshots; a paper-trade row is locked before the real match starts), and
 * the only permitted mutation afterwards is the one-time settlement step (see
 * `services/evaluation/settle.ts`), which is guarded by `WHERE status = 'pending'` so it can
 * never fire twice. No route exposes a generic update -- there is no code path that can edit a
 * graded/void/missed row's outcome, delete a loss, or backfill a prediction after its cutoff.
 */
export const evaluationPredictionsTable = pgTable(
  "evaluation_predictions",
  {
    id: serial("id").primaryKey(),

    strategyId: text("strategy_id"),
    strategyVersion: text("strategy_version"),
    strategyFingerprint: text("strategy_fingerprint"),
    optimizerRunId: text("optimizer_run_id"),
    predictionMode: text("prediction_mode"),
    calibrationVersion: text("calibration_version"),
    competitiveBalanceVersion: text("competitive_balance_version"),
    evidenceReliabilityVersion: text("evidence_reliability_version"),

    // 'historical_test' rows are generated by the walk-forward runner against Phase 3's
    // leak-proof store. 'paper_trade' rows are locked automatically ahead of real upcoming
    // fixtures. 'live' is reserved for a future manually-triggered real-money-adjacent mode;
    // today it is written by the same paper-trading loop as 'paper_trade'. 'paper_trade_shadow'
    // rows come from the shadow-mode replay (see services/evaluation/shadowReplay.ts): the same
    // point-in-time scoring path as historical_test, but paced day-by-day over a chosen date
    // range and graded with the CURRENTLY ACTIVE calibration -- mimicking what live paper trading
    // would have produced, for faster (but not fully independent, see that file's doc) evidence.
    // Never merged into historical_test or paper_trade/live in any report -- it is disclosed as
    // simulated evidence everywhere it's shown.
    runKind: text("run_kind").notNull(),
    foldId: integer("fold_id").references(() => evaluationRunsTable.id),
    // 'validation' | 'test' | 'live'.
    segment: text("segment"),
    // Instrumentation-only classification of the underlying data slice used to produce this row.
    dataSegment: text("data_segment").notNull().default("live"),
    // Only set for paper_trade_shadow rows: identifies which replay invocation produced this row,
    // so a specific batch's rows can be listed or deleted without touching any other batch, real
    // paper-trading, or historical_test rows.
    shadowBatchLabel: text("shadow_batch_label"),

    // Set only for historical_test rows -- ties the prediction back to Phase 3's store.
    historicalMatchId: integer("historical_match_id").references(() => historicalMatchesTable.id),
    // Set only for paper_trade/live rows -- the live provider's fixture id, used to dedupe so a
    // fixture is never locked twice.
    provider: text("provider"),
    externalFixtureId: text("external_fixture_id"),

    player1Id: text("player1_id").notNull(),
    player1Name: text("player1_name").notNull(),
    player2Id: text("player2_id").notNull(),
    player2Name: text("player2_name").notNull(),

    surface: text("surface"),
    matchFormat: text("match_format"),
    tournamentLevel: text("tournament_level"),
    tournamentName: text("tournament_name"),

    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }).notNull(),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    // When this record was actually written. For historical_test this is when the walk-forward
    // run executed (not the match date); for paper_trade/live it is the real lock moment, always
    // required to be at/after cutoffAt has arrived and strictly before scheduledStartAt.
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),

    modelVersion: text("model_version").notNull(),
    // Full pre-match feature/engine snapshot used to produce this prediction, frozen at lock
    // time. Shape differs by runKind (reduced feature set for historical_test, full
    // EngineBreakdown for paper_trade/live) -- see services/evaluation/types.ts.
    featureSnapshot: jsonb("feature_snapshot"),

    // Player-1 win probability before/after Phase 4's fitted calibration. Null for 'missed' rows
    // (a missed cutoff means no prediction was ever generated -- we do not backfill one).
    rawProbability: real("raw_probability"),
    calibratedProbability: real("calibrated_probability"),
    predictedWinnerId: text("predicted_winner_id"),
    predictedWinnerName: text("predicted_winner_name"),

    // Denormalized copies of `engine.modelAgreement` / `engine.upsetRiskBreakdown.upsetRisk` from
    // the frozen `featureSnapshot`, added so tier-level outcomes (favorite-loss-rate by upset
    // tier, accuracy by disagreement tier) can be queried/aggregated directly instead of parsing
    // JSON per row. Nullable because they don't exist on rows written before this column was
    // added, and because historical_test rows only carry a reduced feature set that may not
    // always compute one (e.g. very early folds). Purely descriptive -- never read by the
    // prediction engine itself, so backfilling or leaving old rows null cannot affect scoring.
    modelAgreement: text("model_agreement"),
    upsetRiskTier: text("upset_risk_tier"),
    // Instrumentation-only metadata (does not affect prediction logic).
    usedFallback: boolean("used_fallback"),
    fallbackSources: jsonb("fallback_sources").$type<string[]>(),

    // 'pending' -> exactly one of 'graded' | 'void' | 'missed'. Never reverts.
    status: text("status").notNull().default("pending"),
    actualWinnerId: text("actual_winner_id"),
    actualWinnerName: text("actual_winner_name"),
    // 'normal' | 'retired' | 'walkover' | 'cancelled'.
    resultType: text("result_type"),
    // Whether this row counts toward the standard accuracy/logLoss/Brier numbers. Walkovers and
    // cancellations are always false. Retirements follow the admin-configurable rule in
    // prediction_settings (default: excluded, reported separately).
    includedInAccuracy: boolean("included_in_accuracy"),
    gradedAt: timestamp("graded_at", { withTimezone: true }),

    // Task 47: real pre-match market odds captured at lock time (never backfilled or refreshed
    // afterwards -- "at prediction time" is the whole point of a market-edge metric). Null on
    // every row where neither odds provider had this matchup available at lock time; never
    // faked or defaulted. `oddsProvider` records which of the two providers (The Odds API or
    // Odds-API.io) actually supplied the quote, for auditability.
    oddsProvider: text("odds_provider"),
    oddsPlayer1Decimal: real("odds_player1_decimal"),
    oddsPlayer2Decimal: real("odds_player2_decimal"),
    oddsFetchedAt: timestamp("odds_fetched_at", { withTimezone: true }),
    // Vig-adjusted implied probability of PLAYER1 winning (0-100), derived from the odds above --
    // kept player1-relative like rawProbability/calibratedProbability for consistency/auditability.
    impliedProbability: real("implied_probability"),
    // Market edge, oriented to the model's own pick (not player1): predictedWinnerProbability -
    // (the implied probability for whichever side predictedWinnerId actually is). Positive means
    // the model found more value in its own pick than the market priced in. Null whenever
    // impliedProbability is null -- never computed from a fabricated implied probability.
    marketEdge: real("market_edge"),
  },
  (table) => [
    uniqueIndex("evaluation_predictions_historical_match_idx").on(table.runKind, table.historicalMatchId),
    uniqueIndex("evaluation_predictions_fixture_idx").on(table.runKind, table.provider, table.externalFixtureId),
    index("evaluation_predictions_status_idx").on(table.status),
    index("evaluation_predictions_scheduled_start_idx").on(table.scheduledStartAt),
    // Backs GET /evaluation/dashboard's per-segment filters (runKind [+ segment]), which
    // previously required a full-table scan/load to compute in JS.
    index("evaluation_predictions_run_kind_segment_idx").on(table.runKind, table.segment),
    // Backs shadow-replay batch listing/lookup (runKind='paper_trade_shadow' + shadowBatchLabel).
    index("evaluation_predictions_shadow_batch_idx").on(table.runKind, table.shadowBatchLabel),
  ],
);

export const insertEvaluationPredictionSchema = createInsertSchema(evaluationPredictionsTable).omit({ id: true });
export type InsertEvaluationPrediction = z.infer<typeof insertEvaluationPredictionSchema>;
export type EvaluationPredictionRow = typeof evaluationPredictionsTable.$inferSelect;

/**
 * The calibration currently applied to new paper-trade/live predictions. Refit whenever the
 * walk-forward runner completes (from the union of every fold's validation-segment,
 * accuracy-eligible predictions accumulated so far). Exactly one row has `active = true`.
 */
export const calibrationModelsTable = pgTable("calibration_models", {
  id: serial("id").primaryKey(),
  // 'isotonic' | 'platt' -- whichever generalized better on the held-out comparison slice at fit
  // time (see services/evaluation/calibration.ts `fitBestCalibration`). Never hand-picked.
  method: text("method").notNull().default("isotonic"),
  mapping: jsonb("mapping").$type<CalibrationKnotJson[]>().notNull(),
  validationSampleSize: integer("validation_sample_size").notNull(),
  validationDateRangeStart: timestamp("validation_date_range_start", { withTimezone: true }),
  validationDateRangeEnd: timestamp("validation_date_range_end", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  // Log loss of each method on the genuinely held-out comparison slice (never used to fit
  // either method) -- both recorded regardless of which method was actually activated, so the
  // choice is auditable rather than silently picked. Null when there wasn't enough data to hold
  // out a meaningful comparison slice (isotonic is used by default in that case).
  isotonicHoldoutLogLoss: real("isotonic_holdout_log_loss"),
  plattHoldoutLogLoss: real("platt_holdout_log_loss"),
  holdoutSampleSize: integer("holdout_sample_size").notNull().default(0),
  fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCalibrationModelSchema = createInsertSchema(calibrationModelsTable).omit({ id: true, fittedAt: true });
export type InsertCalibrationModel = z.infer<typeof insertCalibrationModelSchema>;
export type CalibrationModelRow = typeof calibrationModelsTable.$inferSelect;

/**
 * Phase 6: one row per tour/surface segment (e.g. "ATP-Clay", "WTA-Hard"). Recomputed every time
 * the walk-forward runner completes, from the SAME leak-proof validation-segment data Phase 4
 * already produces -- never a separately-fit model family. `historicalMatchCount` is the raw
 * Phase 3 coverage check (real matches in this segment, regardless of whether they were ever
 * scored); `meetsThreshold` gates whether this segment is trusted enough to run its own
 * calibration at all. `weight` is this segment's measured share of the live blend against the
 * general model -- derived only from how much better (or worse) its own calibration scores vs.
 * the general mapping on the same segment-scoped validation points, never hand-tuned.
 */
export const specialistModelsTable = pgTable(
  "specialist_models",
  {
    id: serial("id").primaryKey(),

    segmentKey: text("segment_key").notNull(), // e.g. "ATP-Clay", "WTA-Hard", "ATP-General"
    tour: text("tour").notNull(),
    surface: text("surface").notNull(),
    label: text("label").notNull(),

    // Phase 3 coverage check: total real historical matches in this tour+surface segment,
    // regardless of whether they were ever scored/validated.
    historicalMatchCount: integer("historical_match_count").notNull(),
    meetsThreshold: boolean("meets_threshold").notNull(),

    // Phase 4 validation-segment sample actually used to fit/measure this specialist.
    validationSampleSize: integer("validation_sample_size").notNull().default(0),
    accuracy: real("accuracy"),
    logLoss: real("log_loss"),
    brier: real("brier"),
    // The general (pooled, segment-agnostic) model's metrics on this SAME segment-scoped
    // validation data -- the fair baseline the specialist is actually being compared against.
    generalAccuracy: real("general_accuracy"),
    generalLogLoss: real("general_log_loss"),
    generalBrier: real("general_brier"),

    calibrationMapping: jsonb("calibration_mapping").$type<CalibrationKnotJson[]>().notNull().default([]),
    // This segment's share (0-1) of the level-2 live blend against the general model. 0 whenever
    // meetsThreshold is false (i.e. the live engine falls back to the general model entirely).
    weight: real("weight").notNull().default(0),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("specialist_models_segment_key_idx").on(table.segmentKey)],
);

export const insertSpecialistModelSchema = createInsertSchema(specialistModelsTable).omit({ id: true, computedAt: true });
export type InsertSpecialistModel = z.infer<typeof insertSpecialistModelSchema>;
export type SpecialistModelRow = typeof specialistModelsTable.$inferSelect;

/**
 * Phase 7: the current validation status of the Monte Carlo point-by-point simulator, recomputed
 * on demand by `services/evaluation/simulatorValidation.ts` from whatever real graded outcomes
 * exist (historical_test test-segment rows and paper_trade/live rows, both of which store a full
 * live EngineBreakdown snapshot the simulator's inputs can be reconstructed from). Only one row
 * is kept -- each validation run overwrites it -- since, unlike specialist_models (many
 * segments), there is exactly one simulator to evaluate.
 */
export const simulatorValidationTable = pgTable("simulator_validation", {
  id: serial("id").primaryKey(),

  sampleSize: integer("sample_size").notNull(),
  minSampleSize: integer("min_sample_size").notNull(),

  simulatorAccuracy: real("simulator_accuracy"),
  simulatorLogLoss: real("simulator_log_loss"),
  simulatorBrier: real("simulator_brier"),
  // The existing ensemble's OWN calibrated probability on the exact same graded rows -- the fair
  // baseline the simulator is actually being compared against.
  ensembleAccuracy: real("ensemble_accuracy"),
  ensembleLogLoss: real("ensemble_log_loss"),
  ensembleBrier: real("ensemble_brier"),

  // True only when sampleSize >= minSampleSize AND the simulator measurably beat the ensemble's
  // logLoss on these points -- never hand-picked.
  adopted: boolean("adopted").notNull().default(false),
  // This simulator's measured blend weight (0-1) against the rest of the ensemble; 0 when not adopted.
  weight: real("weight").notNull().default(0),
  note: text("note").notNull(),

  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSimulatorValidationSchema = createInsertSchema(simulatorValidationTable).omit({ id: true, computedAt: true });
export type InsertSimulatorValidation = z.infer<typeof insertSimulatorValidationSchema>;
export type SimulatorValidationRow = typeof simulatorValidationTable.$inferSelect;

/** Singleton admin configuration row for Phase 4 evaluation behavior. */
export const predictionSettingsTable = pgTable("prediction_settings", {
  id: serial("id").primaryKey(),
  // 'excluded': retirements never count toward standard accuracy (still reported separately).
  // 'included': retirements count like normal results.
  retirementRule: text("retirement_rule").notNull().default("excluded"),
  // How long before a real fixture's scheduled start the paper-trading loop locks a prediction.
  paperTradeLeadMinutes: integer("paper_trade_lead_minutes").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPredictionSettingsSchema = createInsertSchema(predictionSettingsTable).omit({ id: true, updatedAt: true });
export type InsertPredictionSettings = z.infer<typeof insertPredictionSettingsSchema>;
export type PredictionSettingsRow = typeof predictionSettingsTable.$inferSelect;

/**
 * Durable audit trail for the paper-trading job (see `services/evaluation/paperTrading.ts` and
 * `jobs/runPaperTradingJob.ts`). One row per invocation of the standalone job process --
 * intentionally NOT in-memory, so a run's outcome (and any retries it took) survives process
 * restarts and is inspectable regardless of which process/host ran it. This is what lets a
 * cutoff-uptime-independent scheduler (e.g. a Replit Scheduled Deployment) be monitored: a gap
 * in recent 'success' rows, or a run of 'failed' rows, is the alert signal.
 */
export const jobRunsTable = pgTable(
  "job_runs",
  {
    id: serial("id").primaryKey(),
    jobName: text("job_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // 'success': the cycle ran to completion (it may still contain per-fixture errors in
    // `summary.errors`, e.g. a transient provider hiccup on one fixture -- those are not fatal).
    // 'failed': every retry attempt threw and the job gave up -- this is the fatal, alert-worthy
    // case, and the process exits non-zero so an external scheduler's own failure detection fires.
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    // The cycle's own locked/missed/graded/errors summary, present even when status = 'success'.
    summary: jsonb("summary"),
    // Only set when status = 'failed' -- the final attempt's error message.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_runs_job_name_started_idx").on(table.jobName, table.startedAt)],
);

export const insertJobRunSchema = createInsertSchema(jobRunsTable).omit({ id: true, createdAt: true });
export type InsertJobRun = z.infer<typeof insertJobRunSchema>;
export type JobRunRow = typeof jobRunsTable.$inferSelect;
