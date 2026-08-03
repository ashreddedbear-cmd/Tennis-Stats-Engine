// READ-ONLY diagnostic for the 8 stale-recommendation rows (ids 4, 9, 10, 14, 15, 16, 19, 24)
// flagged by finalConsistencyCheck.ts's Rule 10. Does not modify any data.
//
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/diagnoseStaleRecommendationRows.ts
import { db, predictionsTable, pool } from "@workspace/db";
import { computeRecommendation } from "../services/predictionEngine/recommendation";
import type { ModelAgreement } from "../services/predictionEngine/ensemble";
import type { EngineBreakdown } from "../services/predictionEngine";

const TARGET_IDS = [4, 9, 10, 14, 15, 16, 19, 24];

async function main(): Promise<void> {
  const rows = await db.select().from(predictionsTable);
  console.log(`Loaded ${rows.length} live predictions.\n`);

  console.log("=== 1) Per-row detail for the 8 targeted ids ===");
  for (const row of rows) {
    if (!TARGET_IDS.includes(row.id)) continue;
    const engine = row.engine as EngineBreakdown;
    // upsetRisk removed from computeRecommendation signature (v2 recommendation system, Task #102).
    const recomputed = computeRecommendation(row.calibratedProbability, row.dataQuality, row.dataQualityLabel as never, engine.modelAgreement as ModelAgreement);
    console.log(`--- id ${row.id}: ${row.player1Name} vs ${row.player2Name} ---`);
    console.log(`  createdAt:            ${row.createdAt?.toISOString()}`);
    console.log(`  resolvedAt:           ${row.resolvedAt ? row.resolvedAt.toISOString() : "null (NOT resolved)"}`);
    console.log(`  actualWinnerId:       ${row.actualWinnerId ?? "null"}`);
    console.log(`  stored recommendation:${row.recommendation}`);
    console.log(`  recomputed today:     ${recomputed}`);
    console.log(`  calibratedProbability:${row.calibratedProbability}, dataQuality:${row.dataQuality}/${row.dataQualityLabel}, upsetRisk:${row.upsetRisk}, modelAgreement:${engine.modelAgreement}`);
  }

  console.log("\n=== 2) Scope check: any OTHER rows (any recommendation category) where stored != recomputed? ===");
  let otherMismatches = 0;
  const categoryMismatchCounts: Record<string, number> = {};
  for (const row of rows) {
    const engine = row.engine as EngineBreakdown;
    if (!engine || typeof engine !== "object" || !("modelAgreement" in engine)) continue; // legacy rows without modelAgreement can't be recomputed the same way
    // upsetRisk removed from computeRecommendation signature (v2 recommendation system, Task #102).
    const recomputed = computeRecommendation(row.calibratedProbability, row.dataQuality, row.dataQualityLabel as never, engine.modelAgreement as ModelAgreement);
    if (recomputed !== row.recommendation) {
      categoryMismatchCounts[row.recommendation] = (categoryMismatchCounts[row.recommendation] ?? 0) + 1;
      if (!TARGET_IDS.includes(row.id)) {
        otherMismatches++;
        console.log(`  NEW/UNEXPECTED mismatch -- id ${row.id}: stored "${row.recommendation}" -> recomputes to "${recomputed}" (upsetRisk=${row.upsetRisk}, modelAgreement=${engine.modelAgreement}, createdAt=${row.createdAt?.toISOString()})`);
      }
    }
  }
  console.log(`  Mismatches outside the 8 targeted ids: ${otherMismatches}`);
  console.log(`  Mismatch counts by STORED recommendation category (includes the 8 targeted ids): ${JSON.stringify(categoryMismatchCounts)}`);

  console.log("\n=== 3) EXTREME + HighDisagreement rows overall (regardless of match/mismatch) ===");
  const extremeHighDisagreement = rows.filter((row) => {
    const engine = row.engine as EngineBreakdown;
    return row.upsetRisk === "EXTREME" && engine?.modelAgreement === "HighDisagreement";
  });
  console.log(`  Total EXTREME+HighDisagreement rows: ${extremeHighDisagreement.length}`);
  for (const row of extremeHighDisagreement) {
    console.log(`    id ${row.id}: recommendation=${row.recommendation}, createdAt=${row.createdAt?.toISOString()}, resolvedAt=${row.resolvedAt ? row.resolvedAt.toISOString() : "null"}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
