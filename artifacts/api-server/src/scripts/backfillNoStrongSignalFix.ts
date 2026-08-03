// Scoped backfill (2026-07-14): correct the `recommendation` column, and ONLY that column, on the
// 8 rows created 2026-07-11 (06:01-11:56 UTC) BEFORE commit caa03aa introduced NO_STRONG_SIGNAL /
// modelAgreement into computeRecommendation. All 8 were stored as HIGH_RISK, but recompute to
// NO_STRONG_SIGNAL under the current (and confirmed-correct, see audit) logic: margin < 8 AND
// modelAgreement is Mixed or HighDisagreement. Same pattern as the earlier 7-row MODERATE_LEAN
// backfill (backfillRecommendationFix.ts): fresh backup, drift check against last-confirmed
// state, provenance flags on write, no other column touched.
//
// Explicitly OUT OF SCOPE (per 2026-07-14 audit): the stored upsetRisk="EXTREME" tag on these
// rows does not reproduce under today's recalibrated upsetRisk algorithm for 5 of the 8 rows
// (9, 10, 16, 19, 24) -- that is a separate, unresolved issue tracked on its own and is NOT
// touched by this script. upsetRisk, engine.upsetRiskBreakdown (where present), match outcome,
// actualWinnerId, resolvedAt, etc. are all left exactly as-is.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillNoStrongSignalFix.ts --dry-run
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillNoStrongSignalFix.ts --apply
import { db, predictionsTable, pool } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { computeRecommendation } from "../services/predictionEngine/recommendation";
import type { DataQualityLabel } from "../services/predictionEngine/dataQuality";
import type { ModelAgreement } from "../services/predictionEngine/ensemble";
import type { EngineBreakdown } from "../services/predictionEngine";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPROVED_IDS = [4, 9, 10, 14, 15, 16, 19, 24].sort((a, b) => a - b);

// Last-confirmed state (from the 2026-07-14 audit pass), used to detect drift before writing.
const LAST_CONFIRMED: Record<number, { recommendation: string; calibratedProbability: number; upsetRisk: string; modelAgreement: string }> = {
  4: { recommendation: "HIGH_RISK", calibratedProbability: 51.3, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  9: { recommendation: "HIGH_RISK", calibratedProbability: 57.5, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  10: { recommendation: "HIGH_RISK", calibratedProbability: 53.5, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  14: { recommendation: "HIGH_RISK", calibratedProbability: 43, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  15: { recommendation: "HIGH_RISK", calibratedProbability: 50.4, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  16: { recommendation: "HIGH_RISK", calibratedProbability: 44.5, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  19: { recommendation: "HIGH_RISK", calibratedProbability: 47, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
  24: { recommendation: "HIGH_RISK", calibratedProbability: 50.3, upsetRisk: "EXTREME", modelAgreement: "HighDisagreement" },
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const rows = await db.select().from(predictionsTable).where(inArray(predictionsTable.id, APPROVED_IDS));
  const foundIds = rows.map((r) => r.id).sort((a, b) => a - b);

  console.log(`Re-verifying row set: expected [${APPROVED_IDS.join(", ")}], found [${foundIds.join(", ")}]`);
  if (foundIds.length !== APPROVED_IDS.length || !foundIds.every((id, i) => id === APPROVED_IDS[i])) {
    console.error(`STOP: row set drifted. Not proceeding.`);
    process.exit(1);
  }

  // Drift check against last-confirmed inputs, and recompute new recommendation per row.
  const plan: { id: number; before: string; after: string; graded: boolean; row: (typeof rows)[number] }[] = [];
  for (const row of rows) {
    const engine = row.engine as EngineBreakdown;
    const last = LAST_CONFIRMED[row.id];
    const drifted =
      row.recommendation !== last.recommendation ||
      row.calibratedProbability !== last.calibratedProbability ||
      row.upsetRisk !== last.upsetRisk ||
      engine.modelAgreement !== last.modelAgreement;
    if (drifted) {
      console.error(
        `STOP: #${row.id} drifted since last confirmation. was={rec:${last.recommendation},cp:${last.calibratedProbability},risk:${last.upsetRisk},agr:${last.modelAgreement}} now={rec:${row.recommendation},cp:${row.calibratedProbability},risk:${row.upsetRisk},agr:${engine.modelAgreement}}`,
      );
      process.exit(1);
    }
    // upsetRisk removed from computeRecommendation signature (v2 recommendation system, Task #102).
    // These rows were originally stored as HIGH_RISK pre-v2; under v2 logic they map to
    // INSUFFICIENT_EDGE (margin < 8 + HighDisagreement). The old NO_STRONG_SIGNAL check is
    // preserved as a comment; this script is historical and not re-run.
    const newRec = computeRecommendation(
      row.calibratedProbability,
      row.dataQuality,
      row.dataQualityLabel as DataQualityLabel,
      engine.modelAgreement as ModelAgreement,
    );
    if (newRec !== "INSUFFICIENT_EDGE") {
      console.error(`STOP: #${row.id} recomputes to ${newRec}, not INSUFFICIENT_EDGE as expected under v2 logic. Aborting -- this row needs re-review.`);
      process.exit(1);
    }
    const graded = row.actualWinnerId !== null || row.resolvedAt !== null;
    plan.push({ id: row.id, before: row.recommendation, after: newRec, graded, row });
  }

  console.log(`\nNo drift detected. Plan:`);
  for (const p of plan) {
    console.log(`  #${p.id}: ${p.before} -> ${p.after} (graded=${p.graded})`);
  }

  // Fresh backup of full row state before any write.
  const backupDir = path.join(__dirname, "..", "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `no-strong-signal-backfill-8rows-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`\nBackup of pre-backfill row state (all columns, all 8 rows) written to: ${backupPath}`);

  if (dryRun) {
    console.log(`\nDRY RUN -- no writes performed. Re-run with --apply to write.`);
    await pool.end();
    return;
  }

  console.log(`\nApplying updates...`);
  const appliedAt = new Date().toISOString();
  for (const p of plan) {
    const engine = p.row.engine as EngineBreakdown & Record<string, unknown>;
    const newEngine: Record<string, unknown> = {
      ...engine,
      recommendationBackfillCorrected: true,
      recommendationBackfillPreviousValue: p.before,
      recommendationBackfillAppliedAt: appliedAt,
      recommendationBackfillWasGradedAtCorrection: p.graded,
      recommendationBackfillReason:
        "This row was created 2026-07-11 (06:01-11:56 UTC), before commit caa03aa introduced NO_STRONG_SIGNAL/modelAgreement into computeRecommendation. Recomputing today's logic (margin < 8 AND modelAgreement is Mixed/HighDisagreement) against this row's own stored calibratedProbability/modelAgreement yields NO_STRONG_SIGNAL, not the stored HIGH_RISK. This is a retroactive label correction of a stored value, not a newly-generated prediction. Note: the separate upsetRisk=EXTREME tag on this row is NOT corrected here -- that is a distinct, unresolved issue tracked separately.",
    };
    await db.update(predictionsTable).set({ recommendation: p.after, engine: newEngine }).where(eq(predictionsTable.id, p.id));
    console.log(`  Updated #${p.id}: ${p.before} -> ${p.after} (backfill flag set, graded-at-correction=${p.graded})`);
  }

  console.log(`\nDone. ${plan.length} rows updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
