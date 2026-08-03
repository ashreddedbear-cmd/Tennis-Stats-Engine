export const PAYMENTS_ACCOUNT_KEY = "workspace";

/** Payments V2 is unconditionally live — Stripe is fully configured. */
export function isPaymentsV2Enabled(): boolean {
  return true;
}

export function getStripeSecretKey(): string | null {
  const value = process.env.STRIPE_SECRET_KEY?.trim();
  return value ? value : null;
}

export function getStripeWebhookSecret(): string | null {
  const value = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return value ? value : null;
}

export function getStripePriceId(): string | null {
  const value = process.env.STRIPE_PRICE_ID?.trim();
  return value ? value : null;
}

export function getStripeElitePriceId(): string | null {
  const value = process.env.STRIPE_ELITE_PRICE_ID?.trim();
  return value ? value : null;
}

export function getStripeProAnnualPriceId(): string | null {
  const value = process.env.STRIPE_PRO_ANNUAL_PRICE_ID?.trim();
  return value ? value : null;
}

export function getStripeEliteAnnualPriceId(): string | null {
  const value = process.env.STRIPE_ELITE_ANNUAL_PRICE_ID?.trim();
  return value ? value : null;
}

export function getStripeTeamPriceId(): string | null {
  const value = process.env.STRIPE_TEAM_PRICE_ID?.trim();
  return value ? value : null;
}

export function getPaymentsPlanName(): string {
  return process.env.PAYMENTS_PLAN_NAME?.trim() || "Pro";
}

export function getPaymentsPlanKey(): string {
  return process.env.PAYMENTS_PLAN_KEY?.trim() || "pro";
}

export function getPaymentsPublicBaseUrlFromRequest(req: { protocol?: string; get(name: string): string | undefined }): string | null {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host");
  const protocol = forwardedProto || req.protocol || "https";
  if (!host) return null;
  return `${protocol}://${host}`.replace(/\/$/, "");
}