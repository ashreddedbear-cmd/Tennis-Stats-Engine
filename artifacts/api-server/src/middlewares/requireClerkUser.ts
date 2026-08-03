import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { isAdminSessionCookieValid } from "../lib/adminAuth";

/**
 * Requires a valid Clerk session OR a valid admin session cookie.
 * Admin users bypass Clerk entirely — they must still be able to reach
 * prediction and history routes without a Clerk JWT.
 */
export const requireClerkUser = (req: Request, res: Response, next: NextFunction): void => {
  // Admin session bypasses Clerk auth — the owner uses a signed cookie instead.
  if (isAdminSessionCookieValid(req.signedCookies)) {
    next();
    return;
  }
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
