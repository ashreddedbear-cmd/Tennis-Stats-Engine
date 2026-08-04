import { pgTable, serial, text, integer, real, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const predictionsTable = pgTable(
  "predictions",
  {
    id: serial("id").primaryKey(),

    player1Id: text("player1_id").notNull(),
    player1Name: text("player1_name").notNull(),
    player2Id: text("player2_id").notNull(),
    player2Name: text("player2_name").notNull(),

    surface: text("surface").notNull(),
    matchFormat: text("match_format").notNull(),
    tournamentLevel: text("tournament_level"),
    tournamentName: text("tournament_name"),

    // Provenance fields for cross-interface prediction parity/auditability.
    strategyId: text("strategy_id"),
    strategyVersion: text("strategy_version"),
    calibrationVersion: text("calibration_version"),
    externalFixtureId: text("external_fixture_id"),
    snapshotCapturedAt: timestamp("snapshot_captured_at", { withTimezone: true }).notNull().defaultNow(),

    predictedWinnerId: text("predicted_winner_id").notNull(),
    predictedWinnerName: text("predicted_winner_name").notNull(),
    calibratedProbability: real("calibrated_probability").notNull(),
    // The predicted winner's own win probability (mirrored from calibratedProbability when
    // player 2 is the pick) -- always >= 50, so display surfaces never show a sub-50% number
    // next to the player the engine named the favorite. calibratedProbability itself stays
    // player-1-relative because calibration fitting/evaluation depend on that fixed orientation.
    predictedWinnerProbability: real("predicted_winner_probability").notNull(),
    dataQuality: integer("data_quality").notNull(),
    dataQualityLabel: text("data_quality_label").notNull(),
    upsetRisk: text("upset_risk").notNull(),
    recommendation: text("recommendation").notNull(),
    predictedSetScore: text("predicted_set_score").notNull(),

    // Instrumentation-only metadata (does not affect prediction logic).
    dataSegment: text("data_segment").notNull().default("live"),
    usedFallback: boolean("used_fallback"),
    fallbackSources: jsonb("fallback_sources").$type<string[]>(),

    // Full module-by-module engine output (EngineBreakdown shape), stored as-is for the detail view.
    engine: jsonb("engine").notNull(),

    // Preventive duplicate-prediction protection (2026-07-13 spec, Part 4) -- see
    // predictionEngine/predictionIdentity.ts. `matchIdentityKey` is an order-independent key over
    // the two player ids + tournament + surface + format; `inputSnapshotHash` is a SHA-256 hash of
    // the actual resolved match histories/head-to-head/opponent-strength inputs used for THIS
    // prediction. Together they form a DB-enforced uniqueness constraint: a genuinely identical
    // repeat request (same match, same inputs) can never insert a second row, while a request for
    // the same match with materially different inputs (e.g. newer match history) still can. This
    // is distinct from `ledgerDuplicates.ts`'s manual cleanup tool, which detects/removes
    // duplicates after the fact using a looser key that ignores inputs entirely.
    matchIdentityKey: text("match_identity_key").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),

    actualWinnerId: text("actual_winner_id"),
    actualWinnerName: text("actual_winner_name"),

    /**
     * Task #32 (Engine Audit + Decision Explainability): per-module raw edge values, pipeline
     * intermediate probabilities at every stage (rawEnsemble → afterCalibration → afterSpecialist
     * → afterReliabilityDiscount → afterSimulator), recommendation rule chain, and elite-tier
     * gate pass/fail breakdown. Nullable: predictions made before this field existed have null.
     * Shape: DecisionTrace (see predictionEngine/index.ts).
     */
    decisionTrace: jsonb("decision_trace"),

    /**
     * Clerk user ID of the authenticated user who created this prediction.
     * Nullable for rows inserted before this column was added (admin / pre-launch corpus).
     * All new predictions from Clerk-authenticated users populate this field so the history
     * endpoint can scope results to the requesting user's own predictions only.
     */
    clerkUserId: text("clerk_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // Backs the Ledger/History page's `ORDER BY created_at DESC LIMIT n` query, and the
    // `/predictions/stats` aggregation's full-table scan avoidance as row counts grow.
    index("predictions_created_at_idx").on(table.createdAt),
    index("predictions_recommendation_idx").on(table.recommendation),
    // Backs per-user history scoping: WHERE clerk_user_id = $1 ORDER BY created_at DESC
    index("predictions_clerk_user_id_idx").on(table.clerkUserId),
    // Enforces "same match, same resolved inputs -> at most one row" at the database level (see
    // the column doc above). A prediction submitted for the same match with different inputs gets
    // a different inputSnapshotHash and is free to insert a new row.
    uniqueIndex("predictions_identity_input_snapshot_idx").on(table.matchIdentityKey, table.inputSnapshotHash),
  ],
);

export const insertPredictionSchema = createInsertSchema(predictionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type PredictionRow = typeof predictionsTable.$inferSelect;
