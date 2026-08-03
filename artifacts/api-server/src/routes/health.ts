import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getAllBreakerStatuses } from "../lib/circuitBreaker";
import { db, calibrationModelsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * GET /health/system
 * Returns uptime, memory, and circuit breaker states for all registered providers.
 * Used for monitoring / on-call triage — no auth required (no sensitive data).
 */
router.get("/health/system", (_req, res) => {
  const breakers = getAllBreakerStatuses();
  const anyOpen = breakers.some((b) => b.state === "OPEN");

  res.status(anyOpen ? 503 : 200).json({
    status: anyOpen ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    circuitBreakers: breakers,
  });
});

/**
 * GET /health/model
 * Calibration drift check — returns how old the active calibration model is and
 * whether it looks stale (> 7 days since last refit). Used for alerting.
 */
router.get("/health/model", async (_req, res) => {
  try {
    const [active] = await db
      .select()
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .orderBy(desc(calibrationModelsTable.fittedAt))
      .limit(1);

    if (!active) {
      res.status(200).json({
        status: "no_calibration",
        message: "No active calibration model found. Predictions will use fallback defaults.",
        calibratedAt: null,
        ageHours: null,
        stale: true,
      });
      return;
    }

    const calibratedAt = new Date(active.fittedAt);
    const ageMs = Date.now() - calibratedAt.getTime();
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const STALE_THRESHOLD_HOURS = 7 * 24; // 7 days
    const stale = ageHours > STALE_THRESHOLD_HOURS;

    res.status(stale ? 503 : 200).json({
      status: stale ? "stale" : "ok",
      calibratedAt: calibratedAt.toISOString(),
      ageHours,
      stale,
      method: active.method,
      knotCount: Array.isArray(active.mapping) ? (active.mapping as unknown[]).length : null,
      message: stale
        ? `Calibration model is ${ageHours}h old — a refit is recommended.`
        : `Calibration model is ${ageHours}h old.`,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err instanceof Error ? err.message : "Failed to query calibration model",
    });
  }
});

export default router;
