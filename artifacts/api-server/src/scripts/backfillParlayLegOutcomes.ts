/**
 * backfillParlayLegOutcomes.ts
 *
 * Scores historical graded matches through the Independent Validation Engine
 * and inserts the results into parlay_leg_outcomes so the calibration scripts
 * have data to work with before live legs accumulate.
 *
 * Temporal isolation guarantee:
 *   Each match is scored with asOfDate = its own scheduled_start_at.  The
 *   engine's historical_matches queries are gated to rows BEFORE that date,
 *   so the score it produces is the one it *would* have given on the day of
 *   the match — no leakage of future data.
 *
 * Idempotent: rows where backfill_match_id already exists are skipped, so
 * re-running the script is safe and won't duplicate data.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillParlayLegOutcomes.ts
 *
 * Env vars:
 *   LIMIT=500        Max rows to process (default 500; use 0 for all)
 *   BATCH_DELAY_MS=200  Delay between matches in ms (default 200; reduce if DB is fast)
 *   SURFACE=Hard     Only process matches on this surface
 *   DRY_RUN=1        Score but don't insert — prints what would have been inserted
 *
 * Note: Layer 5 (live provider API fetch) is automatically disabled when
 * asOfDate is set inside computeBuilderScore, so this script never burns
 * external API quota.
 */

import { pool } from "@workspace/db";
import { computeBuilderScore } from "../services/parlayBuilder/builderScoringService.js";

const LIMIT        = parseInt(process.env["LIMIT"] ?? "500", 10) || 500;
const BATCH_DELAY  = parseInt(process.env["BATCH_DELAY_MS"] ?? "50", 10);
const SURFACE      = process.env["SURFACE"] ?? null;
const DRY_RUN      = process.env["DRY_RUN"] === "1";
// Exclude synthetic walk-forward test rows (player1_name LIKE 'wf-player%' start 2020-01-xx).
// Real graded matches are all >= 2022; default guards against test data pollution.
const MIN_DATE     = process.env["MIN_DATE"] ?? "2022-01-01";

interface GradedMatch {
  id: number;
  player1_id: string;
  player2_id: string;
  player1_name: string;
  player2_name: string;
  actual_winner_id: string;
  scheduled_start_at: Date;
  surface: string | null;
  tournament_name: string | null;
  odds_player1_decimal: number | null;
  odds_player2_decimal: number | null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const client = await pool.connect();

  try {
    // ── 1. Find already-backfilled match IDs so we can skip them ────────────
    const { rows: existing } = await client.query<{ backfill_match_id: number }>(
      `SELECT backfill_match_id FROM parlay_leg_outcomes WHERE backfill_match_id IS NOT NULL`
    );
    const alreadyDone = new Set(existing.map(r => r.backfill_match_id));
    console.log(`Already backfilled: ${alreadyDone.size} match(es)`);

    // ── 2. Load graded matches ───────────────────────────────────────────────
    const whereClause = [
      `actual_winner_id IS NOT NULL`,
      `player1_id IS NOT NULL`,
      `player2_id IS NOT NULL`,
      `player1_name IS NOT NULL`,
      `player2_name IS NOT NULL`,
      `scheduled_start_at IS NOT NULL`,
      `player1_name NOT LIKE 'wf-player%'`,       // exclude synthetic walk-forward test rows
      `scheduled_start_at >= '${MIN_DATE}'`,        // skip any pre-MIN_DATE synthetic fixtures
      SURFACE ? `surface ILIKE '${SURFACE.replace(/'/g, "''")}'` : null,
    ].filter(Boolean).join(" AND ");

    const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT + alreadyDone.size}` : "";

    const { rows: candidates } = await client.query<GradedMatch>(`
      SELECT id, player1_id, player2_id, player1_name, player2_name,
             actual_winner_id, scheduled_start_at, surface, tournament_name,
             odds_player1_decimal, odds_player2_decimal
      FROM evaluation_predictions
      WHERE ${whereClause}
      ORDER BY scheduled_start_at ASC
      ${limitClause}
    `);

    // Filter out already-processed rows
    const toProcess = candidates.filter(r => !alreadyDone.has(r.id)).slice(0, LIMIT > 0 ? LIMIT : undefined);

    if (toProcess.length === 0) {
      console.log("No new matches to backfill.");
      return;
    }

    console.log(`\nBackfilling ${toProcess.length} match(es) (DRY_RUN=${DRY_RUN})…\n`);

    let inserted = 0;
    let skipped  = 0;
    let errors   = 0;

    for (let i = 0; i < toProcess.length; i++) {
      const match = toProcess[i]!;
      const asOfDate = new Date(match.scheduled_start_at);

      process.stdout.write(
        `[${String(i + 1).padStart(String(toProcess.length).length)}/${toProcess.length}] ` +
        `${match.player1_name} vs ${match.player2_name}` +
        ` (${asOfDate.toISOString().slice(0, 10)})… `
      );

      try {
        // Score player1 as the "selected" player
        const snapshot = {
          selectedPlayerId:   match.player1_id,
          selectedPlayerName: match.player1_name,
          opponentId:         match.player2_id,
          opponentName:       match.player2_name,
          surface:            match.surface,
          tournamentName:     match.tournament_name,
          marketOdds:         match.odds_player1_decimal ?? null,
          asOfDate,            // ← temporal isolation gate
        };

        const result = await computeBuilderScore(snapshot);

        if (DRY_RUN) {
          console.log(`DRY  validationScore=${result.validationScore} decision=${result.decision}`);
          inserted++;
          continue;
        }

        // Check if this backfill_match_id was inserted by a concurrent run
        const { rows: dup } = await client.query(
          `SELECT 1 FROM parlay_leg_outcomes WHERE backfill_match_id = $1 LIMIT 1`,
          [match.id]
        );
        if (dup.length > 0) {
          process.stdout.write("already exists — skip\n");
          skipped++;
          continue;
        }

        await client.query(
          `INSERT INTO parlay_leg_outcomes
             (session_id, selected_player_id, opponent_id, selected_player_name, opponent_name,
              tournament_name, surface, validation_score, risk_score, reliability_grade,
              parlay_grade, decision, data_coverage, source_agreement, factor_scores,
              market_odds, actual_winner_id, resolved_at, source, backfill_match_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                   $16, $17, $18, 'backfill', $19)`,
          [
            null,                          // session_id — no session for backfill rows
            match.player1_id,
            match.player2_id,
            match.player1_name,
            match.player2_name,
            match.tournament_name ?? null,
            match.surface ?? null,
            result.validationScore,
            result.riskScore,
            result.reliabilityGrade,
            result.parlayGrade,
            result.decision,
            result.dataCoverage,
            result.sourceAgreement,
            JSON.stringify(result.factorScores),
            match.odds_player1_decimal ?? null,
            match.actual_winner_id,        // already known — fills in immediately
            asOfDate,                      // resolved_at = the match date
            match.id,                      // backfill_match_id
          ]
        );

        console.log(`✓  val=${result.validationScore} risk=${result.riskScore} ${result.decision} (${result.parlayGrade})`);
        inserted++;
      } catch (err) {
        console.log(`✗  ERROR: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }

      // Throttle to avoid overwhelming the DB
      if (i < toProcess.length - 1) await sleep(BATCH_DELAY);
    }

    // ── 3. Summary ──────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Backfill complete`);
    console.log(`  Inserted:  ${inserted}`);
    console.log(`  Skipped:   ${skipped} (already existed)`);
    console.log(`  Errors:    ${errors}`);

    if (!DRY_RUN && inserted > 0) {
      const { rows: stats } = await client.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN actual_winner_id IS NOT NULL THEN 1 END) AS resolved,
          ROUND(AVG(validation_score)) AS avg_validation,
          COUNT(CASE WHEN decision = 'KEEP' THEN 1 END) AS keep_count,
          COUNT(CASE WHEN decision = 'BORDERLINE' THEN 1 END) AS borderline_count,
          COUNT(CASE WHEN decision = 'REMOVE' THEN 1 END) AS remove_count
        FROM parlay_leg_outcomes
        WHERE source = 'backfill'
      `);
      const s = stats[0]!;
      console.log(`\nBackfill table totals:`);
      console.log(`  Total backfill rows:  ${s.total}`);
      console.log(`  Resolved (winner set): ${s.resolved}`);
      console.log(`  Avg validation score:  ${s.avg_validation}`);
      console.log(`  KEEP / BORDERLINE / REMOVE: ${s.keep_count} / ${s.borderline_count} / ${s.remove_count}`);
      console.log(`\nReady to run analyzeParlayCalibration.ts and analyzeParlayFactorCorrelations.ts`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
