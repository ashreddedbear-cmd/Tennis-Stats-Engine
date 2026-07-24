import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const minuteBuckets = new Map<string, { windowStart: number; hits: number }>();
const duplicateWindow = new Map<string, number>();

function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.ip ?? "unknown";
}

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = minuteBuckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    minuteBuckets.set(key, { windowStart: now, hits: 1 });
    return false;
  }
  entry.hits += 1;
  return entry.hits > limit;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

router.post("/public/contact", (req, res): void => {
  const ip = clientIp({ ip: req.ip, headers: req.headers as Record<string, unknown> });
  if (rateLimit(`contact:${ip}`, 10, 60_000)) {
    res.status(429).json({ error: "Too many requests. Please retry later." });
    return;
  }

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!name || name.length > 80) {
    res.status(400).json({ error: "Name is required and must be at most 80 characters." });
    return;
  }
  if (!looksLikeEmail(email) || email.length > 254) {
    res.status(400).json({ error: "A valid email is required." });
    return;
  }
  if (message.length < 10 || message.length > 2000) {
    res.status(400).json({ error: "Message must be between 10 and 2000 characters." });
    return;
  }

  logger.info(
    {
      event: "portal2_contact",
      name,
      email,
      ip,
      userAgent: req.get("user-agent") ?? "unknown",
      messageLength: message.length,
    },
    "Portal 2 contact request received",
  );

  res.json({ ok: true });
});

router.post("/public/legal-consent", (req, res): void => {
  const ip = clientIp({ ip: req.ip, headers: req.headers as Record<string, unknown> });
  if (rateLimit(`consent:${ip}`, 30, 60_000)) {
    res.status(429).json({ error: "Too many requests. Please retry later." });
    return;
  }

  const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";
  const agreedTerms = req.body?.agreedTerms === true;
  const agreedPrivacy = req.body?.agreedPrivacy === true;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;

  if (!context || context.length > 40) {
    res.status(400).json({ error: "Consent context is required." });
    return;
  }
  if (!agreedTerms || !agreedPrivacy) {
    res.status(400).json({ error: "Terms and privacy consent are required." });
    return;
  }
  if (email && !looksLikeEmail(email)) {
    res.status(400).json({ error: "Invalid email." });
    return;
  }

  logger.info(
    {
      event: "portal2_legal_consent",
      context,
      email,
      agreedTerms,
      agreedPrivacy,
      ip,
      userAgent: req.get("user-agent") ?? "unknown",
    },
    "Portal 2 legal consent tracked",
  );

  res.json({ ok: true });
});

router.post("/public/account-requests", (req, res): void => {
  const ip = clientIp({ ip: req.ip, headers: req.headers as Record<string, unknown> });
  if (rateLimit(`account-request:${ip}`, 12, 60_000)) {
    res.status(429).json({ error: "Too many requests. Please retry later." });
    return;
  }

  const requestType = typeof req.body?.requestType === "string" ? req.body.requestType.trim() : "";
  if (requestType !== "delete-account" && requestType !== "data-export") {
    res.status(400).json({ error: "Unsupported request type." });
    return;
  }

  const dedupeKey = `${ip}:${requestType}`;
  const now = Date.now();
  const lastSeen = duplicateWindow.get(dedupeKey) ?? 0;
  if (now - lastSeen < 15_000) {
    res.status(429).json({ error: "Duplicate request detected. Please wait before retrying." });
    return;
  }
  duplicateWindow.set(dedupeKey, now);

  logger.info(
    {
      event: "portal2_account_request",
      requestType,
      ip,
      userAgent: req.get("user-agent") ?? "unknown",
    },
    "Portal 2 account request received",
  );

  res.json({ ok: true });
});

export default router;
