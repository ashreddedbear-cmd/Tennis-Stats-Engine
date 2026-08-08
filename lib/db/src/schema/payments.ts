import { pgTable, serial, text, boolean, jsonb, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paymentsAccountTable = pgTable(
  "payments_accounts",
  {
    id: serial("id").primaryKey(),

    accountKey: text("account_key").notNull().default("workspace"),
    displayName: text("display_name").notNull().default("Workspace Subscription"),

    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),

    planKey: text("plan_key"),
    planName: text("plan_name"),
    subscriptionStatus: text("subscription_status"),
    accessGrantedAt: timestamp("access_granted_at", { withTimezone: true }),
    currentPeriodStartAt: timestamp("current_period_start_at", { withTimezone: true }),
    currentPeriodEndAt: timestamp("current_period_end_at", { withTimezone: true }),
    trialEndAt: timestamp("trial_end_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),

    trialStartAt: timestamp("trial_start_at", { withTimezone: true }),
    failedPaymentCount: integer("failed_payment_count").notNull().default(0),
    lastPaymentAt: timestamp("last_payment_at", { withTimezone: true }),
    lastPaymentAmount: integer("last_payment_amount"),
    lastPaymentStatus: text("last_payment_status"),

    entitlementSnapshot: jsonb("entitlement_snapshot").$type<Record<string, boolean>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastWebhookEventId: text("last_webhook_event_id"),
    lastCheckoutSessionId: text("last_checkout_session_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payments_accounts_account_key_idx").on(table.accountKey),
    uniqueIndex("payments_accounts_customer_idx").on(table.stripeCustomerId),
    uniqueIndex("payments_accounts_subscription_idx").on(table.stripeSubscriptionId),
    index("payments_accounts_status_idx").on(table.subscriptionStatus),
  ],
);

export const insertPaymentsAccountSchema = createInsertSchema(paymentsAccountTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPaymentsAccount = z.infer<typeof insertPaymentsAccountSchema>;
export type PaymentsAccountRow = typeof paymentsAccountTable.$inferSelect;

export const paymentWebhookEventsTable = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),

    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    livemode: boolean("livemode").notNull().default(false),

    processingStatus: text("processing_status").notNull().default("received"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    errorMessage: text("error_message"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_events_stripe_event_id_idx").on(table.stripeEventId),
    index("webhook_events_status_idx").on(table.processingStatus),
    index("webhook_events_type_idx").on(table.eventType),
    index("webhook_events_received_idx").on(table.receivedAt),
  ],
);

export const insertPaymentWebhookEventSchema = createInsertSchema(paymentWebhookEventsTable).omit({ id: true, createdAt: true, receivedAt: true, processedAt: true });
export type InsertPaymentWebhookEvent = z.infer<typeof insertPaymentWebhookEventSchema>;
export type PaymentWebhookEventRow = typeof paymentWebhookEventsTable.$inferSelect;