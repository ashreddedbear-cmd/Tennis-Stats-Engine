/**
 * Backfill script: compute and store crossEngineAgreement for historical predictions
 * that already have a stored engine breakdown (engine JSONB column) but no
 * crossEngineAgreement value yet.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillCrossEngineAgreement.ts
 *
 * Safe to re-run: rows where crossEngineAgreement is already non-null are skipped.
 *
 * Requires DB access — run in Replit where the helium host is resolvable.
 * Will print a dry-run summary first; pass --commit to actually write.
 *
 * Exit codes:
 *   0 — success (or dry run completed)
 *   1 — fatal error (DB unreachable, schema mismatch, etc.)
 */

import { db, predictionsTable } from "@workspace/db";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { computeBuilderScore, computeCrossEngineAgreement } from "../services/parlayBuilder/builderScoringService";

const DRY_RUN = !process.argv.includes("--commit");
const BATCH_SIZE = 100;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== backfillCrossEngineAgreement (${DRY_RUN ? "DRY RUN" : "COMMIT"}) ===\n`);
  if (DRY_RUN) {
    console.log("Pass --commit to actually write changes.\n");
  }

  let lastId = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  while (true) {
    // Keyset pagination is safe while rows are updated: the next page is always after the
    // greatest ID already inspected, so updating NULL rows cannot shift later rows past OFFSET.
    const rows = await db
      .select({
        id: predictionsTable.id,
        predictedWinnerId: predictionsTable.predictedWinnerId,
        predictedWinnerName: predictionsTable.predictedWinnerName,
        player1Id: predictionsTable.player1Id,
        player1Name: predictionsTable.player1Name,
        player2Id: predictionsTable.player2Id,
        player2Name: predictionsTable.player2Name,
        surface: predictionsTable.surface,
        tournamentName: predictionsTable.tournamentName,
        snapshotCapturedAt: predictionsTable.snapshotCapturedAt,
      })
      .from(predictionsTable)
      .where(and(gt(predictionsTable.id, lastId), isNull(predictionsTable.crossEngineAgreement)))
      .orderBy(asc(predictionsTable.id))
      .limit(BATCH_SIZE)

    if (rows.length === 0) break;

    console.log(`Batch after id=${lastId}: ${rows.length} rows`);

    for (const row of rows) {
      totalProcessed++;

      const result = computeCrossEngineAgreement((await computeBuilderScore({
        selectedPlayerId: row.predictedWinnerId,
        selectedPlayerName: row.predictedWinnerName,
        opponentId: row.predictedWinnerId === row.player1Id ? row.player2Id : row.player1Id,
        opponentName: row.predictedWinnerId === row.player1Id ? row.player2Name : row.player1Name,
        surface: row.surface,
        tournamentName: row.tournamentName,
        asOfDate: row.snapshotCapturedAt,
      })).decision);

      if (!DRY_RUN) {
        try {
          await db
            .update(predictionsTable)
            .set({ crossEngineAgreement: result })
            .where(eq(predictionsTable.id, row.id));
          totalUpdated++;
        } catch (err) {
          console.error(`  Error updating row ${row.id}:`, err);
          totalErrors++;
        }
      } else {
        // In dry run, just count
        totalUpdated++;
      }
    }

    lastId = rows[rows.length - 1]!.id;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Processed:  ${totalProcessed}`);
  console.log(`  Updated:    ${totalUpdated} ${DRY_RUN ? "(dry run — no writes)" : "(written)"}`);
  console.log(`  Skipped:    ${totalSkipped} (missing engine data or player IDs)`);
  console.log(`  Errors:     ${totalErrors}`);

  if (DRY_RUN && totalUpdated > 0) {
    console.log(`\nRe-run with --commit to apply ${totalUpdated} updates.`);
  } else if (totalUpdated > 0) {
    console.log(`\n✓ Backfill complete.`);
  } else {
    console.log(`\n✓ Nothing to update (all rows already have crossEngineAgreement or insufficient engine data).`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
