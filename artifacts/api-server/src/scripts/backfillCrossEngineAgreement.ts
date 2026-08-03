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
import { isNull, sql } from "drizzle-orm";
import { computeBuilderScore, computeCrossEngineAgreement } from "../services/parlayBuilder/builderScoringService";
import type { BuilderSnapshot } from "../services/parlayBuilder/builderScoringService";
import type { EngineBreakdown, EngineOutput } from "../services/predictionEngine/index";

const DRY_RUN = !process.argv.includes("--commit");
const BATCH_SIZE = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEngineBreakdown(e: unknown): e is EngineBreakdown {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  // Check presence of all required module results
  return (
    o.surfaceElo != null &&
    o.serveReturn != null &&
    o.recentForm != null &&
    o.fatigue != null &&
    o.availability != null &&
    o.headToHead != null &&
    o.styleMatchup != null &&
    typeof o.matchupCloseness === "string"
  );
}

function isValidEngineOutput(o: unknown): o is EngineOutput {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.predictedWinnerId === "string" && typeof r.predictedWinnerName === "string";
}

/**
 * Try to compute crossEngineAgreement from a stored prediction row.
 * Returns null if the engine data is insufficient (e.g. too old / missing module results).
 */
function tryComputeFromRow(row: {
  predictedWinnerId: string | null;
  player1Id: string | null;
  player2Id: string | null;
  engine: unknown;
}): boolean | null | "SKIP" {
  if (!row.predictedWinnerId || !row.player1Id || !row.player2Id) return "SKIP";
  if (!isValidEngineBreakdown(row.engine)) return "SKIP";

  const engineBreakdown = row.engine as EngineBreakdown;
  const selectedIsPlayer1 = row.predictedWinnerId === row.player1Id;
  const opponentId = selectedIsPlayer1 ? row.player2Id : row.player1Id;

  // Build a minimal stub for engineOutput (only fields builder actually reads)
  const engineOutput: EngineOutput = {
    predictedWinnerId: row.predictedWinnerId,
    predictedWinnerName: "", // not needed by builder
    calibratedProbability: 50, // not needed by builder
    predictedWinnerProbability: 50, // not needed by builder
    rawEnsembleProbability: 50, // not needed by builder
    dataQuality: 50, // not needed by builder
    dataQualityLabel: "Acceptable", // not needed by builder
    upsetRisk: "MODERATE", // not needed by builder
    recommendation: "NO_STRONG_SIGNAL", // not needed by builder
    predictedSetScore: "", // not needed by builder
    engine: engineBreakdown,
    decisionTrace: null as never, // not needed by builder
    crossEngineAgreement: null,
  };

  const snapshot: BuilderSnapshot = {
    selectedPlayerId: row.predictedWinnerId,
    opponentId,
    engineBreakdown,
    engineOutput,
    selectedIsPlayer1,
  };

  try {
    const builderResult = computeBuilderScore(snapshot);
    return computeCrossEngineAgreement(builderResult.decision);
  } catch {
    return "SKIP";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== backfillCrossEngineAgreement (${DRY_RUN ? "DRY RUN" : "COMMIT"}) ===\n`);
  if (DRY_RUN) {
    console.log("Pass --commit to actually write changes.\n");
  }

  let offset = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  while (true) {
    // Fetch rows that lack crossEngineAgreement (NULL only — already-set rows are skipped)
    const rows = await db
      .select({
        id: predictionsTable.id,
        predictedWinnerId: predictionsTable.predictedWinnerId,
        player1Id: predictionsTable.player1Id,
        player2Id: predictionsTable.player2Id,
        engine: predictionsTable.engine,
        crossEngineAgreement: predictionsTable.crossEngineAgreement,
      })
      .from(predictionsTable)
      .where(isNull(predictionsTable.crossEngineAgreement))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    console.log(`Batch offset=${offset}: ${rows.length} rows`);

    for (const row of rows) {
      totalProcessed++;

      const result = tryComputeFromRow(row);

      if (result === "SKIP") {
        totalSkipped++;
        continue;
      }

      if (!DRY_RUN) {
        try {
          await db
            .update(predictionsTable)
            .set({ crossEngineAgreement: result })
            .where(sql`${predictionsTable.id} = ${row.id}`);
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

    offset += rows.length;

    // If batch was smaller than BATCH_SIZE, we've reached the end
    if (rows.length < BATCH_SIZE) break;
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
