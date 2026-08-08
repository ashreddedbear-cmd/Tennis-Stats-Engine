/**
 * Subscriber-facing Model Monitoring endpoints.
 * Requires Clerk session (or admin session) but NO admin key.
 * Returns pre-aggregated, subscriber-safe data — no raw rows, no job triggers.
 */
import { Router } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, evaluationPredictionsTable, calibrationModelsTable } from "@workspace/db";
import { requireClerkUser } from "../middlewares/requireClerkUser";
import { isAdminSessionCookieValid } from "../lib/adminAuth";
import { getPaymentsAccessState } from "../services/payments/entitlementService";
import {
  computeCalibrationBuckets,
  computeUpsetRiskTierMetrics,
  computeDisagreementTierMetrics,
  computeSegmentMetrics,
} from "../services/evaluation/metrics";
import { computeRecommendation, type Recommendation } from "../services/predictionEngine/recommendation";
import { logger } from "../lib/logger";

const router = Router();

// ─── Type alias ─────────────────────────────────────────────────────────────
type EpRow = typeof evaluationPredictionsTable.$inferSelect;
const LIVE_KINDS = ["live", "paper_trade"] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function gradedRows(rows: EpRow[]): EpRow[] {
  return rows.filter(
    (r) => r.status === "graded" && r.includedInAccuracy === true && r.actualWinnerId !== null,
  );
}

function computeAccuracyForRows(rows: EpRow[]): { accuracy: number | null; n: number } {
  const graded = gradedRows(rows);
  if (graded.length === 0) return { accuracy: null, n: 0 };
  const correct = graded.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;
  return { accuracy: Math.round((correct / graded.length) * 1000) / 10, n: graded.length };
}

function deriveRec(row: EpRow): Recommendation | null {
  if (typeof row.calibratedProbability !== "number" || !Number.isFinite(row.calibratedProbability)) return null;
  if (typeof row.modelAgreement !== "string" || typeof row.upsetRiskTier !== "string") return null;
  const snapshot = row.featureSnapshot as { dataQuality?: number; engine?: { tieBreakerApplied?: boolean } } | null;
  const dataQuality = snapshot?.dataQuality ?? null;
  if (typeof dataQuality !== "number") return null;
  const dqLabel =
    dataQuality >= 85 ? "Excellent" : dataQuality >= 65 ? "Strong" : dataQuality >= 45 ? "Acceptable" : dataQuality >= 25 ? "Limited" : "Poor";
  return computeRecommendation(
    row.calibratedProbability,
    dataQuality,
    dqLabel,
    row.modelAgreement as Parameters<typeof computeRecommendation>[3],
    snapshot?.engine?.tieBreakerApplied === true,
  );
}

// ─── Subscriber-visible hardcoded content ────────────────────────────────────
const RECENT_IMPROVEMENTS = [
  {
    title: "4-Fold Evaluation Coverage Expansion",
    date: "2025-03-01",
    area: "Validation",
    explanation:
      "Walk-forward evaluation now covers the full 2021–2025 match corpus, closing a data gap that previously left some calendar years underrepresented in validation.",
    monitoringStatus: "Validated",
  },
  {
    title: "Opponent-Adjusted Form Model",
    date: "2025-02-20",
    area: "Signal Quality",
    explanation:
      "Recent form now uses opponent-adjusted win rates instead of raw streaks, improving predictive value especially for players with irregular schedules.",
    monitoringStatus: "Monitoring",
  },
  {
    title: "Data Quality Threshold Recalibration",
    date: "2025-02-10",
    area: "Data Quality",
    explanation:
      "Thresholds separating High, Medium, and Low data quality were recalibrated against real walk-forward outcomes to better reflect actual model reliability.",
    monitoringStatus: "Validated",
  },
  {
    title: "Tour-Level Confidence Correction",
    date: "2025-02-01",
    area: "Calibration",
    explanation:
      "Removed a legacy confidence discount that caused systematic underconfidence on top-tier matches. Stated probabilities on ATP matches are now better aligned with real outcomes.",
    monitoringStatus: "Validated",
  },
  {
    title: "Training Data Contamination Filter",
    date: "2025-01-20",
    area: "Data Quality",
    explanation:
      "A class of historical rows with incorrectly linked match outcomes was identified and excluded. This improves calibration quality and prevents inflated accuracy estimates.",
    monitoringStatus: "Validated",
  },
  {
    title: "Calibration Method Auto-Selection",
    date: "2025-01-15",
    area: "Calibration",
    explanation:
      "The model now automatically selects the best probability calibration approach (isotonic regression or Platt scaling) based on holdout performance, improving confidence-to-outcome alignment.",
    monitoringStatus: "Validated",
  },
];

const VERSION_HISTORY = [
  {
    version: "v1.0.0",
    status: "Current",
    deployedDate: "2025-03-15",
    validationStatus: "Validated",
    notes:
      "Production release with isotonic calibration auto-selection, cascade exclusion filter, opponent-adjusted form, and full 4-fold evaluation coverage. ATP confidence correction applied.",
  },
  {
    version: "v0.9.0",
    status: "Previous",
    deployedDate: "2024-12-01",
    validationStatus: "Superseded",
    notes:
      "Initial production calibration. Surface Elo, Serve & Return, Recent Form, and Head-to-Head modules active. Basic Platt scaling calibration.",
  },
];

// ─── GET /monitoring/dashboard ───────────────────────────────────────────────
router.get("/monitoring/dashboard", requireClerkUser, async (req, res): Promise<void> => {
  try {
    // Admin session → always grant full elite-tier access
    const isAdmin = isAdminSessionCookieValid(req.signedCookies);
    const clerkUserId = isAdmin ? null : (getAuth(req).userId ?? null);

    const adminAccessState = {
      tier: "elite" as const,
      entitlements: { confidenceCalibration: true, recommendationPerformance: true, historicalModelTrends: true },
    };

    const [rows, calibrationRows, accessState] = await Promise.all([
      db.select().from(evaluationPredictionsTable).where(inArray(evaluationPredictionsTable.runKind, [...LIVE_KINDS])),
      db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1),
      isAdmin
        ? Promise.resolve(adminAccessState)
        : getPaymentsAccessState(clerkUserId).catch((err) => {
            logger.warn({ err }, "Monitoring: entitlement lookup failed — defaulting to free tier (fail-closed)");
            return { tier: "free" as const, entitlements: { confidenceCalibration: false, recommendationPerformance: false, historicalModelTrends: false } };
          }),
    ]);

    const activeCalibration = calibrationRows[0] ?? null;
    const now = new Date();
    const graded = gradedRows(rows);
    const metrics = computeSegmentMetrics(rows);

    const { accuracy: overallAccuracy, n: gradedCount } = computeAccuracyForRows(rows);

    const avgConfidence =
      graded.length > 0
        ? Math.round((graded.reduce((s, r) => s + (r.calibratedProbability ?? 0), 0) / graded.length) * 10) / 10
        : null;

    // Rolling windows
    const mkCutoff = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const acc7d = computeAccuracyForRows(rows.filter((r) => r.scheduledStartAt >= mkCutoff(7)));
    const acc30d = computeAccuracyForRows(rows.filter((r) => r.scheduledStartAt >= mkCutoff(30)));
    const acc90d = computeAccuracyForRows(rows.filter((r) => r.scheduledStartAt >= mkCutoff(90)));

    const latestGradedDate = graded.reduce<Date | null>(
      (latest, r) => (!latest || r.scheduledStartAt > latest ? r.scheduledStartAt : latest),
      null,
    );
    const daysSinceLatest = latestGradedDate ? (now.getTime() - latestGradedDate.getTime()) / 86400000 : Infinity;

    // System status
    let statusLabel = "Operating Normally";
    let statusExplanation =
      "The model is operating within expected performance parameters. Predictions are being generated and evaluated normally.";
    if (gradedCount < 30) {
      statusLabel = "Validation Required";
      statusExplanation =
        "Fewer than 30 live predictions have been graded. Performance metrics will firm up as more real match outcomes are recorded.";
    } else if (daysSinceLatest > 7) {
      statusLabel = "Data Delay";
      statusExplanation =
        "No new graded outcomes in the past 7 days. This may reflect a gap in the tennis schedule or a data pipeline delay.";
    } else if (overallAccuracy !== null && overallAccuracy < 55) {
      statusLabel = "Performance Degraded";
      statusExplanation = `Current live accuracy (${overallAccuracy}%) is below the expected range. The model is under active review.`;
    } else if (
      (overallAccuracy !== null && overallAccuracy < 60) ||
      (metrics.eceCalibrated !== null && metrics.eceCalibrated > 0.05)
    ) {
      statusLabel = "Monitoring Required";
      statusExplanation =
        "Performance is slightly below typical range. This may reflect a challenging run of matches or evolving calibration.";
    }

    // Surface breakdown
    const SURFACES = ["Hard", "Clay", "Grass", "Carpet"];
    const bySurface = SURFACES.map((surface) => {
      const surfRows = rows.filter((r) => r.surface?.toLowerCase().includes(surface.toLowerCase()));
      const { accuracy, n } = computeAccuracyForRows(surfRows);
      const gSurf = gradedRows(surfRows);
      const avgConf =
        gSurf.length > 0
          ? Math.round((gSurf.reduce((s, r) => s + (r.calibratedProbability ?? 0), 0) / gSurf.length) * 10) / 10
          : null;
      return { surface, accuracy, n, avgConfidence: avgConf };
    }).filter((s) => s.n > 0);

    // Level breakdown — group by raw tournamentLevel, top 8 by count
    const levelMap = new Map<string, EpRow[]>();
    for (const row of rows) {
      if (!row.tournamentLevel) continue;
      if (!levelMap.has(row.tournamentLevel)) levelMap.set(row.tournamentLevel, []);
      levelMap.get(row.tournamentLevel)!.push(row);
    }
    const byLevel = [...levelMap.entries()]
      .map(([level, lvlRows]) => {
        const { accuracy, n } = computeAccuracyForRows(lvlRows);
        return { level, accuracy, n };
      })
      .filter((l) => l.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);

    // Recommendation breakdown
    const recGroups = new Map<string, { total: number; correct: number }>();
    for (const row of graded) {
      const rec = deriveRec(row);
      if (!rec) continue;
      if (!recGroups.has(rec)) recGroups.set(rec, { total: 0, correct: 0 });
      const g = recGroups.get(rec)!;
      g.total += 1;
      if (row.actualWinnerId === row.predictedWinnerId) g.correct += 1;
    }
    const byRecommendation = [...recGroups.entries()].map(([recommendation, { total, correct }]) => ({
      recommendation,
      n: total,
      accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : null,
    }));

    // Data quality from featureSnapshot
    const dqValues: number[] = [];
    for (const row of rows) {
      const dq = (row.featureSnapshot as { dataQuality?: number } | null)?.dataQuality;
      if (typeof dq === "number") dqValues.push(dq);
    }
    const avgDQ =
      dqValues.length > 0
        ? Math.round((dqValues.reduce((a, b) => a + b, 0) / dqValues.length) * 10) / 10
        : null;
    const highDQ = dqValues.filter((v) => v >= 65).length;
    const medDQ = dqValues.filter((v) => v >= 45 && v < 65).length;
    const lowDQ = dqValues.filter((v) => v < 45).length;

    const e = accessState.entitlements;
    res.json({
      tier: accessState.tier,
      status: {
        label: statusLabel,
        explanation: statusExplanation,
        modelVersion: "v1.0.0",
        lastUpdated: latestGradedDate?.toISOString() ?? null,
        lastValidation: activeCalibration ? String((activeCalibration as Record<string, unknown>).createdAt ?? "") || null : null,
        dataCoverageStart: metrics.dateRangeStart,
        dataCoverageEnd: metrics.dateRangeEnd,
      },
      performance: {
        overallAccuracy,
        predictionsEvaluated: gradedCount,
        logLoss: metrics.logLoss,
        brierScore: metrics.brier,
        ece: metrics.eceCalibrated,
        avgConfidence,
        accuracy7d: acc7d.accuracy,
        count7d: acc7d.n,
        accuracy30d: acc30d.accuracy,
        count30d: acc30d.n,
        accuracy90d: acc90d.accuracy,
        count90d: acc90d.n,
      },
      bySurface,
      byLevel,
      byAgreement: computeDisagreementTierMetrics(rows),
      byUpsetRisk: computeUpsetRiskTierMetrics(rows),
      dataQuality: {
        avgScore: avgDQ,
        highCount: highDQ,
        medCount: medDQ,
        lowCount: lowDQ,
        total: dqValues.length,
      },
      // ── Elite-gated sections: empty payload for Pro/free callers ──────────
      calibration: e.confidenceCalibration ? computeCalibrationBuckets(rows) : [],
      byRecommendation: e.recommendationPerformance ? byRecommendation : [],
      improvements: e.historicalModelTrends ? RECENT_IMPROVEMENTS : [],
      versionHistory: e.historicalModelTrends ? VERSION_HISTORY : [],
    });
  } catch (err) {
    logger.error({ err }, "Monitoring dashboard error");
    res.status(500).json({ error: "Failed to load monitoring data. Please try again later." });
  }
});

// ─── GET /monitoring/accuracy-trend ──────────────────────────────────────────
router.get("/monitoring/accuracy-trend", requireClerkUser, async (req, res): Promise<void> => {
  try {
    const period = (req.query.period as string) ?? "30d";
    const days = period === "7d" ? 7 : period === "90d" ? 90 : period === "1yr" ? 365 : 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await db.execute(sql`
      SELECT
        date_trunc('day', scheduled_start_at AT TIME ZONE 'UTC')::date AS day,
        count(*) FILTER (WHERE status = 'graded' AND included_in_accuracy = true)::int AS graded,
        count(*) FILTER (WHERE status = 'graded' AND included_in_accuracy = true AND actual_winner_id = predicted_winner_id)::int AS correct
      FROM evaluation_predictions
      WHERE run_kind IN ('live', 'paper_trade')
        AND scheduled_start_at >= ${cutoff}
      GROUP BY day
      ORDER BY day ASC
    `);

    const points = (result.rows as Array<{ day: unknown; graded: unknown; correct: unknown }>).map((row) => {
      const graded = Number(row.graded);
      const correct = Number(row.correct);
      return {
        date: String(row.day).slice(0, 10),
        count: graded,
        accuracy: graded > 0 ? Math.round((correct / graded) * 1000) / 10 : null,
      };
    });

    res.json({ points });
  } catch (err) {
    logger.error({ err }, "Monitoring accuracy-trend error");
    res.status(500).json({ error: "Failed to load trend data." });
  }
});

// ─── GET /monitoring/agreement-accuracy ──────────────────────────────────────
// Lightweight aggregation for the HighDisagreement caution icon tooltip on the prediction card.
// Returns accuracy % and sample count by modelAgreement category (historical_test rows).
router.get("/monitoring/agreement-accuracy", requireClerkUser, async (_req, res): Promise<void> => {
  try {
    const result = await db.execute<{ model_agreement: string; n: string; accuracy: string }>(
      sql`
        SELECT
          model_agreement,
          COUNT(*)::int                                                          AS n,
          ROUND(
            100.0 * SUM(CASE WHEN actual_winner_id = predicted_winner_id THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0),
            2
          )::float                                                               AS accuracy
        FROM evaluation_predictions
        WHERE run_kind  = 'historical_test'
          AND status    = 'graded'
          AND included_in_accuracy = true
          AND model_agreement IS NOT NULL
        GROUP BY model_agreement
        ORDER BY model_agreement
      `,
    );
    const stats = Object.fromEntries(
      result.rows.map((r) => [r.model_agreement, { n: Number(r.n), accuracy: Number(r.accuracy) }]),
    );
    res.json({ stats });
  } catch (err) {
    logger.error({ err }, "Monitoring agreement-accuracy error");
    res.status(500).json({ error: "Failed to load agreement accuracy data." });
  }
});

export default router;
