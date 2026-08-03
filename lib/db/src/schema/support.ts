import { pgTable, serial, text, timestamp, index, jsonb, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Support Tickets ───────────────────────────────────────────────────────────

export const supportTicketsTable = pgTable(
  "support_tickets",
  {
    id: serial("id").primaryKey(),
    ticketNumber: text("ticket_number"),                     // TM-000001 (set after insert)
    clerkUserId: text("clerk_user_id"),                      // Clerk user ID (null for legacy)
    category: text("category").notNull(),
    subject: text("subject").notNull().default(""),
    status: text("status").notNull().default("open"),        // open | waiting_for_support | waiting_for_user | resolved | closed
    priority: text("priority").notNull().default("normal"),  // low | normal | high | urgent
    assignedAdminId: text("assigned_admin_id"),
    sourceRoute: text("source_route"),
    appVersion: text("app_version"),
    deviceInfo: text("device_info"),
    // Snapshot of user info at submission time
    userName: text("user_name"),
    userEmail: text("user_email"),
    subscriptionPlan: text("subscription_plan"),             // free | pro | pro_annual | elite | elite_annual | team
    isTrialing: text("is_trialing"),                         // "true" | "false"
    accountRole: text("account_role"),                       // user | admin | owner
    // Timestamps
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // Legacy columns — kept for backward compat
    name: text("name"),
    email: text("email"),
    message: text("message"),
    requestType: text("request_type"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("support_tickets_clerk_user_idx").on(table.clerkUserId),
    index("support_tickets_category_idx").on(table.category),
    index("support_tickets_status_idx").on(table.status),
    index("support_tickets_priority_idx").on(table.priority),
    index("support_tickets_created_idx").on(table.createdAt),
  ],
);

// ── Support Messages ──────────────────────────────────────────────────────────

export const supportMessagesTable = pgTable(
  "support_messages",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id").notNull(),
    senderUserId: text("sender_user_id"),    // Clerk user ID or admin identifier
    senderRole: text("sender_role").notNull(), // "user" | "admin"
    senderName: text("sender_name"),
    message: text("message").notNull(),
    isInternalNote: boolean("is_internal_note").notNull().default(false), // admin-only notes
    isReadByUser: boolean("is_read_by_user").notNull().default(false),
    isReadByAdmin: boolean("is_read_by_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("support_messages_ticket_idx").on(table.ticketId),
    index("support_messages_created_idx").on(table.createdAt),
  ],
);

// ── Support Attachments ───────────────────────────────────────────────────────
// Stores compressed image thumbnails as base64 data URIs (client-side compressed
// to max 800px / JPEG 70% ≈ 20-80 KB each, max 5 per message).

export const supportAttachmentsTable = pgTable(
  "support_attachments",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id").notNull(),
    messageId: integer("message_id"),         // null for ticket-level attachments (first message)
    uploadedByUserId: text("uploaded_by_user_id"),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSizeBytes: integer("file_size_bytes"),
    dataUri: text("data_uri").notNull(),      // compressed base64 data URI
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("support_attachments_ticket_idx").on(table.ticketId),
    index("support_attachments_message_idx").on(table.messageId),
  ],
);

// ── Legal Consents (unchanged) ────────────────────────────────────────────────

export const legalConsentsTable = pgTable(
  "legal_consents",
  {
    id: serial("id").primaryKey(),
    context: text("context").notNull(),
    email: text("email"),
    agreedTerms: text("agreed_terms").notNull().default("true"),
    agreedPrivacy: text("agreed_privacy").notNull().default("true"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("legal_consents_context_idx").on(table.context),
    index("legal_consents_created_idx").on(table.createdAt),
  ],
);

// ── Types ─────────────────────────────────────────────────────────────────────

export const insertSupportTicketSchema = createInsertSchema(supportTicketsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicketRow = typeof supportTicketsTable.$inferSelect;

export const insertSupportMessageSchema = createInsertSchema(supportMessagesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupportMessage = z.infer<typeof insertSupportMessageSchema>;
export type SupportMessageRow = typeof supportMessagesTable.$inferSelect;

export const insertSupportAttachmentSchema = createInsertSchema(supportAttachmentsTable).omit({ id: true, createdAt: true });
export type InsertSupportAttachment = z.infer<typeof insertSupportAttachmentSchema>;
export type SupportAttachmentRow = typeof supportAttachmentsTable.$inferSelect;

export const insertLegalConsentSchema = createInsertSchema(legalConsentsTable).omit({ id: true, createdAt: true });
export type InsertLegalConsent = z.infer<typeof insertLegalConsentSchema>;
export type LegalConsentRow = typeof legalConsentsTable.$inferSelect;
