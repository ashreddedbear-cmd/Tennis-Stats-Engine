// Scoped backfill (2026-07-14): correct the `recommendation` column, and ONLY that column, on the
// 7 rows where the margin-8-10 MODERATE_LEAN rescue rule (added to computeRecommendation in
// recommendation.ts) changes the outcome vs. the value stored when the row was generated under
// the old buggy catch-all. Nothing else on these rows is touched -- no match outcome/score, no
// other engine field beyond the added backfill-provenance flags, no created_at/resolved_at.
//
// This script refuses to write anything if the re-verified row set doesn't exactly match the 7
// approved IDs, or if any row's recommendation/margin/upsetRisk/modelAgreement has drifted since
// they were last confirmed.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillRecommendationFix.ts --dry-run
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillRecommendationFix.ts --apply
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

const APPROVED_IDS = [442, 759, 852, 883, 972, 996, 1031].sort((a, b) => a - b);

// Last-confirmed state (from the prior verification pass), used to detect drift before writing.
const LAST_CONFIRMED: Record<number, { recommendation: string; calibratedProbability: number; upsetRisk: string; modelAgreement: string }> = {
  442: { recommendation: "HIGH_RISK", calibratedProbability: 40.7, upsetRisk: "LOW", modelAgreement: "Strong" },
  759: { recommendation: "HIGH_RISK", calibratedProbability: 41.5, upsetRisk: "LOW", modelAgreement: "Moderate" },
  852: { recommendation: "HIGH_RISK", calibratedProbability: 40.2, upsetRisk: "LOW", modelAgreement: "Moderate" },
  883: { recommendation: "HIGH_RISK", calibratedProbability: 59.2, upsetRisk: "LOW", modelAgreement: "Strong" },
  972: { recommendation: "HIGH_RISK", calibratedProbability: 58, upsetRisk: "LOW", modelAgreement: "Moderate" },
  996: { recommendation: "HIGH_RISK", calibratedProbability: 41.2, upsetRisk: "LOW", modelAgreement: "Moderate" },
  1031: { recommendation: "HIGH_RISK", calibratedProbability: 58.7, upsetRisk: "LOW", modelAgreement: "Moderate" },
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
    const newRec = computeRecommendation(
      row.calibratedProbability,
      row.dataQuality,
      row.dataQualityLabel as DataQualityLabel,
      engine.modelAgreement as ModelAgreement,
    );
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
  const backupPath = path.join(backupDir, `recommendation-backfill-7rows-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`\nBackup of pre-backfill row state (all columns, all 7 rows) written to: ${backupPath}`);

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
        "Corrected the margin 8-10 HIGH_RISK catch-all bug in computeRecommendation (recommendation.ts). This is a retroactive label correction of a stored value, not a newly-generated prediction.",
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
