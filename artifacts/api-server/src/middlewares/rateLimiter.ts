/**
 * Rate limiting middleware using express-rate-limit.
 *
 * Tiers:
 *   - authLimiter:        Login / admin-session endpoints (10 req / 15 min per IP)
 *   - predictionLimiter:  POST /api/predictions (100 req / 5 min per user or IP)
 *   - generalApiLimiter:  Everything else under /api (200 req / 1 min per IP)
 *   - adminLimiter:       Admin routes (30 req / 1 min per IP — logged, not hard-blocked)
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { logger } from '../lib/logger';

function jsonHandler(message: string) {
  return (_req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many requests', detail: message });
  };
}

/** POST /api/auth/login — brute-force protection */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Too many login attempts. Please wait 15 minutes and try again.'),
});

/** POST /api/predictions — per-user (Clerk userId header) or per-IP */
export const predictionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 100, // accommodates bulk batches: up to 40 screenshots × 2+ matchups each
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // validate: false on keyGeneratorIpFallback — we intentionally prefer the Clerk userId as a
  // more accurate key; the IP fallback is only reached for unauthenticated calls which are already
  // blocked by requireClerkUser. IPv6 collapsing risk is accepted for that secondary fallback.
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const userId = (req as Request & { auth?: { userId?: string } }).auth?.userId;
    return userId ?? req.ip ?? 'unknown';
  },
  handler: jsonHandler('Prediction limit reached. Please wait a few minutes before running another.'),
});

/** Broad API limiter — catches scraping / abuse on any /api route */
export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && req.path.startsWith('/health'),
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'General API rate limit hit');
    res.status(429).json({ error: 'Too many requests', detail: 'Slow down and try again shortly.' });
  },
});

/** Admin routes — stricter, always logged */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Admin route rate limit hit');
    res.status(429).json({ error: 'Too many requests', detail: 'Admin rate limit exceeded.' });
  },
});
