import { pgTable, serial, text, integer, real, boolean, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Append-only, leak-proof historical match store (Phase 3).
 *
 * A row here is never mutated after insert (other than being written once by the backfill
 * pipeline). Every match freezes the exact "cutoff" timestamp (scheduled start minus a
 * configured lead time) that determined which data was eligible to feed that match's
 * pre-match feature snapshot -- see `matchFeatureSnapshotsTable` below.
 */
export const historicalMatchesTable = pgTable(
  "historical_matches",
  {
    id: serial("id").primaryKey(),

    // Provider's own event id, used for de-duplication across repeated/overlapping backfill runs.
    externalId: text("external_id").notNull(),
    provider: text("provider").notNull().default("API-Tennis"),

    tour: text("tour"), // ATP / WTA / Challenger / ITF / Exhibition / Junior / ...
    tournamentName: text("tournament_name"),
    tournamentLevel: text("tournament_level"),
    surface: text("surface"),
    round: text("round"),
    matchFormat: text("match_format"),

    player1Id: text("player1_id").notNull(),
    player1Name: text("player1_name").notNull(),
    player2Id: text("player2_id").notNull(),
    player2Name: text("player2_name").notNull(),

    // Null only for cancelled matches that never produced a winner.
    winnerId: text("winner_id"),
    score: text("score"),
    retired: boolean("retired").notNull().default(false),
    walkover: boolean("walkover").notNull().default(false),
    cancelled: boolean("cancelled").notNull().default(false),
    // Games won per set, player1's perspective, e.g. [{player1Games:6,player2Games:4}, ...].
    // Stored as a structured column (not re-derived from rawSource) so any later process --
    // including re-hydrating running feature state across separate backfill runs -- can read it
    // without needing to know the specific upstream provider's raw payload shape.
    gameMarginsPlayer1: jsonb("game_margins_player1").notNull().default([]),

    // Whether the match was played indoors. Populated from the provider's `indoor` flag when
    // available; falls back to null rather than fabricating a value. Callers that need a best-
    // guess can still infer it from surface ("IndoorHard" implies indoor) as a secondary signal.
    indoor: boolean("indoor"),

    // Official ATP/WTA ranking at time of match, extracted from the provider's fixture payload
    // when available. Null means the provider did not supply it for this match -- never zero.
    player1Rank: integer("player1_rank"),
    player2Rank: integer("player2_rank"),

    // Scheduled start as reported by the provider (best available "match start" timestamp),
    // converted from the tournament venue's real local wall-clock time to UTC via
    // `resolveTournamentTimezone`/`combineDateTimeUtc`.
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }).notNull(),
    // False when the venue's timezone couldn't be confidently resolved at import time, so
    // `scheduledStartAt` falls back to the provider's date at UTC midnight -- a documented,
    // flagged fallback, never a silent guess. Callers doing fold ordering / cutoff simulation
    // can use this to know when a row's exact time (not just its date) is untrustworthy.
    scheduledStartTimeConfirmed: boolean("scheduled_start_time_confirmed").notNull().default(true),
    // The configured lead time (minutes) used to derive cutoffAt for THIS match, frozen at
    // import time so a later config change never silently reinterprets old rows.
    cutoffMinutes: integer("cutoff_minutes").notNull(),
    // scheduledStartAt - cutoffMinutes. This is the hard boundary: nothing timestamped at or
    // after this instant may appear in this match's pre-match feature snapshot.
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),

    // Raw provider payload, kept for audit/debugging -- never read by the prediction engine.
    rawSource: jsonb("raw_source").notNull(),

    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("historical_matches_external_id_idx").on(table.provider, table.externalId),
    index("historical_matches_scheduled_start_idx").on(table.scheduledStartAt),
    // Task #154 performance indexes (H2H + surface-date) are NOT declared here.
    // They are created with CREATE INDEX CONCURRENTLY IF NOT EXISTS in
    // lib/db/src/sql/perf-indexes-concurrent.sql, applied by applySqlExtras.ts after
    // every `pnpm push`.  Declaring them here would cause drizzle-kit push to create
    // them non-concurrently (blocking lock on a large populated table) before the
    // concurrent script runs, defeating the no-lock guarantee.
  ],
);

export const insertHistoricalMatchSchema = createInsertSchema(historicalMatchesTable).omit({
  id: true,
  importedAt: true,
});
export type InsertHistoricalMatch = z.infer<typeof insertHistoricalMatchSchema>;
export type HistoricalMatchRow = typeof historicalMatchesTable.$inferSelect;

/**
 * Frozen pre-match feature snapshots -- one row per (match, player, feature). Written once by
 * the backfill pipeline at the moment a match is imported and never recomputed afterwards, so a
 * later bug fix can't retroactively "leak" hindsight into an already-stored snapshot.
 *
 * Every row is independently checkable for leakage: `sourceTimestamp` is when the underlying
 * fact this feature was built from actually existed (e.g. the date of the most recent match
 * that fed a running Elo rating); `matchCutoffAt` is copied from the match at write time;
 * `existedBeforeCutoff` is computed once, at write time, as `sourceTimestamp < matchCutoffAt`.
 * A row is only ever written when this is true -- there is no path that inserts a feature that
 * fails its own check.
 */
export const matchFeatureSnapshotsTable = pgTable(
  "match_feature_snapshots",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => historicalMatchesTable.id),
    playerId: text("player_id").notNull(),

    // e.g. "eloOverall", "eloSurface", "matchesPlayed", "winPctLast10", "daysSinceLastMatch",
    // "gameShareLast10". See historicalData/features.ts for the authoritative list + definitions.
    featureName: text("feature_name").notNull(),
    featureValue: real("feature_value").notNull(),

    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }).notNull(),
    matchCutoffAt: timestamp("match_cutoff_at", { withTimezone: true }).notNull(),
    existedBeforeCutoff: boolean("existed_before_cutoff").notNull(),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("match_feature_snapshots_unique_idx").on(table.matchId, table.playerId, table.featureName),
    index("match_feature_snapshots_match_idx").on(table.matchId),
    index("match_feature_snapshots_player_idx").on(table.playerId),
  ],
);

export const insertMatchFeatureSnapshotSchema = createInsertSchema(matchFeatureSnapshotsTable).omit({
  id: true,
  recordedAt: true,
});
export type InsertMatchFeatureSnapshot = z.infer<typeof insertMatchFeatureSnapshotSchema>;
export type MatchFeatureSnapshotRow = typeof matchFeatureSnapshotsTable.$inferSelect;
