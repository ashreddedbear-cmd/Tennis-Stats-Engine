import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { requireAdmin } from "../lib/adminAuth";
import { requireClerkUser } from "../middlewares/requireClerkUser";
import { isAdminSessionCookieValid } from "../lib/adminAuth";
import { buildPaymentsStatus, createBillingPortal, createCheckoutSession, handleStripeWebhook } from "../services/payments/paymentsService";
import {
  CreateBillingPortalSessionBody,
  CreateBillingPortalSessionResponse,
  CreatePaymentsCheckoutSessionBody,
  CreatePaymentsCheckoutSessionResponse,
  GetPaymentsStatusResponse,
  PaymentsWebhookResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Admin-only: workspace-wide billing status for the admin panel.
 * Regular users should use GET /payments/me/status instead.
 */
router.get("/payments/status", requireAdmin, async (_req, res): Promise<void> => {
  const status = await buildPaymentsStatus(null); // workspace-scoped (no clerkUserId)
  res.json(GetPaymentsStatusResponse.parse(status));
});

/**
 * Authenticated user: returns the signed-in user's own billing status.
 * For admin cookie users (no Clerk session), falls back to workspace billing.
 */
router.get("/payments/me/status", requireClerkUser, async (req, res): Promise<void> => {
  // Admin cookie users have no Clerk userId — they see workspace-level billing
  const clerkUserId = isAdminSessionCookieValid(req.signedCookies)
    ? null
    : (getAuth(req)?.userId ?? null);
  const status = await buildPaymentsStatus(clerkUserId);
  res.json(GetPaymentsStatusResponse.parse(status));
});

/**
 * Start a Stripe checkout session for the signed-in user.
 * Available to any authenticated user (Clerk or admin cookie).
 */
router.post("/payments/checkout-session", requireClerkUser, async (req, res): Promise<void> => {
  const parsed = CreatePaymentsCheckoutSessionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const clerkUserId = isAdminSessionCookieValid(req.signedCookies)
    ? null
    : (getAuth(req)?.userId ?? null);

  try {
    const session = await createCheckoutSession(req, parsed.data, clerkUserId);
    res.json(CreatePaymentsCheckoutSessionResponse.parse({ sessionId: session.id, url: session.url }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create checkout session" });
  }
});

/**
 * Open the Stripe Billing Portal for the signed-in user's subscription.
 * Available to any authenticated user (Clerk or admin cookie).
 */
router.post("/payments/billing-portal-session", requireClerkUser, async (req, res): Promise<void> => {
  const parsed = CreateBillingPortalSessionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const clerkUserId = isAdminSessionCookieValid(req.signedCookies)
    ? null
    : (getAuth(req)?.userId ?? null);

  try {
    const session = await createBillingPortal(req, parsed.data, clerkUserId);
    res.json(CreateBillingPortalSessionResponse.parse({ url: session.url }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create billing portal session" });
  }
});

router.post("/payments/webhook", async (req, res): Promise<void> => {
  try {
    if (!req.rawBody) {
      res.status(400).json({ error: "Missing raw request body" });
      return;
    }

    const result = await handleStripeWebhook(req.rawBody, req.header("stripe-signature"));
    res.json(PaymentsWebhookResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Stripe webhook processing failed" });
  }
});

export default router;
