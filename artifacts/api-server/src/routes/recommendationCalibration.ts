/**
 * Admin-only routes for the Evidence Confidence Score (v2 recommendation) calibration audit.
 *
 * GET  /api/admin/recommendation-calibration/audit
 *   Per-category stats from graded predictions. Returns accuracy, avg data quality, avg predicted
 *   probability, and sample counts for both the original recommendation and the shadow-replayed v2
 *   recommendation_v2. Also returns a migration matrix (old → new category counts).
 *
 * POST /api/admin/recommendation-calibration/recompute
 *   Shadow replay: for every graded prediction that has engine JSONB, extracts the inputs needed
 *   by computeRecommendation and writes recommendation_v2, recommendation_version, and
 *   recommendation_changed. Idempotent — safe to re-run; overwrites any previous v2 values.
 *   Returns { processed, skipped, changed } counts.
 */

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../lib/adminAuth";
import { computeRecommendation } from "../services/predictionEngine/recommendation";
import type { DataQualityLabel } from "../services/predictionEngine/dataQuality";
import type { ModelAgreement } from "../services/predictionEngine/ensemble";

const router = Router();

// ── GET /api/admin/recommendation-calibration/audit ──────────────────────────

router.get("/api/admin/recommendation-calibration/audit", requireAdmin, async (req, res) => {
  try {
    // Per old-category stats (always available — uses the stored recommendation column)
    const oldStats = await db.execute(sql`
      SELECT
        recommendation                                                              AS category,
        COUNT(*)::int                                                              AS total,
        SUM(CASE WHEN actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int        AS graded,
        SUM(CASE WHEN actual_winner_id = predicted_winner_id AND actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int AS wins,
        ROUND(AVG(data_quality)::numeric, 1)                                      AS avg_dq,
        ROUND(AVG(CASE WHEN actual_winner_id IS NOT NULL THEN calibrated_probability END)::numeric, 1) AS avg_prob
      FROM predictions
      GROUP BY recommendation
      ORDER BY recommendation
    `);

    // Per v2-category stats (only where shadow replay has run)
    const v2Stats = await db.execute(sql`
      SELECT
        recommendation_v2                                                          AS category,
        COUNT(*)::int                                                              AS total,
        SUM(CASE WHEN actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int        AS graded,
        SUM(CASE WHEN actual_winner_id = predicted_winner_id AND actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int AS wins,
        ROUND(AVG(data_quality)::numeric, 1)                                      AS avg_dq,
        ROUND(AVG(CASE WHEN actual_winner_id IS NOT NULL THEN calibrated_probability END)::numeric, 1) AS avg_prob
      FROM predictions
      WHERE recommendation_v2 IS NOT NULL
      GROUP BY recommendation_v2
      ORDER BY recommendation_v2
    `);

    // Migration matrix: old → new (graded only for signal quality)
    const matrix = await db.execute(sql`
      SELECT
        recommendation          AS old_category,
        recommendation_v2       AS new_category,
        COUNT(*)::int           AS count,
        SUM(CASE WHEN actual_winner_id = predicted_winner_id AND actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int AS wins,
        SUM(CASE WHEN actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int AS graded
      FROM predictions
      WHERE recommendation_v2 IS NOT NULL
      GROUP BY recommendation, recommendation_v2
      ORDER BY recommendation, recommendation_v2
    `);

    // Summary counts
    const summary = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                              AS total,
        SUM(CASE WHEN actual_winner_id IS NOT NULL THEN 1 ELSE 0 END)::int        AS graded,
        SUM(CASE WHEN recommendation_v2 IS NOT NULL THEN 1 ELSE 0 END)::int       AS v2_computed,
        SUM(CASE WHEN recommendation_changed = TRUE THEN 1 ELSE 0 END)::int       AS changed,
        MAX(recommendation_changed_at)                                             AS last_recomputed_at
      FROM predictions
    `);

    res.json({
      ok: true,
      summary: summary.rows[0] ?? {},
      oldStats: oldStats.rows,
      v2Stats: v2Stats.rows,
      matrix: matrix.rows,
    });
  } catch (err) {
    console.error("[recommendation-calibration/audit]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── POST /api/admin/recommendation-calibration/recompute ─────────────────────

router.post("/api/admin/recommendation-calibration/recompute", requireAdmin, async (req, res) => {
  try {
    // Fetch all predictions that have engine JSONB (no actual_winner_id filter — replay all rows,
    // not just graded ones, so the v2 column is ready when grading happens later).
    const rows = await db.execute(sql`
      SELECT
        id,
        recommendation,
        calibrated_probability,
        data_quality,
        data_quality_label,
        engine
      FROM predictions
      WHERE engine IS NOT NULL
    `);

    let processed = 0;
    let skipped = 0;
    let changed = 0;

    for (const row of rows.rows) {
      try {
        const engine = row.engine as Record<string, unknown>;

        // Extract modelAgreement from stored engine JSONB
        const modelAgreement = (engine.modelAgreement as string | undefined) ?? null;
        if (!modelAgreement) {
          skipped++;
          continue;
        }

        // Extract tieBreakerApplied (may be missing for very old rows — default false)
        const tieBreakerApplied = (engine.tieBreakerApplied as boolean | undefined) ?? false;

        // Extract coreSignalsAlign from decisionTrace.eliteTier.gates.allCoreModelsAgree
        // This is stored in the decisionTrace JSONB which is part of the engine object.
        // If the path is unavailable (pre-decisionTrace rows), default to false.
        let coreSignalsAlign = false;
        try {
          const decisionTrace = engine.decisionTrace as Record<string, unknown> | undefined;
          if (decisionTrace) {
            const eliteTier = decisionTrace.eliteTier as Record<string, unknown> | undefined;
            const gates = eliteTier?.gates as Record<string, unknown> | undefined;
            const allCoreModelsAgree = gates?.allCoreModelsAgree as Record<string, unknown> | undefined;
            if (allCoreModelsAgree) {
              const s = allCoreModelsAgree.surfaceEloFavorsP1 as boolean | undefined;
              const sr = allCoreModelsAgree.serveReturnFavorsP1 as boolean | undefined;
              const rf = allCoreModelsAgree.recentFormFavorsP1 as boolean | undefined;
              if (s !== undefined && sr !== undefined && rf !== undefined) {
                coreSignalsAlign = s === sr && sr === rf;
              }
            }
          }
        } catch {
          // Old row without decisionTrace — coreSignalsAlign stays false
        }

        const newRecommendation = computeRecommendation(
          row.calibrated_probability as number,
          row.data_quality as number,
          row.data_quality_label as DataQualityLabel,
          modelAgreement as ModelAgreement,
          tieBreakerApplied,
          coreSignalsAlign,
        );

        const hasChanged = newRecommendation !== (row.recommendation as string);

        await db.execute(sql`
          UPDATE predictions SET
            recommendation_v2       = ${newRecommendation},
            recommendation_version  = 2,
            recommendation_changed  = ${hasChanged},
            recommendation_changed_at = NOW()
          WHERE id = ${row.id as string}
        `);

        processed++;
        if (hasChanged) changed++;
      } catch (rowErr) {
        console.error(`[recommendation-calibration/recompute] skipping row ${row.id}:`, rowErr);
        skipped++;
      }
    }

    res.json({ ok: true, processed, skipped, changed });
  } catch (err) {
    console.error("[recommendation-calibration/recompute]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
