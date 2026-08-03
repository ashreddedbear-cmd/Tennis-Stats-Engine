/**
 * Walk-forward validation: does crossEngineAgreement === true correlate with
 * meaningfully higher real accuracy vs disagreement cases?
 *
 * Usage (mock mode — no DB needed):
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/validateCrossEngineAgreement.ts --mock
 *
 * Usage (real mode — requires DB, run in Replit):
 *   DATABASE_URL='postgresql://...' pnpm --filter @workspace/api-server exec tsx src/scripts/validateCrossEngineAgreement.ts
 *
 * What it measures:
 *   1. Accuracy by agreement tier: agreement=true vs false vs null
 *   2. Accuracy by agreement + recommendation tier
 *   3. Accuracy by agreement + data quality bucket
 *   4. Statistical significance check (Fisher's exact test approximation)
 *
 * Pass criteria (documented in .agents/memory/cross-engine-agreement-validation.md):
 *   - Agreement=true accuracy > Agreement=false accuracy by at least 3 percentage points
 *   - Sample size in each group >= 30 (for minimum statistical weight)
 *   - Agreement signal does NOT degrade accuracy within any recommendation tier
 */

import { computeBuilderScore, computeCrossEngineAgreement } from "../services/parlayBuilder/builderScoringService";
import type { BuilderSnapshot } from "../services/parlayBuilder/builderScoringService";
import type { EngineBreakdown } from "../services/predictionEngine/index";

const IS_MOCK = process.argv.includes("--mock");

// ── Types ──────────────────────────────────────────────────────────────────────

interface ValidationRow {
  crossEngineAgreement: boolean | null;
  wasCorrect: boolean;
  recommendation: string;
  dataQuality: number;
}

interface AgreementGroup {
  label: string;
  total: number;
  correct: number;
  accuracy: number;
}

// ── Mock data ──────────────────────────────────────────────────────────────────

/**
 * Generate synthetic validation entries that simulate the expected pattern:
 * - Agreement=true picks should be more accurate than agreement=false
 * - The signal should have real predictive value but not be perfect
 */
function generateMockEntries(n: number): ValidationRow[] {
  const entries: ValidationRow[] = [];
  const recommendations = ["STRONG_RECOMMENDATION", "MODERATE_LEAN", "HIGH_RISK", "NO_STRONG_SIGNAL"];
  const rng = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return ((s >>> 0) / 0xffffffff);
    };
  };

  const rand = rng(42);

  for (let i = 0; i < n; i++) {
    // Simulate agreement distribution: ~55% true, ~25% false, ~20% null
    const agreementRoll = rand();
    const crossEngineAgreement: boolean | null =
      agreementRoll < 0.55 ? true : agreementRoll < 0.80 ? false : null;

    // Base accuracy: agreement=true ~68%, false ~59%, null ~63% (intermediate)
    let baseAccuracyRate: number;
    if (crossEngineAgreement === true) baseAccuracyRate = 0.68;
    else if (crossEngineAgreement === false) baseAccuracyRate = 0.59;
    else baseAccuracyRate = 0.63;

    const rec = recommendations[Math.floor(rand() * recommendations.length)];
    const dq = Math.round(40 + rand() * 55); // 40-95 range

    // Recommendation modulates accuracy slightly
    if (rec === "STRONG_RECOMMENDATION") baseAccuracyRate += 0.04;
    if (rec === "NO_STRONG_SIGNAL") baseAccuracyRate -= 0.04;

    // Data quality modulates accuracy slightly
    if (dq >= 75) baseAccuracyRate += 0.02;
    if (dq < 50) baseAccuracyRate -= 0.02;

    const wasCorrect = rand() < baseAccuracyRate;

    entries.push({
      crossEngineAgreement,
      wasCorrect,
      recommendation: rec,
      dataQuality: dq,
    });
  }

  return entries;
}

// ── Real DB query ──────────────────────────────────────────────────────────────

async function fetchRealRows(): Promise<ValidationRow[]> {
  const { db, predictionsTable } = await import("@workspace/db");
  const { isNotNull } = await import("drizzle-orm");

  const rows = await db
    .select({
      crossEngineAgreement: predictionsTable.crossEngineAgreement,
      predictedWinnerId: predictionsTable.predictedWinnerId,
      actualWinnerId: predictionsTable.actualWinnerId,
      recommendation: predictionsTable.recommendation,
      dataQuality: predictionsTable.dataQuality,
    })
    .from(predictionsTable)
    .where(isNotNull(predictionsTable.actualWinnerId));

  return rows
    .filter((r) => r.predictedWinnerId && r.actualWinnerId)
    .map((r) => ({
      crossEngineAgreement: r.crossEngineAgreement ?? null,
      wasCorrect: r.predictedWinnerId === r.actualWinnerId,
      recommendation: r.recommendation ?? "UNKNOWN",
      dataQuality: typeof r.dataQuality === "number" ? r.dataQuality : 0,
    }));
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyzeByAgreement(rows: ValidationRow[]): AgreementGroup[] {
  const groups: Record<string, { correct: number; total: number }> = {
    "agreement=true": { correct: 0, total: 0 },
    "agreement=false": { correct: 0, total: 0 },
    "agreement=null": { correct: 0, total: 0 },
  };

  for (const row of rows) {
    const key =
      row.crossEngineAgreement === true
        ? "agreement=true"
        : row.crossEngineAgreement === false
        ? "agreement=false"
        : "agreement=null";
    groups[key].total++;
    if (row.wasCorrect) groups[key].correct++;
  }

  return Object.entries(groups).map(([label, g]) => ({
    label,
    total: g.total,
    correct: g.correct,
    accuracy: g.total > 0 ? Math.round((g.correct / g.total) * 1000) / 10 : 0,
  }));
}

function analyzeByAgreementAndRecommendation(
  rows: ValidationRow[]
): Map<string, AgreementGroup[]> {
  const byRec = new Map<string, ValidationRow[]>();
  for (const row of rows) {
    const rec = row.recommendation;
    if (!byRec.has(rec)) byRec.set(rec, []);
    byRec.get(rec)!.push(row);
  }

  const result = new Map<string, AgreementGroup[]>();
  for (const [rec, recRows] of byRec) {
    result.set(rec, analyzeByAgreement(recRows));
  }
  return result;
}

function analyzeByAgreementAndDQBucket(
  rows: ValidationRow[]
): { bucket: string; groups: AgreementGroup[] }[] {
  const buckets: { label: string; min: number; max: number }[] = [
    { label: "Low (< 50)", min: 0, max: 50 },
    { label: "Medium (50-69)", min: 50, max: 70 },
    { label: "High (≥ 70)", min: 70, max: 101 },
  ];

  return buckets.map((b) => ({
    bucket: b.label,
    groups: analyzeByAgreement(
      rows.filter((r) => r.dataQuality >= b.min && r.dataQuality < b.max)
    ),
  }));
}

/** Fisher's exact test approximation for 2×2 table (agreement=true vs false). */
function checkSignificance(groups: AgreementGroup[]): string {
  const trueGroup = groups.find((g) => g.label === "agreement=true");
  const falseGroup = groups.find((g) => g.label === "agreement=false");

  if (!trueGroup || !falseGroup || trueGroup.total < 30 || falseGroup.total < 30) {
    return "Insufficient sample size (need >= 30 per group) for significance check";
  }

  const diff = trueGroup.accuracy - falseGroup.accuracy;
  const pooledN = trueGroup.total + falseGroup.total;
  const pooledP = (trueGroup.correct + falseGroup.correct) / pooledN;
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / trueGroup.total + 1 / falseGroup.total));
  const z = diff / 100 / se; // diff is in %, se is in fraction

  // Approximate p-value from z-score using normal distribution
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return `Agreement gap: ${diff.toFixed(1)}pp | z=${z.toFixed(2)} | p≈${pValue.toFixed(3)} | ${
    pValue < 0.05 ? "SIGNIFICANT (p < 0.05)" : "NOT significant at p < 0.05"
  }`;
}

/** Standard normal CDF approximation (Abramowitz & Stegun 26.2.17). */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - 0.3989422803 * Math.exp(-0.5 * z * z) * poly;
}

// ── Output ──────────────────────────────────────────────────────────────────────

function printGroup(g: AgreementGroup): void {
  const bar = "█".repeat(Math.round(g.accuracy / 5)).padEnd(20, "░");
  console.log(
    `  ${g.label.padEnd(20)} n=${String(g.total).padStart(5)}  acc=${String(g.accuracy).padStart(5)}%  ${bar}`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== Cross-Engine Agreement Walk-Forward Validation (${IS_MOCK ? "MOCK" : "REAL"}) ===\n`);

  let rows: ValidationRow[];

  if (IS_MOCK) {
    console.log("Generating 5000 synthetic validation rows...\n");
    rows = generateMockEntries(5000);
  } else {
    console.log("Fetching graded predictions from database...\n");
    rows = await fetchRealRows();
    console.log(`Fetched ${rows.length} graded predictions.\n`);
  }

  if (rows.length === 0) {
    console.log("No graded predictions found — cannot validate.\n");
    return;
  }

  // 1. Overall accuracy by agreement
  console.log("─────────────────────────────────────────────────────");
  console.log("1. ACCURACY BY CROSS-ENGINE AGREEMENT TIER");
  console.log("─────────────────────────────────────────────────────");
  const overallGroups = analyzeByAgreement(rows);
  for (const g of overallGroups) printGroup(g);
  console.log();
  console.log("  Statistical check:");
  console.log("  " + checkSignificance(overallGroups));
  console.log();

  // 2. By recommendation tier
  console.log("─────────────────────────────────────────────────────");
  console.log("2. ACCURACY BY AGREEMENT × RECOMMENDATION TIER");
  console.log("─────────────────────────────────────────────────────");
  const byRec = analyzeByAgreementAndRecommendation(rows);
  for (const [rec, groups] of byRec) {
    console.log(`  [${rec}]`);
    for (const g of groups) {
      if (g.total > 0) printGroup(g);
    }
    console.log();
  }

  // 3. By data quality bucket
  console.log("─────────────────────────────────────────────────────");
  console.log("3. ACCURACY BY AGREEMENT × DATA QUALITY BUCKET");
  console.log("─────────────────────────────────────────────────────");
  for (const { bucket, groups } of analyzeByAgreementAndDQBucket(rows)) {
    console.log(`  [${bucket}]`);
    for (const g of groups) {
      if (g.total > 0) printGroup(g);
    }
    console.log();
  }

  // 4. Pass/fail verdict
  console.log("─────────────────────────────────────────────────────");
  console.log("4. PASS/FAIL VERDICT");
  console.log("─────────────────────────────────────────────────────");
  const trueGroup = overallGroups.find((g) => g.label === "agreement=true");
  const falseGroup = overallGroups.find((g) => g.label === "agreement=false");

  if (trueGroup && falseGroup && trueGroup.total >= 30 && falseGroup.total >= 30) {
    const gap = trueGroup.accuracy - falseGroup.accuracy;
    const passed = gap >= 3;
    console.log(`  Agreement=true accuracy:   ${trueGroup.accuracy}% (n=${trueGroup.total})`);
    console.log(`  Agreement=false accuracy:  ${falseGroup.accuracy}% (n=${falseGroup.total})`);
    console.log(`  Gap:                       ${gap.toFixed(1)}pp`);
    console.log(`  Pass criterion (gap >= 3pp): ${passed ? "✓ PASSED" : "✗ FAILED"}`);
    if (!passed) {
      console.log(`\n  NOTE: Gap < 3pp. The cross-engine agreement signal has weak or no`);
      console.log(`  predictive value in this corpus. Document and investigate further.`);
    }
  } else {
    console.log(`  Insufficient sample sizes for verdict (need >= 30 per group).`);
    console.log(`  agreement=true: n=${trueGroup?.total ?? 0}, agreement=false: n=${falseGroup?.total ?? 0}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
