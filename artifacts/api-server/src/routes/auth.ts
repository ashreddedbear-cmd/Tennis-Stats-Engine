import { Router, type IRouter } from "express";
import { AdminLoginBody, AdminLoginResponse, GetAdminAuthStatusResponse, AdminLogoutResponse } from "@workspace/api-zod";
import {
  getAdminAccessKey,
  isAdminSessionCookieValid,
  setAdminSessionCookie,
  clearAdminSessionCookie,
} from "../lib/adminAuth";

const router: IRouter = Router();

router.get("/auth/status", (req, res): void => {
  const authenticated = isAdminSessionCookieValid(req.signedCookies);
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

router.post("/auth/login", (req, res): void => {
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
