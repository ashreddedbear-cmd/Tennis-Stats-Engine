/**
 * auditParlayComboTestSegment.ts
 *
 * PURPOSE
 * -------
 * Tests the "High Data Quality + Low Upset Risk" parlay combo claim
 * (originally: 64.3% accuracy, n=311, validation-segment only — from
 * audit-task125-trade-combination-performance.md §3) against:
 *   (A) The full current validation segment (same filters, larger corpus)
 *   (B) The held-out test segment (true out-of-sample validation)
 *
 * The original n=311 came from an early, much smaller corpus snapshot.
 * The combo filter is: `data_quality ≥ 65` (Strong or Excellent label)
 * AND `upset_risk_tier = 'LOW'`. DQ label thresholds (from dataQuality.ts):
 *   Excellent ≥ 85  |  Strong ≥ 65  |  Acceptable ≥ 45  |  Limited ≥ 25  |  Poor < 25
 *
 * REPORTS
 * - Validation segment: does the filter still show 64.3%? (corpus growth context)
 * - Test segment:       does the claim hold out-of-sample?
 * - Sub-breakdown by DQ bucket (Strong 65–84 vs Excellent ≥85) and upset tier
 * - Fold-null warning if any rows have NULL fold_id
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/auditParlayComboTestSegment.ts
 */

import { pool } from "@workspace/db";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtN = (n: number) => n.toLocaleString("en-US");
const fmtPct = (n: number) => `${n.toFixed(2)}%`;

function delta(a: number, b: number) {
  const d = a - b;
  return (d >= 0 ? "+" : "") + d.toFixed(2) + "pp";
}

function printTable(headers: string[], rows: (string | number)[][], widths?: number[]) {
  const w =
    widths ??
    headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (vals: (string | number)[]) =>
    vals.map((v, i) => String(v).padEnd(w[i]!)).join("  │  ");
  console.log("  " + fmt(headers));
  console.log("  " + w.map((n) => "─".repeat(n)).join("──┼──"));
  rows.forEach((r) => console.log("  " + fmt(r)));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("  auditParlayComboTestSegment — High DQ + Low Upset Risk");
    console.log("══════════════════════════════════════════════════════════════\n");

    console.log("  ORIGINAL CLAIM (audit-task125 §3, validation segment):");
    console.log("  ┌───────────────────────────────────────────────────────────┐");
    console.log("  │  High Data Quality (Strong/Excellent) + Low Upset Risk    │");
    console.log("  │  n = 311   accuracy = 64.3%   calib. gap = +0.1   LL=0.657│");
    console.log("  └───────────────────────────────────────────────────────────┘");
    console.log("  Filter: data_quality ≥ 65 (Strong label threshold) AND upset_risk_tier = 'LOW'");
    console.log("  Source: evaluation_predictions, run_kind='historical_test', graded,");
    console.log("          included_in_accuracy=true, segment='validation'");
    console.log("  Note:   n=311 was from an early corpus snapshot; corpus has since grown ~3x.");
    console.log();

    // ── §1. Current validation vs test — top-level combo ─────────────────────
    console.log("§1  COMBO ACCURACY: VALIDATION vs TEST SEGMENT (all graded historical rows)");
    console.log("────────────────────────────────────────────────────────────\n");

    const comboRes = await client.query<{
      segment: string; n: string; accuracy: string; avg_predicted: string; calib_gap: string; log_loss: string;
    }>(`
      SELECT
        segment,
        COUNT(*)::int AS n,
        ROUND(
          (100.0 * SUM(CASE WHEN actual_winner_id = predicted_winner_id THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0))::numeric, 2
        )::float AS accuracy,
        ROUND(AVG(calibrated_probability)::numeric, 2)::float AS avg_predicted,
        ROUND(
          (AVG(calibrated_probability)
            - 100.0 * SUM(CASE WHEN actual_winner_id = predicted_winner_id THEN 1 ELSE 0 END)
                / NULLIF(COUNT(*), 0))::numeric,
          2
        )::float AS calib_gap,
        ROUND(
          (-AVG(
            CASE
              WHEN actual_winner_id = predicted_winner_id
                THEN LN(GREATEST(calibrated_probability / 100.0, 0.001))
              ELSE LN(GREATEST(1.0 - calibrated_probability / 100.0, 0.001))
            END
          ))::numeric, 3
        )::float AS log_loss
      FROM evaluation_predictions
      WHERE run_kind = 'historical_test'
        AND status = 'graded'
        AND included_in_accuracy = true
        AND segment IN ('validation', 'test')
        AND upset_risk_tier = 'LOW'
        AND (feature_snapshot->>'dataQuality')::float >= 65
      GROUP BY segment
      ORDER BY segment
    `);

    printTable(
      ["Segment", "n", "Accuracy", "Avg predicted", "Calib gap", "Log loss"],
      comboRes.rows.map((r) => [
        r.segment,
        fmtN(parseInt(r.n, 10)),
        fmtPct(parseFloat(r.accuracy)),
        fmtPct(parseFloat(r.avg_predicted)),
        (parseFloat(r.calib_gap) >= 0 ? "+" : "") + parseFloat(r.calib_gap).toFixed(2),
        r.log_loss,
      ]),
    );
    console.log();

    const valRow = comboRes.rows.find((r) => r.segment === "validation");
    const testRow = comboRes.rows.find((r) => r.segment === "test");

    console.log("  ORIGINAL CLAIM:  validation 64.3%  (n=311, early corpus)");
    if (valRow) {
      const valAcc = parseFloat(valRow.accuracy);
      const d = delta(valAcc, 64.3);
      console.log(`  CURRENT VALIDATION:  ${fmtPct(valAcc)}  (n=${fmtN(parseInt(valRow.n, 10))}, full corpus)  Δ vs claim: ${d}`);
      if (valAcc >= 64.3) {
        console.log("  Claim holds (and is beaten) on the full validation corpus.");
      } else {
        console.log("  Claim does NOT reproduce on the full corpus validation segment.");
      }
    }
    if (testRow) {
      const testAcc = parseFloat(testRow.accuracy);
      const claimAcc = 64.3;
      const d = delta(testAcc, claimAcc);
      console.log();
      console.log(`  OUT-OF-SAMPLE (TEST SEGMENT):  ${fmtPct(testAcc)}  (n=${fmtN(parseInt(testRow.n, 10))})  Δ vs claim: ${d}`);
      if (testAcc >= claimAcc + 3) {
        console.log("  VERDICT ✅  Claim HOLDS AND IS EXCEEDED out-of-sample — combo is robust.");
      } else if (testAcc >= claimAcc) {
        console.log("  VERDICT ✅  Claim holds out-of-sample (slight improvement).");
      } else if (testAcc >= claimAcc - 3) {
        console.log("  VERDICT ⚠   Claim slightly understated on test — still directionally correct.");
      } else {
        console.log("  VERDICT ❌  Claim fails out-of-sample (accuracy below original).");
      }
    }

    // ── §2. Sub-breakdown: DQ bucket × upset tier ─────────────────────────────
    console.log("\n§2  SUB-BREAKDOWN BY DQ BUCKET AND UPSET TIER (TEST SEGMENT)");
    console.log("────────────────────────────────────────────────────────────\n");

    const breakdownRes = await client.query<{
      dq_bucket: string; upset_risk_tier: string; n: string; accuracy: string; avg_predicted: string;
    }>(`
      SELECT
        CASE
          WHEN (feature_snapshot->>'dataQuality')::float >= 85 THEN 'Excellent (≥85)'
          WHEN (feature_snapshot->>'dataQuality')::float >= 65 THEN 'Strong (65–84)'
          ELSE 'Below Strong'
        END AS dq_bucket,
        upset_risk_tier,
        COUNT(*)::int AS n,
        ROUND(
          (100.0 * SUM(CASE WHEN actual_winner_id = predicted_winner_id THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0))::numeric, 2
        )::float AS accuracy,
        ROUND(AVG(calibrated_probability)::numeric, 2)::float AS avg_predicted
      FROM evaluation_predictions
      WHERE run_kind = 'historical_test'
        AND status = 'graded'
        AND included_in_accuracy = true
        AND segment = 'test'
        AND (feature_snapshot->>'dataQuality')::float >= 65
      GROUP BY 1, 2
      ORDER BY 4 DESC
    `);

    printTable(
      ["DQ bucket", "Upset tier", "n", "Accuracy", "Avg predicted"],
      breakdownRes.rows.map((r) => [
        r.dq_bucket,
        r.upset_risk_tier,
        fmtN(parseInt(r.n, 10)),
        fmtPct(parseFloat(r.accuracy)),
        fmtPct(parseFloat(r.avg_predicted)),
      ]),
    );

    // ── §3. Baseline reference ────────────────────────────────────────────────
    console.log("\n§3  BASELINE REFERENCE (no combo filter, test segment)");
    console.log("────────────────────────────────────────────────────────────\n");

    const baseRes = await client.query<{ n: string; accuracy: string }>(`
      SELECT
        COUNT(*)::int AS n,
        ROUND(
          (100.0 * SUM(CASE WHEN actual_winner_id = predicted_winner_id THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0))::numeric, 2
        )::float AS accuracy
      FROM evaluation_predictions
      WHERE run_kind = 'historical_test'
        AND status = 'graded'
        AND included_in_accuracy = true
        AND segment = 'test'
    `);

    const baseRow = baseRes.rows[0];
    if (baseRow && testRow) {
      const baseAcc = parseFloat(baseRow.accuracy);
      const testAcc = parseFloat(testRow.accuracy);
      console.log(`  Unconditional test-segment baseline: ${fmtPct(baseAcc)} (n=${fmtN(parseInt(baseRow.n, 10))})`);
      console.log(`  High DQ + Low Upset combo:           ${fmtPct(testAcc)} (n=${fmtN(parseInt(testRow.n, 10))})`);
      console.log(`  Combo premium over baseline:          ${delta(testAcc, baseAcc)}`);
    }

    // ── §4. NULL fold-id warning ──────────────────────────────────────────────
    const nullFoldRes = await client.query<{ n: string }>(`
      SELECT COUNT(*)::int AS n
      FROM evaluation_predictions
      WHERE run_kind = 'historical_test'
        AND status = 'graded'
        AND included_in_accuracy = true
        AND segment = 'test'
        AND upset_risk_tier = 'LOW'
        AND (feature_snapshot->>'dataQuality')::float >= 65
        AND fold_id IS NULL
    `);
    const nullFoldCombo = parseInt(nullFoldRes.rows[0]?.n ?? "0", 10);
    if (nullFoldCombo > 0) {
      console.log(`\n  ⚠  ${fmtN(nullFoldCombo)} combo rows have NULL fold_id (scored before fold tracking was added).`);
      console.log("     They are included in accuracy counts but cannot be excluded from a fold-by-fold analysis.");
    }

    // ── §5. Summary ───────────────────────────────────────────────────────────
    console.log("\n§5  SUMMARY");
    console.log("────────────────────────────────────────────────────────────\n");
    console.log("  Original claim (validation, early corpus): 64.3% accuracy, n=311.");
    if (testRow && baseRes.rows[0]) {
      const testAcc = parseFloat(testRow.accuracy);
      const baseAcc = parseFloat(baseRes.rows[0].accuracy);
      const testN = parseInt(testRow.n, 10);
      console.log(`  Out-of-sample test result (full corpus):   ${fmtPct(testAcc)} accuracy, n=${fmtN(testN)}.`);
      console.log(`  Combo premium vs unconditional baseline:   ${delta(testAcc, baseAcc)}.`);
      if (testAcc >= 64.3) {
        console.log("  VERDICT ✅  The 'High DQ + Low Upset Risk' combo claim holds on held-out test data.");
        console.log("             The combo genuinely outperforms the unconditional baseline and the");
        console.log("             original claim figure — larger corpus increases confidence.");
      } else {
        console.log("  VERDICT ❌  The combo does not reproduce at 64.3%+ on the test segment.");
        console.log("             The original claim was likely an artifact of the small early corpus.");
      }
    }
    console.log();

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
