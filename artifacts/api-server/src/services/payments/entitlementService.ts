import { and, desc, eq, or } from "drizzle-orm";
import { db, paymentsAccountTable, paymentWebhookEventsTable, type PaymentsAccountRow, type PaymentWebhookEventRow } from "@workspace/db";
import { isPaymentsV2Enabled, PAYMENTS_ACCOUNT_KEY, getPaymentsPlanKey, getPaymentsPlanName, getStripeElitePriceId, getStripeProAnnualPriceId, getStripeEliteAnnualPriceId, getStripeTeamPriceId } from "./config";

export const PAYMENT_ENTITLEMENT_KEYS = [
  "predictionHistory",
  "walkForward",
  "shadowReplay",
  "optimizer",
  "competitiveBalance",
  "evidenceReliability",
  "developerAnalytics",
  "eliteRecommendations",
  "alerts",
  "teamWorkspace",
  // ── Elite-only ──────────────────────────────────────────────────────────
  "fullModelMonitoring",
  "confidenceCalibration",
  "recommendationPerformance",
  "historicalModelTrends",
  "monteCarlo",
  "eliteBadge",
  "advancedExplanation",
  "confidenceHistory",
] as const;

export type PaymentEntitlementKey = (typeof PAYMENT_ENTITLEMENT_KEYS)[number];
export type PaymentEntitlements = Record<PaymentEntitlementKey, boolean>;
export type SubscriptionTier = "free" | "pro" | "pro_annual" | "elite" | "elite_annual" | "team";

export interface PaymentAccessState {
  featureFlagEnabled: boolean;
  configured: boolean;
  account: PaymentsAccountRow | null;
  entitlements: PaymentEntitlements;
  active: boolean;
  tier: SubscriptionTier;
}

export function getDefaultEntitlements(): PaymentEntitlements {
  return {
    predictionHistory: false,
    walkForward: false,
    shadowReplay: false,
    optimizer: false,
    competitiveBalance: false,
    evidenceReliability: false,
    developerAnalytics: false,
    eliteRecommendations: false,
    alerts: false,
    teamWorkspace: false,
    // Elite-only — all false for free
    fullModelMonitoring: false,
    confidenceCalibration: false,
    recommendationPerformance: false,
    historicalModelTrends: false,
    monteCarlo: false,
    eliteBadge: false,
    advancedExplanation: false,
    confidenceHistory: false,
  };
}

/** Pro ($19.99) — "Who wins and why?" — unlimited predictions + core analytics */
function proEntitlements(): PaymentEntitlements {
  return {
    predictionHistory: true,
    walkForward: false,        // admin-only
    shadowReplay: false,       // admin-only
    optimizer: false,          // admin-only
    competitiveBalance: true,  // upset risk, model agreement
    evidenceReliability: true, // data quality, evidence modules
    developerAnalytics: false, // admin-only
    eliteRecommendations: true, // gates POST /predictions — Pro can make unlimited predictions
    alerts: true,
    teamWorkspace: false,      // not yet implemented
    // Elite-only — locked for Pro
    fullModelMonitoring: false,
    confidenceCalibration: false,
    recommendationPerformance: false,
    historicalModelTrends: false,
    monteCarlo: false,
    eliteBadge: false,
    advancedExplanation: false,
    confidenceHistory: false,
  };
}

/** Elite ($49.99/mo or $475/yr) — "How trustworthy is the AI?" — everything in Pro plus deep analytics */
function eliteEntitlements(): PaymentEntitlements {
  return {
    ...proEntitlements(),
    fullModelMonitoring: true,
    confidenceCalibration: true,
    recommendationPerformance: true,
    historicalModelTrends: true,
    monteCarlo: true,
    eliteBadge: true,
    advancedExplanation: true,
    confidenceHistory: true,
  };
}

/** Team ($249/mo) — Elite entitlements + team workspace */
function teamEntitlements(): PaymentEntitlements {
  return { ...eliteEntitlements(), teamWorkspace: true };
}

/** Derive tier from the stored planKey. Maps all planKey variants to their SubscriptionTier. */
function tierFromPlanKey(planKey: string | null | undefined): SubscriptionTier {
  switch (planKey) {
    case "elite":        return "elite";
    case "elite_annual": return "elite_annual";
    case "pro_annual":   return "pro_annual";
    case "team":         return "team";
    default:             return "pro";
  }
}

/** Derive tier and planKey by comparing a Stripe price ID to all configured price IDs. */
function resolveTierFromPriceId(stripePriceId: string | null | undefined): { tier: SubscriptionTier; planKey: string; planName: string } {
  if (stripePriceId) {
    const elitePriceId       = getStripeElitePriceId();
    const eliteAnnualPriceId = getStripeEliteAnnualPriceId();
    const proAnnualPriceId   = getStripeProAnnualPriceId();
    const teamPriceId        = getStripeTeamPriceId();
    if (eliteAnnualPriceId && stripePriceId === eliteAnnualPriceId) return { tier: "elite_annual", planKey: "elite_annual", planName: "Elite Annual" };
    if (elitePriceId       && stripePriceId === elitePriceId)       return { tier: "elite",        planKey: "elite",        planName: "Elite" };
    if (proAnnualPriceId   && stripePriceId === proAnnualPriceId)   return { tier: "pro_annual",   planKey: "pro_annual",   planName: "Pro Annual" };
    if (teamPriceId        && stripePriceId === teamPriceId)        return { tier: "team",          planKey: "team",         planName: "Team" };
  }
  return { tier: "pro", planKey: "pro", planName: "Pro" };
}

function entitlementsForTier(tier: SubscriptionTier): PaymentEntitlements {
  switch (tier) {
    case "team":         return teamEntitlements();
    case "elite":
    case "elite_annual": return eliteEntitlements();
    case "pro":
    case "pro_annual":   return proEntitlements();
    default:             return getDefaultEntitlements();
  }
}

/**
 * Compute entitlements purely from subscription status + tier.
 * No snapshot/DB input — always deterministic.
 * The stored `entitlementSnapshot` column is an audit record, NOT an input here.
 */
function entitlementsForSubscriptionStatus(
  status: string | null | undefined,
  tier: SubscriptionTier,
): PaymentEntitlements {
  if (status === "active" || status === "trialing") {
    return entitlementsForTier(tier);
  }
  return getDefaultEntitlements();
}

function isActiveSubscription(account: Pick<PaymentsAccountRow, "subscriptionStatus"> | null): boolean {
  if (!account) return false;
  return account.subscriptionStatus === "active" || account.subscriptionStatus === "trialing";
}

/**
 * Derive the account key for a given user.
 * - Per-user billing: "user_<clerkUserId>"
 * - Legacy workspace billing: "workspace"
 */
function accountKeyForUser(clerkUserId?: string | null): string {
  return clerkUserId ? `user_${clerkUserId}` : PAYMENTS_ACCOUNT_KEY;
}

async function ensureBillingAccount(clerkUserId?: string | null): Promise<PaymentsAccountRow> {
  const accountKey = accountKeyForUser(clerkUserId);
  const displayName = clerkUserId ? "User Subscription" : "Workspace Subscription";

  const [existing] = await db
    .select()
    .from(paymentsAccountTable)
    .where(eq(paymentsAccountTable.accountKey, accountKey))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(paymentsAccountTable)
    .values({
      accountKey,
      displayName,
      planKey: getPaymentsPlanKey(),
      planName: getPaymentsPlanName(),
      entitlementSnapshot: getDefaultEntitlements(),
    })
    .returning();
  return created;
}

/** Look up a billing account by Stripe customer ID — used for webhook routing. */
export async function getBillingAccountByStripeCustomer(stripeCustomerId: string): Promise<PaymentsAccountRow | null> {
  const [existing] = await db
    .select()
    .from(paymentsAccountTable)
    .where(eq(paymentsAccountTable.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return existing ?? null;
}

export async function getBillingAccount(clerkUserId?: string | null): Promise<PaymentsAccountRow | null> {
  const accountKey = accountKeyForUser(clerkUserId);
  const [existing] = await db
    .select()
    .from(paymentsAccountTable)
    .where(eq(paymentsAccountTable.accountKey, accountKey))
    .limit(1);
  return existing ?? null;
}

export async function getLatestWebhookEvents(limit = 10): Promise<PaymentWebhookEventRow[]> {
  return db.select().from(paymentWebhookEventsTable).orderBy(desc(paymentWebhookEventsTable.receivedAt)).limit(limit);
}

export async function getPaymentsAccessState(clerkUserId?: string | null): Promise<PaymentAccessState> {
  if (!isPaymentsV2Enabled()) {
    return {
      featureFlagEnabled: false,
      configured: false,
      account: null,
      entitlements: eliteEntitlements(), // dev mode: all unlocked
      active: true,
      tier: "elite",
    };
  }

  const account = await ensureBillingAccount(clerkUserId);
  const tier = tierFromPlanKey(account.planKey);
  // Always compute fresh from tier + status — snapshot is audit only, not a gate input
  const entitlements = entitlementsForSubscriptionStatus(account.subscriptionStatus, tier);
  const active = isActiveSubscription(account);
  return {
    featureFlagEnabled: true,
    configured: true,
    account,
    entitlements,
    active,
    tier: active ? tier : "free",
  };
}


export async function upsertBillingAccountFromSubscription(input: {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  subscriptionStatus: string;
  currentPeriodStartAt: Date | null;
  currentPeriodEndAt: Date | null;
  trialEndAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  lastWebhookEventId: string;
  metadata?: Record<string, unknown>;
  /** Clerk user ID extracted from Stripe subscription metadata — routes webhook to correct user. */
  clerkUserId?: string | null;
}): Promise<PaymentsAccountRow> {
  const { tier, planKey, planName } = resolveTierFromPriceId(input.stripePriceId);
  const updatedEntitlements = entitlementsForSubscriptionStatus(input.subscriptionStatus, tier);

  const sharedUpdate = {
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    subscriptionStatus: input.subscriptionStatus,
    planKey,
    planName,
    currentPeriodStartAt: input.currentPeriodStartAt,
    currentPeriodEndAt: input.currentPeriodEndAt,
    trialEndAt: input.trialEndAt,
    canceledAt: input.canceledAt,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    lastWebhookEventId: input.lastWebhookEventId,
    entitlementSnapshot: updatedEntitlements,
    updatedAt: new Date(),
  };

  // ── 1. Look up by stripeCustomerId (most reliable for webhook routing) ───────
  const [byCustomer] = await db
    .select()
    .from(paymentsAccountTable)
    .where(eq(paymentsAccountTable.stripeCustomerId, input.stripeCustomerId))
    .limit(1);

  if (byCustomer) {
    const [updated] = await db
      .update(paymentsAccountTable)
      .set({
        ...sharedUpdate,
        metadata: { ...(byCustomer.metadata ?? {}), ...(input.metadata ?? {}) },
        accessGrantedAt: isActiveSubscription({ subscriptionStatus: input.subscriptionStatus })
          ? (byCustomer.accessGrantedAt ?? new Date())
          : byCustomer.accessGrantedAt,
      })
      .where(eq(paymentsAccountTable.id, byCustomer.id))
      .returning();
    return updated;
  }

  // ── 2. Look up by account key (new checkout for an existing user record) ─────
  const accountKey = accountKeyForUser(input.clerkUserId);
  const [byAccountKey] = await db
    .select()
    .from(paymentsAccountTable)
    .where(eq(paymentsAccountTable.accountKey, accountKey))
    .limit(1);

  if (byAccountKey) {
    const [updated] = await db
      .update(paymentsAccountTable)
      .set({
        ...sharedUpdate,
        stripeCustomerId: input.stripeCustomerId,
        metadata: { ...(byAccountKey.metadata ?? {}), ...(input.metadata ?? {}) },
        accessGrantedAt: isActiveSubscription({ subscriptionStatus: input.subscriptionStatus })
          ? (byAccountKey.accessGrantedAt ?? new Date())
          : byAccountKey.accessGrantedAt,
      })
      .where(eq(paymentsAccountTable.id, byAccountKey.id))
      .returning();
    return updated;
  }

  // ── 3. Create a new billing account for this user ─────────────────────────────
  const [created] = await db
    .insert(paymentsAccountTable)
    .values({
      accountKey,
      displayName: input.clerkUserId ? "User Subscription" : "Workspace Subscription",
      planKey,
      planName,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePriceId: input.stripePriceId,
      subscriptionStatus: input.subscriptionStatus,
      currentPeriodStartAt: input.currentPeriodStartAt,
      currentPeriodEndAt: input.currentPeriodEndAt,
      trialEndAt: input.trialEndAt,
      canceledAt: input.canceledAt,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      lastWebhookEventId: input.lastWebhookEventId,
      entitlementSnapshot: updatedEntitlements,
      metadata: input.metadata ?? {},
      accessGrantedAt: isActiveSubscription({ subscriptionStatus: input.subscriptionStatus }) ? new Date() : null,
    })
    .returning();
  return created;
}

export async function recordCheckoutSession(input: {
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId: string;
  metadata?: Record<string, unknown>;
  clerkUserId?: string | null;
}): Promise<void> {
  const account = await ensureBillingAccount(input.clerkUserId);
  await db
    .update(paymentsAccountTable)
    .set({
      stripeCustomerId: input.stripeCustomerId ?? account.stripeCustomerId,
      lastCheckoutSessionId: input.stripeCheckoutSessionId,
      metadata: { ...(account.metadata ?? {}), ...(input.metadata ?? {}) },
      updatedAt: new Date(),
    })
    .where(eq(paymentsAccountTable.accountKey, account.accountKey));
}

export async function markWebhookProcessing(eventId: string, payload: Record<string, unknown>, eventType: string, livemode: boolean, customerId?: string, subscriptionId?: string): Promise<boolean> {
  const [inserted] = await db
    .insert(paymentWebhookEventsTable)
    .values({
      stripeEventId: eventId,
      eventType,
      livemode,
      processingStatus: "processing",
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subscriptionId ?? null,
      payload,
    })
    .onConflictDoNothing({ target: paymentWebhookEventsTable.stripeEventId })
    .returning({ id: paymentWebhookEventsTable.id });

  return Boolean(inserted);
}

export async function finalizeWebhookProcessing(input: {
  eventId: string;
  status: "processed" | "failed";
  errorMessage?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}): Promise<void> {
  await db
    .update(paymentWebhookEventsTable)
    .set({
      processingStatus: input.status,
      errorMessage: input.errorMessage ?? null,
      stripeCustomerId: input.stripeCustomerId ?? undefined,
      stripeSubscriptionId: input.stripeSubscriptionId ?? undefined,
      processedAt: new Date(),
    })
    .where(eq(paymentWebhookEventsTable.stripeEventId, input.eventId));
}

export async function getPaymentsEntitlements(clerkUserId?: string | null): Promise<PaymentEntitlements> {
  const state = await getPaymentsAccessState(clerkUserId);
  return state.entitlements;
}

// ── Convenience helpers (workspace-scoped — used by admin/system routes) ──────────────────────────
export async function canUsePredictionHistory(): Promise<boolean> { return (await getPaymentsEntitlements()).predictionHistory; }
export async function canUseWalkForward(): Promise<boolean> { return (await getPaymentsEntitlements()).walkForward; }
export async function canUseShadowReplay(): Promise<boolean> { return (await getPaymentsEntitlements()).shadowReplay; }
export async function canUseOptimizer(): Promise<boolean> { return (await getPaymentsEntitlements()).optimizer; }
export async function canUseCompetitiveBalance(): Promise<boolean> { return (await getPaymentsEntitlements()).competitiveBalance; }
export async function canUseEvidenceReliability(): Promise<boolean> { return (await getPaymentsEntitlements()).evidenceReliability; }
export async function canUseDeveloperAnalytics(): Promise<boolean> { return (await getPaymentsEntitlements()).developerAnalytics; }
export async function canUseEliteRecommendations(): Promise<boolean> { return (await getPaymentsEntitlements()).eliteRecommendations; }
export async function canUseAlerts(): Promise<boolean> { return (await getPaymentsEntitlements()).alerts; }
export async function canUseTeamWorkspace(): Promise<boolean> { return (await getPaymentsEntitlements()).teamWorkspace; }
// Elite-only
export async function canUseFullModelMonitoring(): Promise<boolean> { return (await getPaymentsEntitlements()).fullModelMonitoring; }
export async function canUseConfidenceCalibration(): Promise<boolean> { return (await getPaymentsEntitlements()).confidenceCalibration; }
export async function canUseRecommendationPerformance(): Promise<boolean> { return (await getPaymentsEntitlements()).recommendationPerformance; }
export async function canUseHistoricalModelTrends(): Promise<boolean> { return (await getPaymentsEntitlements()).historicalModelTrends; }
export async function canUseMonteCarlo(): Promise<boolean> { return (await getPaymentsEntitlements()).monteCarlo; }
export async function canUseEliteBadge(): Promise<boolean> { return (await getPaymentsEntitlements()).eliteBadge; }
export async function canUseAdvancedExplanation(): Promise<boolean> { return (await getPaymentsEntitlements()).advancedExplanation; }
export async function canUseConfidenceHistory(): Promise<boolean> { return (await getPaymentsEntitlements()).confidenceHistory; }
