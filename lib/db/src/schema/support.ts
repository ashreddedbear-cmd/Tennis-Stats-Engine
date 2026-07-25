import { pgTable, serial, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const supportTicketsTable = pgTable(
  "support_tickets",
  {
    id: serial("id").primaryKey(),
    category: text("category").notNull(),
    name: text("name"),
    email: text("email"),
    subject: text("subject"),
    message: text("message"),
    requestType: text("request_type"),
    status: text("status").notNull().default("open"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("support_tickets_category_idx").on(table.category),
    index("support_tickets_status_idx").on(table.status),
    index("support_tickets_created_idx").on(table.createdAt),
  ],
);

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

export const insertSupportTicketSchema = createInsertSchema(supportTicketsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicketRow = typeof supportTicketsTable.$inferSelect;

export const insertLegalConsentSchema = createInsertSchema(legalConsentsTable).omit({ id: true, createdAt: true });
export type InsertLegalConsent = z.infer<typeof insertLegalConsentSchema>;
export type LegalConsentRow = typeof legalConsentsTable.$inferSelect;
