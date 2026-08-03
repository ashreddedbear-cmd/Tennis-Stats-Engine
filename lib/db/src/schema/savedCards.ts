import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Saved prediction cards — per-user bookmarks pointing at rows in the predictions table.
 * Only Clerk-authenticated users can save cards (clerkUserId is required, not nullable).
 * Admin sessions bypass Clerk and have no clerkUserId, so they cannot save cards.
 */
export const savedPredictionCardsTable = pgTable(
  "saved_prediction_cards",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    predictionId: integer("prediction_id").notNull(),
    /** Optional short label or note the user attached when saving. */
    note: text("note"),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("saved_prediction_cards_clerk_user_id_idx").on(table.clerkUserId),
    // One save per user per prediction — prevents duplicate saves.
    uniqueIndex("saved_prediction_cards_user_prediction_idx").on(
      table.clerkUserId,
      table.predictionId,
    ),
  ],
);

export type SavedPredictionCard = typeof savedPredictionCardsTable.$inferSelect;
