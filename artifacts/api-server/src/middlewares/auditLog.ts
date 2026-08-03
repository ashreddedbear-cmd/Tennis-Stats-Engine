/**
 * Audit logging middleware for sensitive routes.
 *
 * Writes a structured pino log entry on every request to admin/sensitive paths.
 * Log fields:
 *   - auditEvent: fixed label for log-aggregation filtering
 *   - method, path, status
 *   - userId (Clerk) or adminSession (cookie present)
 *   - ip
 *   - durationMs
 *
 * Mount AFTER auth middleware so userId is available, BEFORE the route handler.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

export function auditLog(eventLabel: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    // Log after response is finished so we capture status code
    res.on('finish', () => {
      const userId =
        (req as Request & { auth?: { userId?: string | null } }).auth?.userId ?? null;
      const hasAdminSession = !!(req.signedCookies as Record<string, unknown>)?.admin_session;

      logger.info(
        {
          auditEvent: eventLabel,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          userId,
          adminSession: hasAdminSession,
          ip: req.ip,
          durationMs: Date.now() - start,
        },
        `AUDIT: ${eventLabel}`,
      );
    });

    next();
  };
}

/** Convenience: logs any write (POST/PUT/PATCH/DELETE) to admin routes */
export function auditAdminWrite() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return auditLog(`admin.${req.method.toLowerCase()}.${req.path.replace(/\//g, '_')}`)(
        req,
        res,
        next,
      );
    }
    next();
  };
}
