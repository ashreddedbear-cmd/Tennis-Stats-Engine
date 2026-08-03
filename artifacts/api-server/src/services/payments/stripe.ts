import crypto from "node:crypto";
import { getStripePriceId, getStripeElitePriceId, getStripeProAnnualPriceId, getStripeEliteAnnualPriceId, getStripeTeamPriceId, getStripeSecretKey, getStripeWebhookSecret } from "./config";

interface StripeRequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  form?: Record<string, string | number | boolean | null | undefined>;
}

function assertStripeSecretKey(): string {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("sk_live_")) {
    throw new Error("Stripe secret key must start with sk_test_ or sk_live_");
  }
  return secretKey;
}

async function stripeRequest<T>(options: StripeRequestOptions): Promise<T> {
  const secretKey = assertStripeSecretKey();
  const url = `https://api.stripe.com${options.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
  };
  const init: RequestInit = { method: options.method, headers };

  if (options.form) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) {
      if (value === undefined || value === null) continue;
      form.set(key, String(value));
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = form.toString();
  }

  const response = await fetch(url, init);
  const responseText = await response.text();
  let payload: T & { error?: { message?: string } };
  try {
    payload = (responseText ? JSON.parse(responseText) : {}) as T & { error?: { message?: string } };
  } catch {
    payload = { error: { message: responseText } } as T & { error?: { message?: string } };
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `Stripe request failed with HTTP ${response.status}`);
  }
  return payload as T;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  subscription: string | null;
  payment_status: string | null;
  status: string | null;
}

export interface StripeBillingPortalSession {
  id: string;
  url: string;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  priceId: string | null;
  current_period_start: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  metadata: Record<string, string>;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: {
    object: Record<string, unknown>;
  };
}

function toIsoTimestamp(epochSeconds: number | null | undefined): Date | null {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return null;
  return new Date(epochSeconds * 1000);
}

export type StripePlanKey = "pro" | "pro_annual" | "elite" | "elite_annual" | "team";

export function resolveStripePriceId(): string {
  const priceId = getStripePriceId();
  if (!priceId) {
    throw new Error("STRIPE_PRICE_ID must be configured when PAYMENTS_V2_ENABLED is true");
  }
  return priceId;
}

export function resolveStripeElitePriceId(): string {
  const priceId = getStripeElitePriceId();
  if (!priceId) {
    throw new Error("STRIPE_ELITE_PRICE_ID must be configured to offer the Elite plan");
  }
  return priceId;
}

export function resolveStripeProAnnualPriceId(): string {
  const priceId = getStripeProAnnualPriceId();
  if (!priceId) throw new Error("STRIPE_PRO_ANNUAL_PRICE_ID must be configured to offer the Pro Annual plan");
  return priceId;
}

export function resolveStripeEliteAnnualPriceId(): string {
  const priceId = getStripeEliteAnnualPriceId();
  if (!priceId) throw new Error("Elite Annual plan is not yet available. Please choose the monthly Elite plan or contact support.");
  return priceId;
}

export function resolveStripeTeamPriceId(): string {
  const priceId = getStripeTeamPriceId();
  if (!priceId) throw new Error("STRIPE_TEAM_PRICE_ID must be configured to offer the Team plan");
  return priceId;
}

function resolvePriceIdForPlan(plan: StripePlanKey): string {
  switch (plan) {
    case "elite":        return resolveStripeElitePriceId();
    case "elite_annual": return resolveStripeEliteAnnualPriceId();
    case "pro_annual":   return resolveStripeProAnnualPriceId();
    case "team":         return resolveStripeTeamPriceId();
    default:             return resolveStripePriceId(); // "pro"
  }
}

export async function createStripeCheckoutSession(form: {
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
  customerEmail?: string | null;
  accountKey: string;
  planKey: string;
  planName: string;
  plan?: StripePlanKey;
  /** Clerk user ID — embedded in metadata so webhooks can route to the correct per-user billing record. */
  clerkUserId?: string | null;
}): Promise<StripeCheckoutSession> {
  const priceId = resolvePriceIdForPlan(form.plan ?? "pro");
  return stripeRequest<StripeCheckoutSession>({
    method: "POST",
    path: "/v1/checkout/sessions",
    form: {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      success_url: form.successUrl,
      cancel_url: form.cancelUrl,
      client_reference_id: form.accountKey,
      "subscription_data[metadata][accountKey]": form.accountKey,
      "subscription_data[metadata][planKey]": form.planKey,
      "subscription_data[metadata][planName]": form.planName,
      ...(form.clerkUserId ? { "subscription_data[metadata][clerkUserId]": form.clerkUserId } : {}),
      "metadata[accountKey]": form.accountKey,
      "metadata[planKey]": form.planKey,
      "metadata[planName]": form.planName,
      ...(form.clerkUserId ? { "metadata[clerkUserId]": form.clerkUserId } : {}),
      ...(form.customerId ? { customer: form.customerId } : {}),
      ...(form.customerEmail ? { customer_email: form.customerEmail } : {}),
    },
  });
}

export async function createStripeBillingPortalSession(form: { customerId: string; returnUrl: string }): Promise<StripeBillingPortalSession> {
  return stripeRequest<StripeBillingPortalSession>({
    method: "POST",
    path: "/v1/billing_portal/sessions",
    form: {
      customer: form.customerId,
      return_url: form.returnUrl,
    },
  });
}

export async function retrieveStripeSubscription(subscriptionId: string): Promise<StripeSubscription> {
  const payload = await stripeRequest<Record<string, unknown>>({
    method: "GET",
    path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
  });

  const items = payload["items"] as { data?: Array<Record<string, unknown>> } | undefined;
  const firstItem = items?.data?.[0];
  const firstPrice = firstItem && typeof firstItem["price"] === "object" && firstItem["price"] !== null ? (firstItem["price"] as Record<string, unknown>) : null;

  return {
    id: String(payload["id"] ?? subscriptionId),
    customer: String(payload["customer"] ?? ""),
    status: String(payload["status"] ?? "unknown"),
    priceId: typeof firstPrice?.id === "string" ? firstPrice.id : null,
    current_period_start: typeof payload["current_period_start"] === "number" ? (payload["current_period_start"] as number) : null,
    current_period_end: typeof payload["current_period_end"] === "number" ? (payload["current_period_end"] as number) : null,
    trial_end: typeof payload["trial_end"] === "number" ? (payload["trial_end"] as number) : null,
    cancel_at_period_end: payload["cancel_at_period_end"] === true,
    canceled_at: typeof payload["canceled_at"] === "number" ? (payload["canceled_at"] as number) : null,
    metadata: typeof payload["metadata"] === "object" && payload["metadata"] !== null ? (payload["metadata"] as Record<string, string>) : {},
  };
}

export function verifyStripeWebhookSignature(params: {
  rawBody: Buffer;
  signatureHeader: string | string[] | undefined;
  timestampToleranceSeconds?: number;
}): void {
  const secret = getStripeWebhookSecret();
  if (!secret) {
    throw new Error("Stripe webhook secret is not configured");
  }
  if (!secret.startsWith("whsec_")) {
    throw new Error("Stripe webhook secret must start with whsec_");
  }

  const headerValue = Array.isArray(params.signatureHeader) ? params.signatureHeader[0] : params.signatureHeader;
  if (!headerValue) {
    throw new Error("Missing Stripe signature header");
  }

  const parts = new Map<string, string[]>();
  for (const piece of headerValue.split(",")) {
    const [key, value] = piece.split("=");
    if (!key || !value) continue;
    const existing = parts.get(key) ?? [];
    existing.push(value);
    parts.set(key, existing);
  }

  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) {
    throw new Error("Invalid Stripe signature header");
  }

  const signedPayload = `${timestamp}.${params.rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const verified = signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
  });

  if (!verified) {
    throw new Error("Stripe webhook signature verification failed");
  }

  const now = Math.floor(Date.now() / 1000);
  const timestampSeconds = Number(timestamp);
  const tolerance = params.timestampToleranceSeconds ?? 300;
  if (!Number.isFinite(timestampSeconds) || Math.abs(now - timestampSeconds) > tolerance) {
    throw new Error("Stripe webhook timestamp is outside the allowed tolerance");
  }
}

export function parseStripeWebhookEvent(rawBody: Buffer): StripeWebhookEvent {
  const parsed = JSON.parse(rawBody.toString("utf8")) as StripeWebhookEvent;
  if (!parsed || typeof parsed.id !== "string" || typeof parsed.type !== "string" || typeof parsed.data !== "object") {
    throw new Error("Invalid Stripe webhook payload");
  }
  return parsed;
}

export function toDate(epochSeconds: number | null | undefined): Date | null {
  return toIsoTimestamp(epochSeconds);
}