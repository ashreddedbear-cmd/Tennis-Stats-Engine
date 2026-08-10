/**
 * analyzeParlayCalibration.ts  —  Step 3a
 *
 * Answers: "Is the composite validation_score actually predictive of real outcomes?"
 *
 * Buckets resolved parlay_leg_outcomes rows by validation_score decile and prints
 * the actual win rate for each bucket alongside the expected diagonal.  A well-
 * calibrated score produces monotonically increasing win rates; a flat or non-
 * monotonic result means the composite score carries no signal.
 *
 * Also prints overall stats and per-decision-tier accuracy.
 *
 * Run once you have ≥150 resolved legs:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/analyzeParlayCalibration.ts
 *
 * Optional filter flags (env vars):
 *   SURFACE=Hard   — restrict to a single surface
 *   DECISION=KEEP  — restrict to a single decision tier (KEEP / BORDERLINE / REMOVE)
 */

import { pool } from "@workspace/db";

const SURFACE  = process.env["SURFACE"]  ?? null;
const DECISION = process.env["DECISION"] ?? null;

interface ResolvedLeg {
  id: number;
  selected_player_id: string;
  validation_score: number;
  risk_score: number;
  decision: string;
  parlay_grade: string;
  reliability_grade: string;
  actual_winner_id: string;
  surface: string | null;
  data_coverage: number;
  source_agreement: number;
}

function winRate(legs: { won: boolean }[]): string {
  if (legs.length === 0) return "  n/a ";
  const w = legs.filter(l => l.won).length;
  return `${((w / legs.length) * 100).toFixed(1).padStart(5)}%`;
}

function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    let whereClause = `WHERE actual_winner_id IS NOT NULL`;
    const params: (string | null)[] = [];
    if (SURFACE) {
      params.push(SURFACE);
      whereClause += ` AND surface = $${params.length}`;
    }
    if (DECISION) {
      params.push(DECISION);
      whereClause += ` AND decision = $${params.length}`;
    }

    const { rows } = await client.query<ResolvedLeg>(`
      SELECT id, selected_player_id, validation_score, risk_score, decision,
             parlay_grade, reliability_grade, actual_winner_id,
             surface, data_coverage, source_agreement
      FROM parlay_leg_outcomes
      ${whereClause}
      ORDER BY created_at ASC
    `, params);

    const total = rows.length;
    if (total === 0) {
      console.log("No resolved legs yet — run resolveParlayLegOutcomes.ts first.");
      return;
    }

    // Annotate with "selected player won"
    const legs = rows.map(r => ({
      ...r,
      won: r.actual_winner_id === r.selected_player_id,
    }));

    console.log(`\n${"═".repeat(72)}`);
    console.log(` PARLAY BUILDER — CALIBRATION REPORT`);
    if (SURFACE || DECISION) {
      console.log(` Filter: ${[SURFACE && `surface=${SURFACE}`, DECISION && `decision=${DECISION}`].filter(Boolean).join(", ")}`);
    }
    console.log(` Resolved legs: ${total}`);
    const overallWR = legs.filter(l => l.won).length / total;
    console.log(` Overall win rate: ${(overallWR * 100).toFixed(1)}%`);
    console.log(`${"═".repeat(72)}\n`);

    // ── 3a. Decile calibration table ────────────────────────────────────────
    console.log("── Validation Score Deciles ────────────────────────────────────────");
    console.log(" Bucket   │  n  │ Win rate │ Expected │ Gap   │ Distribution");
    console.log("──────────┼─────┼──────────┼──────────┼───────┼──────────────────────");

    for (let lo = 0; lo < 100; lo += 10) {
      const hi = lo + 10;
      const bucket = legs.filter(l => l.validation_score >= lo && l.validation_score < hi);
      if (bucket.length === 0) {
        console.log(` ${String(lo).padStart(2)}–${String(hi).padStart(3)}  │   –  │    –     │  ${((lo + 5) / 100 * 100).toFixed(0).padStart(3)}%   │   –   │`);
        continue;
      }
      const wr = bucket.filter(l => l.won).length / bucket.length;
      const expected = (lo + 5) / 100;   // midpoint of bucket
      const gap = wr - expected;
      const gapStr = `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`;
      console.log(
        ` ${String(lo).padStart(2)}–${String(hi).padStart(3)}  │` +
        ` ${String(bucket.length).padStart(3)} │` +
        `  ${(wr * 100).toFixed(1).padStart(5)}%  │` +
        `   ${((expected) * 100).toFixed(0).padStart(3)}%   │` +
        ` ${gapStr.padStart(5)} │ ${bar(wr)}`
      );
    }

    // Monotonicity check
    const decileRates: number[] = [];
    for (let lo = 0; lo < 100; lo += 10) {
      const hi = lo + 10;
      const bucket = legs.filter(l => l.validation_score >= lo && l.validation_score < hi);
      if (bucket.length > 0) decileRates.push(bucket.filter(l => l.won).length / bucket.length);
    }
    let violations = 0;
    for (let i = 1; i < decileRates.length; i++) {
      if (decileRates[i]! < decileRates[i - 1]! - 0.05) violations++;
    }
    console.log(`\n Monotonicity violations (>5pp drop): ${violations}`);
    if (violations === 0) console.log(" ✓ Score is monotonically predictive across deciles");
    else if (violations <= 1) console.log(" ⚠ Minor non-monotonicity — likely noise at low sample count");
    else console.log(" ✗ Non-monotonic — composite score may carry limited signal");

    // ── Per decision tier ────────────────────────────────────────────────────
    console.log("\n── Per Decision Tier ───────────────────────────────────────────────");
    console.log(" Decision   │  n  │ Win rate │ Avg validation │ Avg risk");
    console.log("────────────┼─────┼──────────┼────────────────┼──────────");
    for (const tier of ["KEEP", "BORDERLINE", "REMOVE"]) {
      const group = legs.filter(l => l.decision === tier);
      if (group.length === 0) continue;
      const wr = group.filter(l => l.won).length / group.length;
      const avgVal = Math.round(group.reduce((s, l) => s + l.validation_score, 0) / group.length);
      const avgRisk = Math.round(group.reduce((s, l) => s + l.risk_score, 0) / group.length);
      console.log(
        ` ${tier.padEnd(10)} │ ${String(group.length).padStart(3)} │  ${(wr * 100).toFixed(1).padStart(5)}%  │` +
        `      ${String(avgVal).padStart(3)}       │   ${String(avgRisk).padStart(3)}`
      );
    }

    // KEEP vs REMOVE separation (the key diagnostic)
    const keepLegs   = legs.filter(l => l.decision === "KEEP");
    const removeLegs = legs.filter(l => l.decision === "REMOVE");
    if (keepLegs.length > 0 && removeLegs.length > 0) {
      const keepWR   = keepLegs.filter(l => l.won).length / keepLegs.length;
      const removeWR = removeLegs.filter(l => l.won).length / removeLegs.length;
      const sep = (keepWR - removeWR) * 100;
      console.log(`\n KEEP vs REMOVE separation: ${sep >= 0 ? "+" : ""}${sep.toFixed(1)}pp`);
      if (sep >= 15) console.log(" ✓ Strong tier separation — filter is adding real value");
      else if (sep >= 5) console.log(" ⚠ Moderate separation — some signal, worth refining");
      else console.log(" ✗ Weak separation — KEEP/REMOVE thresholds need recalibration");
    }

    // ── Per parlay grade ────────────────────────────────────────────────────
    console.log("\n── Per Parlay Grade ────────────────────────────────────────────────");
    for (const grade of ["Elite", "Solid", "Weak", "Reject"]) {
      const group = legs.filter(l => l.parlay_grade === grade);
      if (group.length === 0) continue;
      const wr = group.filter(l => l.won).length / group.length;
      console.log(` ${grade.padEnd(10)} n=${String(group.length).padStart(3)}  win=${(wr * 100).toFixed(1).padStart(5)}%  ${bar(wr, 15)}`);
    }

    // ── Coverage / source agreement breakdown ───────────────────────────────
    console.log("\n── Data Coverage vs Win Rate ───────────────────────────────────────");
    for (const [label, lo, hi] of [
      ["<40%",   0, 40],
      ["40–60%", 40, 60],
      ["60–80%", 60, 80],
      ["≥80%",   80, 101],
    ] as [string, number, number][]) {
      const group = legs.filter(l => l.data_coverage >= lo && l.data_coverage < hi);
      if (group.length === 0) continue;
      const wr = group.filter(l => l.won).length / group.length;
      console.log(` Coverage ${label.padEnd(6)}  n=${String(group.length).padStart(3)}  win=${(wr * 100).toFixed(1).padStart(5)}%`);
    }

    console.log(`\n${"═".repeat(72)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Calibration analysis failed:", err);
  process.exit(1);
});
