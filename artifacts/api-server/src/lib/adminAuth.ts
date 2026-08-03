import type { Request, Response, NextFunction } from "express";

/**
 * Task #143: single-owner access gate. There are no user accounts -- the owner logs in once
 * with a shared access key (ADMIN_ACCESS_KEY) via POST /api/auth/login, which sets this signed,
 * httpOnly cookie. `requireAdmin` then protects every data-mutating and job-triggering route;
 * plain browsing/read routes stay open so the app's own UI never needs to re-prompt mid-session.
 */
export const ADMIN_SESSION_COOKIE = "admin_session";
const ADMIN_SESSION_VALUE = "ok";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getOwnerAutoLoginToken(): string | undefined {
  // Dedicated token for the owner-only magic-link login endpoint.
  // MUST be a separate secret from ADMIN_ACCESS_KEY: the magic-link token travels in a URL
  // query string, which exposes it through browser history, server access logs, and proxy logs.
  // Using the long-lived admin key as a URL parameter would compromise it permanently.
  // Callers who haven't set a dedicated token get a 403 ("not configured") rather than
  // a silent fallback to the admin key.
  const candidates = [
    process.env.OWNER_AUTO_LOGIN_TOKEN,
    process.env.OWNER_MAGIC_LINK_TOKEN,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function getAdminAccessKey(): string | undefined {
  // Accept a few common secret-name variants across hosts (Replit/Codespaces/etc.).
  // The first non-empty value wins.
  const candidates = [
    process.env.ADMIN_ACCESS_KEY,
    process.env.ADMIN_ACCESSKEY,
    process.env.ADMIN_KEY,
    process.env.ADMIN_PASSWORD,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function isAdminSessionCookieValid(signedCookies: Record<string, unknown> | undefined): boolean {
  return signedCookies?.[ADMIN_SESSION_COOKIE] === ADMIN_SESSION_VALUE;
}

export function isOwnerAutoAuthenticated(req: Request): boolean {
  // Owner-only bypass for Replit-hosted access.
  // Enable with OWNER_REPLIT_AUTO_AUTH=true and set at least one identity env var.
  if (!isTruthyEnv(process.env.OWNER_REPLIT_AUTO_AUTH)) return false;

  const configuredOwnerId = process.env.OWNER_REPLIT_USER_ID?.trim();
  const configuredOwnerName = process.env.OWNER_REPLIT_USER_NAME?.trim().toLowerCase();
  if (!configuredOwnerId && !configuredOwnerName) return false;

  const requestOwnerId = readHeaderValue(req.headers["x-replit-user-id"] as string | string[] | undefined);
  const requestOwnerName = readHeaderValue(req.headers["x-replit-user-name"] as string | string[] | undefined)?.toLowerCase();

  if (configuredOwnerId && requestOwnerId !== configuredOwnerId) return false;
  if (configuredOwnerName && requestOwnerName !== configuredOwnerName) return false;

  if (configuredOwnerId && requestOwnerId === configuredOwnerId) return true;
  if (configuredOwnerName && requestOwnerName === configuredOwnerName) return true;
  return false;
}

export function setAdminSessionCookie(res: Response): void {
  res.cookie(ADMIN_SESSION_COOKIE, ADMIN_SESSION_VALUE, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAge: THIRTY_DAYS_MS,
  });
}

export function clearAdminSessionCookie(res: Response): void {
  res.clearCookie(ADMIN_SESSION_COOKIE);
}

/**
 * Protects data-changing and job-triggering routes. If ADMIN_ACCESS_KEY isn't configured yet,
 * fails closed (403) rather than silently leaving the route open -- an unset secret should never
 * be mistaken for "no auth needed here".
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ownerAutoAuthenticated = isOwnerAutoAuthenticated(req);

  if (!getAdminAccessKey() && !ownerAutoAuthenticated) {
    res.status(403).json({ error: "Admin access key is not configured on the server" });
    return;
  }

  if (!ownerAutoAuthenticated && !isAdminSessionCookieValid(req.signedCookies)) {
    res.status(401).json({ error: "Login required" });
    return;
  }

  next();
}
