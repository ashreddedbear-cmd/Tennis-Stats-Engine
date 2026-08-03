/**
 * analyzeParlayFactorCorrelations.ts  —  Step 3b
 *
 * Answers: "Which of the 19 factors actually predict match outcomes?"
 *
 * For each factor key found in factor_scores, pulls (score, supportsSelected,
 * actual_win) across all resolved legs and computes:
 *   - Win rate when supportsSelected = true  (factor backed selected player)
 *   - Win rate when supportsSelected = false (factor backed opponent)
 *   - Win rate when supportsSelected = null  (factor was neutral / undecided)
 *   - Edge: true-win-rate minus false-win-rate (the real predictive signal)
 *   - Score correlation: Pearson r between factor score and actual outcome (0/1)
 *
 * Factors are ranked by edge descending.  Factors with edge ≈ 0 and low
 * sample are candidates for zero-weighting in Step 4.
 *
 * Run once you have ≥150 resolved legs:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/analyzeParlayFactorCorrelations.ts
 *
 * Optional env-var filter:
 *   MIN_SAMPLES=20   — hide factors with fewer samples than this (default 10)
 *   SURFACE=Clay     — restrict to a single surface
 */

import { pool } from "@workspace/db";

const MIN_SAMPLES = parseInt(process.env["MIN_SAMPLES"] ?? "10", 10);
const SURFACE     = process.env["SURFACE"] ?? null;

interface ResolvedLeg {
  id: number;
  selected_player_id: string;
  actual_winner_id: string;
  factor_scores: FactorEntry[];
  surface: string | null;
}

interface FactorEntry {
  key: string;
  label: string;
  score: number;
  weight: number;
  status: string;
  supportsSelected: boolean | null;
}

interface FactorStats {
  key: string;
  label: string;
  weight: number;
  nTrue: number;  nFalse: number;  nNull: number;
  wrTrue: number; wrFalse: number; wrNull: number;
  edge: number;   // wrTrue - wrFalse (positive = factor has directional value)
  pearsonR: number;
  avgScoreWon: number; avgScoreLost: number;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return dx2 === 0 || dy2 === 0 ? 0 : num / Math.sqrt(dx2 * dy2);
}

function edgeBar(edge: number, width = 20): string {
  const center = Math.floor(width / 2);
  const filled = Math.round(Math.abs(edge) * center);
  if (edge >= 0) {
    return " ".repeat(center) + "█".repeat(Math.min(filled, center)) + "░".repeat(Math.max(0, center - filled));
  }
  return "░".repeat(Math.max(0, center - filled)) + "█".repeat(Math.min(filled, center)) + " ".repeat(center);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    let whereClause = `WHERE actual_winner_id IS NOT NULL`;
    const params: string[] = [];
    if (SURFACE) {
      params.push(SURFACE);
      whereClause += ` AND surface = $${params.length}`;
    }

    const { rows } = await client.query<{ id: number; selected_player_id: string; actual_winner_id: string; factor_scores: FactorEntry[]; surface: string | null }>(`
      SELECT id, selected_player_id, actual_winner_id, factor_scores, surface
      FROM parlay_leg_outcomes
      ${whereClause}
      ORDER BY created_at ASC
    `, params);

    const total = rows.length;
    if (total === 0) {
      console.log("No resolved legs yet — run resolveParlayLegOutcomes.ts first.");
      return;
    }

    // Annotate each row with the boolean outcome
    const legs: ResolvedLeg[] = rows.map(r => ({
      ...r,
      factor_scores: Array.isArray(r.factor_scores) ? r.factor_scores : [],
    }));

    // ── Collect per-factor observations ─────────────────────────────────────
    const byFactor = new Map<string, {
      label: string; weight: number;
      obs: Array<{ score: number; supportsSelected: boolean | null; won: boolean }>;
    }>();

    for (const leg of legs) {
      const won = leg.actual_winner_id === leg.selected_player_id;
      for (const f of leg.factor_scores) {
        if (f.status === "unavailable") continue;
        if (!byFactor.has(f.key)) {
          byFactor.set(f.key, { label: f.label, weight: f.weight, obs: [] });
        }
        byFactor.get(f.key)!.obs.push({ score: f.score, supportsSelected: f.supportsSelected, won });
      }
    }

    // ── Compute stats per factor ─────────────────────────────────────────────
    const stats: FactorStats[] = [];
    for (const [key, { label, weight, obs }] of byFactor) {
      const trueObs  = obs.filter(o => o.supportsSelected === true);
      const falseObs = obs.filter(o => o.supportsSelected === false);
      const nullObs  = obs.filter(o => o.supportsSelected === null);

      const wrTrue  = trueObs.length  > 0 ? trueObs.filter(o => o.won).length  / trueObs.length  : NaN;
      const wrFalse = falseObs.length > 0 ? falseObs.filter(o => o.won).length / falseObs.length : NaN;
      const wrNull  = nullObs.length  > 0 ? nullObs.filter(o => o.won).length  / nullObs.length  : NaN;

      const edge = (!isNaN(wrTrue) && !isNaN(wrFalse)) ? wrTrue - wrFalse : NaN;

      const xs = obs.map(o => o.score);
      const ys = obs.map(o => o.won ? 1 : 0);
      const pearsonR = pearson(xs, ys);

      const wonObs  = obs.filter(o => o.won);
      const lostObs = obs.filter(o => !o.won);
      const avgScoreWon  = wonObs.length  > 0 ? wonObs.reduce((s, o) => s + o.score, 0)  / wonObs.length  : NaN;
      const avgScoreLost = lostObs.length > 0 ? lostObs.reduce((s, o) => s + o.score, 0) / lostObs.length : NaN;

      stats.push({ key, label, weight, nTrue: trueObs.length, nFalse: falseObs.length, nNull: nullObs.length, wrTrue, wrFalse, wrNull, edge, pearsonR, avgScoreWon, avgScoreLost });
    }

    // Sort by abs(edge) descending (NaN last), then by pearsonR
    stats.sort((a, b) => {
      if (isNaN(a.edge) && isNaN(b.edge)) return Math.abs(b.pearsonR) - Math.abs(a.pearsonR);
      if (isNaN(a.edge)) return 1;
      if (isNaN(b.edge)) return -1;
      return Math.abs(b.edge) - Math.abs(a.edge);
    });

    console.log(`\n${"═".repeat(84)}`);
    console.log(` PARLAY BUILDER — FACTOR CORRELATION REPORT`);
    if (SURFACE) console.log(` Filter: surface=${SURFACE}`);
    console.log(` Resolved legs: ${total}   Min samples shown: ${MIN_SAMPLES}`);
    console.log(`${"═".repeat(84)}\n`);

    console.log("── Factor Directional Accuracy ─────────────────────────────────────────────────");
    console.log(" Factor                    wt │ n(T/F/?) │ WR(true) │ WR(false)│  Edge  │   r  │ Edge viz");
    console.log("───────────────────────────────┼──────────┼──────────┼──────────┼────────┼──────┼──────────────────────");

    let deadWeightCount = 0;
    for (const s of stats) {
      const nTotal = s.nTrue + s.nFalse + s.nNull;
      if (nTotal < MIN_SAMPLES) continue;

      const edgeStr  = isNaN(s.edge) ? "  n/a " : `${s.edge >= 0 ? "+" : ""}${(s.edge * 100).toFixed(1)}%`;
      const wrTStr   = isNaN(s.wrTrue)  ? "  n/a   " : `${(s.wrTrue * 100).toFixed(1).padStart(5)}%  `;
      const wrFStr   = isNaN(s.wrFalse) ? "  n/a   " : `${(s.wrFalse * 100).toFixed(1).padStart(5)}%  `;
      const rStr     = `${s.pearsonR >= 0 ? "+" : ""}${s.pearsonR.toFixed(3)}`;
      const vizEdge  = isNaN(s.edge) ? " ".repeat(20) : edgeBar(s.edge, 20);

      console.log(
        ` ${s.label.substring(0, 26).padEnd(26)} ${String((s.weight * 100).toFixed(0)).padStart(2)}% │` +
        ` ${String(s.nTrue).padStart(3)}/${String(s.nFalse).padStart(3)}/${String(s.nNull).padStart(3)} │` +
        ` ${wrTStr}│ ${wrFStr}│ ${edgeStr.padStart(6)} │ ${rStr} │ ${vizEdge}`
      );

      if (!isNaN(s.edge) && Math.abs(s.edge) < 0.05 && Math.abs(s.pearsonR) < 0.05 && nTotal >= MIN_SAMPLES) {
        deadWeightCount++;
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`\n── Summary ─────────────────────────────────────────────────────────────────────`);

    const withEdge = stats.filter(s => !isNaN(s.edge) && s.nTrue + s.nFalse >= MIN_SAMPLES);
    const strongFactors = withEdge.filter(s => Math.abs(s.edge) >= 0.10);
    const weakFactors   = withEdge.filter(s => Math.abs(s.edge) < 0.05 && Math.abs(s.pearsonR) < 0.05);

    console.log(`\n Strong factors (|edge| ≥ 10pp): ${strongFactors.length}`);
    for (const s of strongFactors) {
      const dir = s.edge >= 0 ? "↑ backs pick" : "↓ inverted (check logic)";
      console.log(`   ${s.label} (edge ${s.edge >= 0 ? "+" : ""}${(s.edge * 100).toFixed(1)}pp, r=${s.pearsonR.toFixed(3)}) — ${dir}`);
    }

    console.log(`\n Dead-weight factors (|edge| <5pp, |r| <0.05): ${weakFactors.length}`);
    for (const s of weakFactors) {
      console.log(`   ${s.label} — weight=${(s.weight * 100).toFixed(0)}% — consider zeroing in Step 4`);
    }

    const invertedFactors = withEdge.filter(s => s.edge < -0.10);
    if (invertedFactors.length > 0) {
      console.log(`\n ⚠ INVERTED factors (factor backs pick but pick LOSES more often): ${invertedFactors.length}`);
      for (const s of invertedFactors) {
        console.log(`   ${s.label} — edge ${(s.edge * 100).toFixed(1)}pp — logic bug likely, audit before Step 4`);
      }
    }

    // Avg score won vs lost — cross-factor sanity check
    console.log(`\n── Score Separation (avg factor score: won vs lost) ─────────────────────────────`);
    console.log(` Factor                    │ Avg score (won) │ Avg score (lost) │ Gap`);
    console.log(`───────────────────────────┼─────────────────┼──────────────────┼──────`);
    const withScoreSep = stats
      .filter(s => !isNaN(s.avgScoreWon) && !isNaN(s.avgScoreLost) && (s.nTrue + s.nFalse + s.nNull) >= MIN_SAMPLES)
      .sort((a, b) => Math.abs(b.avgScoreWon - b.avgScoreLost) - Math.abs(a.avgScoreWon - a.avgScoreLost));
    for (const s of withScoreSep) {
      const gap = s.avgScoreWon - s.avgScoreLost;
      const gapStr = `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}`;
      console.log(
        ` ${s.label.substring(0, 26).padEnd(26)} │      ${s.avgScoreWon.toFixed(1).padStart(5)}       │       ${s.avgScoreLost.toFixed(1).padStart(5)}        │ ${gapStr.padStart(5)}`
      );
    }

    console.log(`\n${"═".repeat(84)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Factor correlation analysis failed:", err);
  process.exit(1);
});
