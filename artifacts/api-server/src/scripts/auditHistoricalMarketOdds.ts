/**
 * auditHistoricalMarketOdds.ts — fast historical market-odds direction audit
 *
 * Uses walk-forward-scored historical_test rows (evaluation_predictions) joined to
 * historical_matches (tennis-data.co.uk, 2016–2020) to answer:
 *
 *   (A) Is the market's vig-adjusted implied probability more accurate than the
 *       model's stored calibrated_probability on the same matches?
 *   (B) When market and model AGREE, does accuracy improve vs when they DISAGREE?
 *   (C) How often does the market-favored player win? (market direction accuracy)
 *
 * WHY NOT A FULL ENGINE RE-RUN (Section C of auditMarketConsensusAblation.ts):
 * Re-running the engine WITH market odds requires preloading the full 130k+ row
 * match-history index — 2-3 hours. This script avoids that by using the stored
 * calibrated_probability as the "without odds" arm and the market implied probability
 * as the "with odds" arm, giving the comparison in ~60 seconds.
 *
 * Limitation: the "with odds" arm here is the MARKET's raw probability, not the
 * engine's output when market odds are fed in as one input among many. That full
 * comparison is Section C of auditMarketConsensusAblation.ts (run once the walk-forward
 * has finished scoring and the context build is feasible).
 *
 * Usage:
 *   node --import tsx/esm src/scripts/auditHistoricalMarketOdds.ts
 */

import { db, evaluationPredictionsTable, historicalMatchesTable } from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { pool } from "@workspace/db";

// ─── Vig-adjusted implied probability ────────────────────────────────────────

function vigAdjusted(p1Decimal: number, p2Decimal: number): number {
  const raw1 = 1 / p1Decimal;
  const raw2 = 1 / p2Decimal;
  const overround = raw1 + raw2;
  return (raw1 / overround) * 100; // as 0–100, oriented to player1
}

// ─── Calibration leakage guard ───────────────────────────────────────────────

async function getCalibrationFitBoundary(): Promise<Date | null> {
  // The walk-forward creates calibration models fitted through some date.
  // Rows AFTER that date were NOT used to fit the model, so they're clean for evaluation.
  // If we can't determine the boundary, we use all rows (conservative).
  try {
    const { rows } = await db.execute<{ trained_through: Date | null }>(
      sql`SELECT MAX(created_at) AS trained_through FROM calibration_models WHERE active = true`
    );
    return rows[0]?.trained_through ?? null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Historical Market-Odds Direction Audit (tennis-data.co.uk, 2016–2020) ===\n");

  // ── 1. Available historical_matches rows ─────────────────────────────────
  const availCheck = await db.execute<{
    total: string; with_odds: string; earliest: string; latest: string;
  }>(sql`
    SELECT COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE
        (raw_source->'_marketOdds'->>'avgWinner')::float > 1 AND
        (raw_source->'_marketOdds'->>'avgLoser')::float > 1
      )::text AS with_odds,
      MIN(scheduled_start_at)::date::text AS earliest,
      MAX(scheduled_start_at)::date::text AS latest
    FROM historical_matches
    WHERE provider = 'tennis-data-co-uk'
  `);
  const av = availCheck.rows[0];
  console.log(`historical_matches (tennis-data-co-uk): ${av?.total ?? 0} total, ${av?.with_odds ?? 0} with avgWinner+avgLoser`);
  console.log(`  Date range: ${av?.earliest ?? 'n/a'} → ${av?.latest ?? 'n/a'}`);

  // ── 2. Scored historical_test rows ────────────────────────────────────────
  const htCheck = await db.execute<{
    total: string; scored: string; graded: string; graded_with_odds: string;
    earliest: string; latest: string;
  }>(sql`
    SELECT
      COUNT(ep.id)::text AS total,
      COUNT(ep.id) FILTER (WHERE ep.calibrated_probability IS NOT NULL)::text AS scored,
      COUNT(ep.id) FILTER (WHERE ep.status = 'graded' AND ep.included_in_accuracy = true)::text AS graded,
      COUNT(ep.id) FILTER (
        WHERE ep.status = 'graded' AND ep.included_in_accuracy = true
          AND ep.calibrated_probability IS NOT NULL
          AND ep.predicted_winner_id IS NOT NULL
          AND (hm.raw_source->'_marketOdds'->>'avgWinner')::float > 1
          AND (hm.raw_source->'_marketOdds'->>'avgLoser')::float > 1
      )::text AS graded_with_odds,
      MIN(ep.scheduled_start_at)::date::text AS earliest,
      MAX(ep.scheduled_start_at)::date::text AS latest
    FROM evaluation_predictions ep
    JOIN historical_matches hm ON ep.historical_match_id = hm.id
    WHERE ep.run_kind = 'historical_test' AND hm.provider = 'tennis-data-co-uk'
  `);
  const ht = htCheck.rows[0];
  console.log(`\nhistorical_test rows (tennis-data-co-uk): ${ht?.total ?? 0} total`);
  console.log(`  calibrated_probability scored: ${ht?.scored ?? 0}`);
  console.log(`  graded + included_in_accuracy: ${ht?.graded ?? 0}`);
  console.log(`  graded + scored + has avgOdds:  ${ht?.graded_with_odds ?? 0}  ← audit candidates`);
  console.log(`  Date range: ${ht?.earliest ?? 'n/a'} → ${ht?.latest ?? 'n/a'}`);

  const candidateCount = parseInt(ht?.graded_with_odds ?? "0", 10);
  if (candidateCount === 0) {
    console.log("\n⚠  No scored candidates available yet.");
    console.log("   The walk-forward has not yet scored these rows (or was interrupted).");
    console.log("   Restart the API server and trigger: POST /evaluation/walk-forward/score-unscored");
    console.log("   Then re-run this script once candidates appear.");
    process.exit(0);
  }

  // ── 3. Load candidates ────────────────────────────────────────────────────
  console.log(`\nLoading ${candidateCount} candidates...`);
  const rows = await db
    .select({
      evalId:              evaluationPredictionsTable.id,
      player1Id:           evaluationPredictionsTable.player1Id,
      player2Id:           evaluationPredictionsTable.player2Id,
      predictedWinnerId:   evaluationPredictionsTable.predictedWinnerId,
      actualWinnerId:      evaluationPredictionsTable.actualWinnerId,
      calibratedProb:      evaluationPredictionsTable.calibratedProbability,
      surface:             evaluationPredictionsTable.surface,
      tournamentLevel:     evaluationPredictionsTable.tournamentLevel,
      rawSource:           historicalMatchesTable.rawSource,
    })
    .from(evaluationPredictionsTable)
    .innerJoin(historicalMatchesTable, eq(evaluationPredictionsTable.historicalMatchId, historicalMatchesTable.id))
    .where(and(
      eq(evaluationPredictionsTable.runKind, "historical_test"),
      eq(evaluationPredictionsTable.status, "graded"),
      eq(evaluationPredictionsTable.includedInAccuracy, true),
      isNotNull(evaluationPredictionsTable.calibratedProbability),
      isNotNull(evaluationPredictionsTable.predictedWinnerId),
      isNotNull(evaluationPredictionsTable.actualWinnerId),
      eq(historicalMatchesTable.provider, "tennis-data-co-uk"),
      sql`(${historicalMatchesTable.rawSource}->'_marketOdds'->>'avgWinner')::float > 1`,
      sql`(${historicalMatchesTable.rawSource}->'_marketOdds'->>'avgLoser')::float > 1`,
    ));

  console.log(`Loaded ${rows.length} rows.\n`);

  // ── 4. Compute metrics ────────────────────────────────────────────────────
  type Row = {
    modelCorrect: boolean;
    marketCorrect: boolean;
    agree: boolean;         // market and model pick the same player
    modelProb: number;      // stored calibrated_probability for player1 (0–100)
    marketProb: number;     // vig-adjusted implied prob for player1 (0–100)
    actualIsP1: boolean;
    surface: string | null;
    tour: string | null;
  };

  const analysed: Row[] = [];
  let badOdds = 0;

  for (const r of rows) {
    const rawOdds = (r.rawSource as Record<string, unknown>)?._marketOdds as {
      avgWinner?: number | null;
      avgLoser?: number | null;
    } | undefined;

    const p1Odds = rawOdds?.avgWinner ?? null;
    const p2Odds = rawOdds?.avgLoser  ?? null;
    if (!p1Odds || !p2Odds || p1Odds <= 1 || p2Odds <= 1) { badOdds++; continue; }

    const modelProb   = r.calibratedProb!;               // 0–100, for player1
    const marketProb  = vigAdjusted(p1Odds, p2Odds);     // 0–100, for player1
    const actualIsP1  = r.actualWinnerId === r.player1Id;
    const modelPick   = r.predictedWinnerId === r.player1Id; // true = model picks p1
    const marketPickP1 = marketProb >= 50;

    // In tennis-data.co.uk, player1 = actual winner by construction.
    // BUT: we're using the stored predictedWinnerId which comes from the walk-forward's
    // calibrated_probability (which may pick either player). We measure against actualWinnerId.
    const modelCorrect  = r.predictedWinnerId === r.actualWinnerId;
    const marketCorrect = marketPickP1 === actualIsP1;
    const agree         = modelPick === marketPickP1;

    const tour = (() => {
      const lvl = r.tournamentLevel ?? "";
      if (lvl.startsWith("ATP") || lvl === "GrandSlam" || lvl === "Masters1000") return "ATP";
      if (lvl.startsWith("WTA")) return "WTA";
      return null;
    })();

    analysed.push({ modelCorrect, marketCorrect, agree, modelProb, marketProb, actualIsP1, surface: r.surface, tour });
  }

  const n = analysed.length;
  if (n === 0) { console.log("No valid rows after odds filtering."); process.exit(0); }

  const modelAcc   = analysed.filter(r => r.modelCorrect).length / n * 100;
  const marketAcc  = analysed.filter(r => r.marketCorrect).length / n * 100;
  const agreePct   = analysed.filter(r => r.agree).length / n * 100;

  const agreed    = analysed.filter(r => r.agree);
  const disagreed = analysed.filter(r => !r.agree);

  const agreedModelAcc   = agreed.length  ? agreed.filter(r => r.modelCorrect).length  / agreed.length  * 100 : null;
  const disagreedModelAcc= disagreed.length ? disagreed.filter(r => r.modelCorrect).length / disagreed.length * 100 : null;
  const disagreedMktAcc  = disagreed.length ? disagreed.filter(r => r.marketCorrect).length / disagreed.length * 100 : null;

  // Log-loss helpers
  const eps = 1e-6;
  const ll = (prob: number, correct: boolean) => {
    const p = Math.max(eps, Math.min(1 - eps, prob / 100));
    return correct ? -Math.log(p) : -Math.log(1 - p);
  };
  const modelLL  = analysed.reduce((s, r) => s + ll(r.modelProb, r.actualIsP1), 0) / n;
  const marketLL = analysed.reduce((s, r) => s + ll(r.marketProb, r.actualIsP1), 0) / n;

  const fmt = (v: number | null, dp = 1) => v === null ? "n/a" : v.toFixed(dp) + "%";
  const fmtN = (v: number, dp = 4) => v.toFixed(dp);

  console.log(`\n${"─".repeat(68)}`);
  console.log(`Historical Market-Odds Direction Audit  (n=${n})`);
  console.log(`${"─".repeat(68)}`);
  console.log(`\n  Arm                  Accuracy       Avg Log-Loss`);
  console.log(`  ───────────────────  ─────────────  ────────────`);
  console.log(`  Model (no odds)      ${fmt(modelAcc).padEnd(13)}  ${fmtN(modelLL)}`);
  console.log(`  Market (direction)   ${fmt(marketAcc).padEnd(13)}  ${fmtN(marketLL)}`);
  console.log(`\n  Δ accuracy  (market − model): ${(marketAcc - modelAcc) >= 0 ? "+" : ""}${(marketAcc - modelAcc).toFixed(1)}pp`);
  console.log(`  Δ log-loss  (market − model): ${(marketLL - modelLL) >= 0 ? "+" : ""}${fmtN(marketLL - modelLL)}`);
  console.log(`    (negative log-loss delta = market is better calibrated)`);

  console.log(`\n  Market/model agreement rate: ${agreePct.toFixed(1)}% of ${n} rows`);
  console.log(`\n  When market & model AGREE (n=${agreed.length}):`);
  console.log(`    Model accuracy: ${fmt(agreedModelAcc)}`);
  console.log(`\n  When market & model DISAGREE (n=${disagreed.length}):`);
  console.log(`    Model accuracy:  ${fmt(disagreedModelAcc)}`);
  console.log(`    Market accuracy: ${fmt(disagreedMktAcc)}`);
  if (disagreedModelAcc !== null && disagreedMktAcc !== null) {
    const diff = disagreedMktAcc - disagreedModelAcc;
    console.log(`    On disagreements: market beats model by ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`);
  }

  // ── 5. Per-tour breakdown ─────────────────────────────────────────────────
  const tours = [...new Set(analysed.map(r => r.tour ?? "Unknown"))].sort();
  if (tours.length > 1) {
    console.log(`\n  Per-tour:`);
    for (const t of tours) {
      const sub = analysed.filter(r => (r.tour ?? "Unknown") === t);
      const mA = sub.filter(r => r.modelCorrect).length / sub.length * 100;
      const mkA = sub.filter(r => r.marketCorrect).length / sub.length * 100;
      console.log(`    ${t.padEnd(8)} n=${String(sub.length).padEnd(5)}  model=${mA.toFixed(1)}%  market=${mkA.toFixed(1)}%  Δ=${(mkA-mA >= 0 ? "+" : "")}${(mkA-mA).toFixed(1)}pp`);
    }
  }

  // ── 6. Per-surface breakdown ──────────────────────────────────────────────
  const surfaces = [...new Set(analysed.map(r => r.surface ?? "Unknown"))].sort();
  if (surfaces.length > 1) {
    console.log(`\n  Per-surface:`);
    for (const s of surfaces) {
      const sub = analysed.filter(r => (r.surface ?? "Unknown") === s);
      const mA = sub.filter(r => r.modelCorrect).length / sub.length * 100;
      const mkA = sub.filter(r => r.marketCorrect).length / sub.length * 100;
      console.log(`    ${s.padEnd(10)} n=${String(sub.length).padEnd(5)}  model=${mA.toFixed(1)}%  market=${mkA.toFixed(1)}%  Δ=${(mkA-mA >= 0 ? "+" : "")}${(mkA-mA).toFixed(1)}pp`);
    }
  }

  // ── 7. Hindsight warning ──────────────────────────────────────────────────
  console.log(`\n  ⚠  Hindsight note: tennis-data.co.uk stores only completed matches.`);
  console.log(`     player1 = actual winner by construction, so avgWinner odds always favored`);
  console.log(`     the winner. Market direction accuracy includes this systematic bias.`);
  console.log(`     The walk-forward model DOES NOT have this advantage at scoring time.`);
  console.log(`     Treat market accuracy here as an UPPER BOUND, not a real-world estimate.`);
  console.log(`     Section B paper-trade data (live odds, n=184) is the canonical criterion.`);
  console.log(`\n  See auditMarketConsensusAblation.ts Section C for the full engine re-run`);
  console.log(`  comparison (requires ~2-3h match-history preload; run after walk-forward completes).`);

  console.log(`\n=== Done ===`);
}

main()
  .catch(err => { console.error("Fatal:", err); process.exit(1); })
  .finally(async () => { void pool.end(); process.exit(0); });
