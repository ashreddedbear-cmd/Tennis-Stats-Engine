import { Router, type IRouter } from "express";
import { AdminLoginBody, AdminLoginResponse, GetAdminAuthStatusResponse, AdminLogoutResponse } from "@workspace/api-zod";
import {
  getAdminAccessKey,
  getOwnerAutoLoginToken,
  isOwnerAutoAuthenticated,
  isAdminSessionCookieValid,
  setAdminSessionCookie,
  clearAdminSessionCookie,
} from "../lib/adminAuth";
import { authLimiter } from "../middlewares/rateLimiter";
import { auditLog } from "../middlewares/auditLog";

const router: IRouter = Router();

function getSafeRedirectPath(input: unknown): string {
  if (typeof input !== "string") return "/app";
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return "/app";
  if (trimmed.startsWith("//")) return "/app";
  return trimmed;
}

/**
 * GET /auth/owner-auto-login?token=<token>[&next=/some/path]
 *
 * Bookmarkable magic-link for the owner. Validates the token against
 * OWNER_AUTO_LOGIN_TOKEN (or OWNER_MAGIC_LINK_TOKEN). The endpoint returns 403
 * when neither dedicated token env var is set — it does NOT fall back to
 * ADMIN_ACCESS_KEY, which must never appear in a URL query string.
 *
 * Works from any browser / device — not tied to Replit iframe headers.
 * The Replit-header path (isOwnerAutoAuthenticated) still works inside
 * the Replit preview; this route is additive, not a replacement.
 */
router.get("/auth/owner-auto-login", (req, res): void => {
  const configuredToken = getOwnerAutoLoginToken();
  if (!configuredToken) {
    res.status(403).json({ error: "Owner auto-login is not configured on the server" });
    return;
  }

  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!token || token !== configuredToken) {
    res.status(401).json({ error: "Invalid owner auto-login token" });
    return;
  }

  setAdminSessionCookie(res);
  const next = getSafeRedirectPath(req.query.next);
  res.redirect(302, next);
});

router.get("/auth/status", (req, res): void => {
  const authenticated = isAdminSessionCookieValid(req.signedCookies) || isOwnerAutoAuthenticated(req);
  // Single-owner system: authenticated users are owners
  const role = authenticated ? 'owner' : 'user';
  res.json({ 
    authenticated, 
    role,
    // Include permission hints for frontend to know capability levels
    permissions: authenticated ? {
      canRunAudits: true,
      canViewLogs: true,
      canRetrySafeJobs: true,
      canManageAlerts: true,
      canRunPerformanceTests: true,
      canRunDestructiveRollback: true,
      canRunDestructiveRepairs: true,
    } : {
      canRunAudits: false,
      canViewLogs: false,
      canRetrySafeJobs: false,
      canManageAlerts: false,
      canRunPerformanceTests: false,
      canRunDestructiveRollback: false,
      canRunDestructiveRepairs: false,
    }
  });
});

router.post("/auth/login", authLimiter, auditLog("admin.login"), (req, res): void => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const configuredKey = getAdminAccessKey();
  if (!configuredKey) {
    res.status(403).json({ error: "Admin access key is not configured on the server" });
    return;
  }

  if (parsed.data.accessKey !== configuredKey) {
    res.status(401).json({ error: "Incorrect access key" });
    return;
  }

  setAdminSessionCookie(res);
  res.json(AdminLoginResponse.parse({ authenticated: true }));
});

router.post("/auth/logout", (_req, res): void => {
  clearAdminSessionCookie(res);
  res.json(AdminLogoutResponse.parse({ authenticated: false }));
});

export default router;
