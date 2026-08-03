/**
 * Complete walk-forward execution script
 * 
 * Runs the full walk-forward evaluation pipeline:
 * 1. Runs walk-forward evaluation (4-fold CV, training mode)
 * 2. Fits calibration model from validation predictions
 * 3. Computes and stores specialist models
 * 
 * Run with: pnpm exec tsx scripts/runCompleteWalkForward.ts
 */

import { runWalkForwardEvaluation } from "../src/services/evaluation/walkForward";
import { db, evaluationPredictionsTable, calibrationModelsTable, specialistModelsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { fitBestCalibration } from "../src/services/evaluation/calibration";
import { computeAndStoreSpecialistSegments } from "../src/services/evaluation/specialistWeights";
import type { CalibrationPoint } from "../src/services/evaluation/calibration";
import { detectDbHostResolutionHint } from "./lib/replitEnv.js";

async function runWalkForward(): Promise<void> {
  console.log("📊 Starting walk-forward evaluation...\n");
  const startTime = Date.now();

  const result = await runWalkForwardEvaluation({
    foldCount: 4,
    evaluationOnly: false,
  });

  const elapsedMin = Math.floor((Date.now() - startTime) / 60_000);
  const elapsedSec = Math.floor(((Date.now() - startTime) % 60_000) / 1000);

  console.log(`\n✅ Walk-forward completed successfully!`);
  console.log(`   Duration: ${elapsedMin}m ${elapsedSec}s`);
  console.log(`   Folds run: ${result.foldsRun}`);
  console.log(`   Fold IDs: ${result.foldIds.join(", ")}`);
  console.log(`   Evaluation mode: ${result.evaluationOnly}`);
  console.log(`   Fallback rate: ${(result.fallbackRate * 100).toFixed(2)}%`);
  if (result.warnings.length > 0) {
    console.log(`   Warnings: ${result.warnings.join("; ")}`);
  }
}

async function runPostFit(): Promise<void> {
  console.log("\n🔧 Running post-fit calibration and specialist computation...\n");

  // 1. Load accuracy-eligible validation predictions
  console.log("Loading validation predictions from DB...");
  const rows = await db
    .select({
      rawProbability: evaluationPredictionsTable.rawProbability,
      player1Id: evaluationPredictionsTable.player1Id,
      actualWinnerId: evaluationPredictionsTable.actualWinnerId,
    })
    .from(evaluationPredictionsTable)
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        eq(evaluationPredictionsTable.segment, "validation"),
        eq(evaluationPredictionsTable.includedInAccuracy, true),
      ),
    );

  console.log(`  ✓ Found ${rows.length} accuracy-eligible validation rows`);

  const points: CalibrationPoint[] = rows
    .filter((r) => r.rawProbability !== null && r.actualWinnerId !== null)
    .map((r) => ({
      rawProbability: (r.rawProbability as number) / 100,
      outcome: (r.actualWinnerId === r.player1Id ? 1 : 0) as 0 | 1,
    }));

  console.log(`  ✓ ${points.length} calibration points after null filtering`);

  if (points.length < 200) {
    throw new Error(`Too few calibration points (${points.length}) — need ≥200 to fit reliably`);
  }

  // 2. Fit the best calibration model
  console.log("Fitting calibration model (isotonic vs Platt)...");
  const liveFit = fitBestCalibration(points);
  console.log(`  ✓ Selected method: ${liveFit.method}`);
  console.log(`    - Isotonic LL: ${liveFit.isotonicHoldoutLogLoss?.toFixed(5)}`);
  console.log(`    - Platt LL: ${liveFit.plattHoldoutLogLoss?.toFixed(5)}`);
  console.log(`    - Holdout size: ${liveFit.holdoutSampleSize}`);
  console.log(`    - Knots: ${liveFit.knots.length}`);

  if (liveFit.holdoutSampleSize === 0) {
    throw new Error(
      "Refusing to activate degenerate calibration model: holdoutSampleSize is 0 (collapsed fit guard)",
    );
  }

  // 3. Get the date range from the validation window
  const [dateRange] = await db
    .select({
      minDate: sql<string>`min(scheduled_start_at)`,
      maxDate: sql<string>`max(scheduled_start_at)`,
    })
    .from(evaluationPredictionsTable)
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        eq(evaluationPredictionsTable.segment, "validation"),
      ),
    );

  // 4. Store the new calibration model
  console.log("Storing calibration model...");
  await db.update(calibrationModelsTable).set({ active: false }).where(eq(calibrationModelsTable.active, true));
  const [newModel] = await db
    .insert(calibrationModelsTable)
    .values({
      method: liveFit.method,
      mapping: liveFit.knots,
      validationSampleSize: points.length,
      validationDateRangeStart: dateRange?.minDate ? new Date(dateRange.minDate) : null,
      validationDateRangeEnd: dateRange?.maxDate ? new Date(dateRange.maxDate) : null,
      active: true,
      isotonicHoldoutLogLoss: liveFit.isotonicHoldoutLogLoss,
      plattHoldoutLogLoss: liveFit.plattHoldoutLogLoss,
      holdoutSampleSize: liveFit.holdoutSampleSize,
    })
    .returning({ id: calibrationModelsTable.id });
  console.log(`  ✓ Calibration model stored (id=${newModel.id})`);

  // 5. Compute specialist segment models
  console.log("Computing specialist segment models...");
  await computeAndStoreSpecialistSegments(liveFit.knots);
  console.log(`  ✓ Specialist models computed and stored`);

  // 6. Report what was produced
  const specialists = await db.select().from(specialistModelsTable);
  const active = specialists.filter((s) => s.meetsThreshold);
  const below = specialists.filter((s) => !s.meetsThreshold);
  
  console.log(`\n📋 Results:`);
  console.log(`   Total specialist segments: ${specialists.length}`);
  console.log(`   Meets threshold (active): ${active.length}`);
  console.log(`   Below threshold: ${below.length}`);
  
  if (active.length > 0) {
    console.log(`\n   Active specialists:`);
    for (const s of active) {
      const acc = s.accuracy ? (s.accuracy * 100).toFixed(2) : "N/A";
      console.log(`     • ${s.segmentKey} | hist=${s.historicalMatchCount} | val=${s.validationSampleSize} | acc=${acc}%`);
    }
  }
}

async function main(): Promise<void> {
  try {
    console.log("╔════════════════════════════════════════════════════════╗");
    console.log("║      Complete Walk-Forward Execution Pipeline         ║");
    console.log("║   (Evaluation + Calibration + Specialist Models)      ║");
    console.log("╚════════════════════════════════════════════════════════╝");

    // PHASE 1: Run walk-forward evaluation
    console.log("\n📍 PHASE 1: Running walk-forward evaluation...");
    await runWalkForward();

    // PHASE 2: Run post-fit
    console.log("\n📍 PHASE 2: Running post-fit operations...");
    await runPostFit();

    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║   ✅ WALK-FORWARD PIPELINE COMPLETED SUCCESSFULLY!    ║");
    console.log("║                                                        ║");
    console.log("║   ✓ Evaluation completed (4-fold cross-validation)    ║");
    console.log("║   ✓ Calibration model fitted (isotonic/Platt)         ║");
    console.log("║   ✓ Specialist models computed and stored             ║");
    console.log("║                                                        ║");
    console.log("║   Ready for STAGE 2: Candidate Configuration Building ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    process.exit(0);
  } catch (err: unknown) {
    const envHint = detectDbHostResolutionHint(err, "npx tsx scripts/runCompleteWalkForward.ts");
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    console.error("\n❌ Fatal error:", message);
    if (envHint) {
      console.error("Hint:", envHint);
    }
    if (stack) {
      console.error(stack);
    }
    process.exit(1);
  }
}

main();
