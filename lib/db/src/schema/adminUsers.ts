import { pgTable, serial, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Immutable append-only audit log for every admin action on a user account.
 * Never update or delete rows — each action is a new row.
 */
export const adminAuditLogTable = pgTable(
  "admin_audit_log",
  {
    id: serial("id").primaryKey(),
    /** Who performed the action (admin session identifier, defaults to "owner") */
    adminId: text("admin_id").notNull().default("owner"),
    /** Clerk user ID of the affected user */
    targetClerkUserId: text("target_clerk_user_id").notNull(),
    /** Snapshot of email at time of action (for readability in the log) */
    targetEmail: text("target_email"),
    /**
     * Machine-readable action key:
     * plan_change | complimentary_access | suspend | unsuspend | ban | unban |
     * cancel_subscription | restore_cancellation | extend_trial | reset_predictions |
     * refund | note_updated | seats_change
     */
    action: text("action").notNull(),
    /** JSON snapshot of the value before the change */
    previousValue: jsonb("previous_value").$type<unknown>(),
    /** JSON snapshot of the value after the change */
    newValue: jsonb("new_value").$type<unknown>(),
    /** Optional free-text reason provided by the admin */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_audit_log_target_idx").on(table.targetClerkUserId),
    index("admin_audit_log_action_idx").on(table.action),
    index("admin_audit_log_created_idx").on(table.createdAt),
  ],
);

/**
 * One row per Clerk user — private admin notes and account-status overrides.
 * Upserted on every write; never hard-deleted (soft history via audit log).
 */
export const adminUserNotesTable = pgTable(
  "admin_user_notes",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    /** Private markdown note visible only to admins */
    note: text("note").notNull().default(""),
    /**
     * Admin-controlled account status override:
     * "active" | "suspended" | "banned"
     * Enforcement must be checked in requireClerkUser and prediction endpoints.
     */
    accountStatus: text("account_status").notNull().default("active"),
    /** Plan key for complimentary access (null = no comp access): "pro" | "elite" */
    complimentaryPlan: text("complimentary_plan"),
    complimentaryExpiresAt: timestamp("complimentary_expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull().default("owner"),
  },
  (table) => [uniqueIndex("admin_user_notes_clerk_user_id_idx").on(table.clerkUserId)],
);

export type AdminAuditLogRow = typeof adminAuditLogTable.$inferSelect;
export type AdminUserNotesRow = typeof adminUserNotesTable.$inferSelect;
