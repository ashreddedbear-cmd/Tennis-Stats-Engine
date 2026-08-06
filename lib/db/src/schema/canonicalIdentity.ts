import { boolean, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Additive provider-independent identity registry. Existing provider IDs remain untouched. */
export const canonicalPlayersTable = pgTable("canonical_players", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  tour: text("tour"),
  nationality: text("nationality"),
  dateOfBirth: timestamp("date_of_birth", { withTimezone: true }),
  handedness: text("handedness"),
  heightCm: integer("height_cm"),
  activeFrom: timestamp("active_from", { withTimezone: true }),
  activeTo: timestamp("active_to", { withTimezone: true }),
  reviewStatus: text("review_status").notNull().default("approved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("canonical_players_normalized_name_idx").on(table.normalizedName),
  index("canonical_players_tour_idx").on(table.tour),
]);

export const playerAliasesTable = pgTable("player_aliases", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  externalPlayerId: text("external_player_id").notNull(),
  externalPlayerName: text("external_player_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  canonicalPlayerId: text("canonical_player_id").notNull().references(() => canonicalPlayersTable.id),
  aliasType: text("alias_type").notNull().default("provider-id"),
  verificationStatus: text("verification_status").notNull().default("verified"),
  metadata: jsonb("metadata").notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("player_aliases_provider_external_id_idx").on(table.provider, table.externalPlayerId),
  index("player_aliases_normalized_name_idx").on(table.normalizedName),
  index("player_aliases_canonical_player_idx").on(table.canonicalPlayerId),
]);

export const canonicalMatchesTable = pgTable("canonical_matches", {
  id: text("id").primaryKey(),
  matchKey: text("match_key").notNull(),
  playerAId: text("player_a_id").notNull().references(() => canonicalPlayersTable.id),
  playerBId: text("player_b_id").notNull().references(() => canonicalPlayersTable.id),
  tournamentName: text("tournament_name"),
  normalizedTournamentName: text("normalized_tournament_name"),
  tour: text("tour"),
  eventLevel: text("event_level"),
  matchDate: timestamp("match_date", { withTimezone: true }),
  round: text("round"),
  surface: text("surface"),
  drawType: text("draw_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("canonical_matches_match_key_idx").on(table.matchKey)]);

export const matchSourceLinksTable = pgTable("match_source_links", {
  id: text("id").primaryKey(),
  canonicalMatchId: text("canonical_match_id").notNull().references(() => canonicalMatchesTable.id),
  provider: text("provider").notNull(),
  externalMatchId: text("external_match_id").notNull(),
  sourcePayload: jsonb("source_payload").notNull().default({}),
  sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("match_source_links_provider_external_id_idx").on(table.provider, table.externalMatchId),
  index("match_source_links_canonical_match_idx").on(table.canonicalMatchId),
]);

export const playerResolutionReviewsTable = pgTable("player_resolution_reviews", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  provider: text("provider"),
  externalPlayerId: text("external_player_id"),
  externalPlayerName: text("external_player_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  candidateCanonicalIds: jsonb("candidate_canonical_ids").notNull().default([]),
  resolutionMethod: text("resolution_method").notNull(),
  confidence: real("confidence").notNull(),
  supportingMetadata: jsonb("supporting_metadata").notNull().default({}),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const historicalFeatureDiagnosticsTable = pgTable("historical_feature_diagnostics", {
  id: text("id").primaryKey(),
  canonicalPlayerId: text("canonical_player_id").notNull().references(() => canonicalPlayersTable.id),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  matchesFound: integer("matches_found").notNull().default(0),
  dateFrom: timestamp("date_from", { withTimezone: true }),
  dateTo: timestamp("date_to", { withTimezone: true }),
  surfaceMatchesFound: integer("surface_matches_found").notNull().default(0),
  opponentQualitySample: integer("opponent_quality_sample").notNull().default(0),
  serveReturnSampleSize: integer("serve_return_sample_size").notNull().default(0),
  resolutionMethod: text("resolution_method").notNull(),
  resolutionConfidence: real("resolution_confidence").notNull(),
  sourceCoverage: jsonb("source_coverage").notNull().default({}),
  fallbackReason: text("fallback_reason"),
  historicalDataStatus: text("historical_data_status").notNull(),
  fallbackUsed: boolean("fallback_used").notNull().default(false),
  lineage: jsonb("lineage").notNull().default({}),
});

export const insertCanonicalPlayerSchema = createInsertSchema(canonicalPlayersTable).omit({ createdAt: true, updatedAt: true });
export const insertPlayerAliasSchema = createInsertSchema(playerAliasesTable).omit({ createdAt: true, updatedAt: true });
export const insertCanonicalMatchSchema = createInsertSchema(canonicalMatchesTable).omit({ createdAt: true });
export const insertMatchSourceLinkSchema = createInsertSchema(matchSourceLinksTable).omit({ createdAt: true });
export const insertPlayerResolutionReviewSchema = createInsertSchema(playerResolutionReviewsTable).omit({ createdAt: true, reviewedAt: true });
export const insertHistoricalFeatureDiagnosticsSchema = createInsertSchema(historicalFeatureDiagnosticsTable).omit({ requestedAt: true });

export type CanonicalPlayer = typeof canonicalPlayersTable.$inferSelect;
export type PlayerAlias = typeof playerAliasesTable.$inferSelect;
export type CanonicalMatch = typeof canonicalMatchesTable.$inferSelect;
export type MatchSourceLink = typeof matchSourceLinksTable.$inferSelect;
export type PlayerResolutionReview = typeof playerResolutionReviewsTable.$inferSelect;
export type HistoricalFeatureDiagnostics = typeof historicalFeatureDiagnosticsTable.$inferSelect;
export type InsertCanonicalPlayer = z.infer<typeof insertCanonicalPlayerSchema>;
export type InsertPlayerAlias = z.infer<typeof insertPlayerAliasSchema>;