// Validation script for Prompt #5 matchup-difficulty signal.
//
// Goal:
// 1) Validate decile separation for the new rank-parity / Elo-gap fallback signal.
// 2) Check whether applying the signal to Data Quality reduces the high-end reversal
//    (high-DQ underperforming mid-DQ) on the same out-of-sample evaluation corpus.
//
// Usage (Real data in Replit):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/validateMatchupDifficultySignal.ts
//
// Usage (Mock local test):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/validateMatchupDifficultySignal.ts --mock

import { and, inArray } from "drizzle-orm";
import {
  db,
  evaluationPredictionsTable,
  historicalMatchesTable,
  pool,
  type EvaluationPredictionRow,
  type HistoricalMatchRow,
} from "@workspace/db";
import { computeMatchupDifficultySignal, adjustDataQualityForMatchupDifficulty } from "../services/predictionEngine/dataQuality";
import type { LiveFeatureSnapshot } from "../services/evaluation/types";
import type { EngineBreakdown } from "../services/predictionEngine";

type Entry = {
  row: EvaluationPredictionRow;
  engine: EngineBreakdown;
  dataQuality: number;
  historicalMatch: Pick<HistoricalMatchRow, "id" | "player1Rank" | "player2Rank"> | null;
  signal: ReturnType<typeof computeMatchupDifficultySignal>;
};

type MockEntry = {
  dataQuality: number;
  decisivenessScore: number;
  actualWinnerId: number | null;
  predictedWinnerId: number | null;
  calibratedProbability: number | null;
  player1Id: number;
  player2Id: number;
  rankGap: number | null;
};

// Generate synthetic entries with realistic patterns for local testing
function generateMockEntries(count: number = 5000): MockEntry[] {
  const entries: MockEntry[] = [];

  for (let i = 0; i < count; i++) {
    // Simulate varied decisiveness (0-100), roughly normal-ish distribution
    const decisivenessRaw = Math.random() ** 0.7 * 100;
    const decisivenessScore = Math.min(100, Math.max(0, decisivenessRaw + (Math.random() - 0.5) * 20));

    // Rank gap distribution (0-100, skewed toward smaller gaps)
    const rankGap = Math.random() ** 1.5 * 100;

    // Base DQ influenced by data availability (not decisiveness directly)
    const dataQualityRaw = Math.random() ** 0.6 * 100;
    let dataQuality = dataQualityRaw;

    // Adjust for lopsided matchups naturally having more data (slight correlation)
    if (decisivenessScore > 70) {
      dataQuality = Math.min(100, dataQuality + 10);
    }

    const signal = computeMatchupDifficultySignal({
      player1Rank: rankGap !== null ? Math.floor(Math.random() * 100) + 1 : null,
      player2Rank: rankGap !== null ? Math.floor(Math.random() * 100) + 1 : null,
      surfaceEloEdge: (Math.random() - 0.5) * 8,
    });

    // Calibrated probability: higher decisiveness should align better with true outcomes
    const noiseLevel = 1 - decisivenessScore / 100;
    const calibratedProb = 50 + (Math.random() - 0.5 + (Math.random() - 0.5)) * noiseLevel * 30;

    // Simulated outcome: higher decisiveness → higher accuracy
    const predictedWinnerId = Math.random() < 0.5 ? 100 + i : 200 + i;
    const actualWinnerId =
      Math.random() < 0.5 + decisivenessScore / 200
        ? predictedWinnerId // Correct prediction (higher at higher decisiveness)
        : predictedWinnerId === 100 + i
          ? 200 + i
          : 100 + i;

    entries.push({
      dataQuality,
      decisivenessScore: signal.decisivenessScore,
      actualWinnerId,
      predictedWinnerId,
      calibratedProbability: calibratedProb,
      player1Id: 100 + i,
      player2Id: 200 + i,
      rankGap,
    });
  }

  return entries;
}

function extractEngine(row: EvaluationPredictionRow): EngineBreakdown | null {
  const snapshot = row.featureSnapshot as unknown as Partial<LiveFeatureSnapshot> | null;
  const engine = snapshot?.engine as EngineBreakdown | undefined;
  return engine ?? null;
}

function extractDataQuality(row: EvaluationPredictionRow): number | null {
  const snapshot = row.featureSnapshot as unknown as Partial<LiveFeatureSnapshot> | null;
  return typeof snapshot?.dataQuality === "number" ? snapshot.dataQuality : null;
}

function bucketLabel(score: number): string {
  if (score < 20) return "0-20";
  if (score < 25) return "20-25";
  if (score < 45) return "25-45";
  if (score < 55) return "45-55";
  if (score < 65) return "55-65";
  if (score < 85) return "65-85";
  return "85-100";
}

function accuracy(rows: (EvaluationPredictionRow | MockEntry)[]): number {
  const graded = rows.filter((r) => r.actualWinnerId !== null && r.predictedWinnerId !== null);
  if (graded.length === 0) return 0;
  const correct = graded.filter((r) => r.actualWinnerId === r.predictedWinnerId).length;
  return (correct / graded.length) * 100;
}

function favoriteWinRateByConfidence(
  rows: (EvaluationPredictionRow | MockEntry)[],
): { favoriteWinRate: number; avgConfidence: number; gap: number } {
  const graded = rows.filter((r) => r.actualWinnerId !== null && r.calibratedProbability !== null);
  if (graded.length === 0) return { favoriteWinRate: 0, avgConfidence: 0, gap: 0 };

  let favoriteWins = 0;
  let confidenceSum = 0;
  for (const r of graded) {
    const p1 = (r.calibratedProbability as number) / 100;
    const favoriteIsP1 = p1 >= 0.5;
    const favoriteWon = favoriteIsP1 ? r.actualWinnerId === r.player1Id : r.actualWinnerId === r.player2Id;
    if (favoriteWon) favoriteWins++;
    confidenceSum += Math.max(p1, 1 - p1) * 100;
  }

  const favoriteWinRate = (favoriteWins / graded.length) * 100;
  const avgConfidence = confidenceSum / graded.length;
  return { favoriteWinRate, avgConfidence, gap: favoriteWinRate - avgConfidence };
}

function decileBuckets<T>(arr: T[], valueFn: (v: T) => number): Array<{ idx: number; rows: T[]; min: number; max: number }> {
  const sorted = [...arr].sort((a, b) => valueFn(a) - valueFn(b));
  const buckets: Array<{ idx: number; rows: T[]; min: number; max: number }> = [];
  if (sorted.length === 0) return buckets;

  const size = Math.max(1, Math.floor(sorted.length / 10));
  for (let i = 0; i < 10; i++) {
    const start = i * size;
    const end = i === 9 ? sorted.length : Math.min(sorted.length, (i + 1) * size);
    if (start >= sorted.length) break;
    const rows = sorted.slice(start, end);
    buckets.push({ idx: i + 1, rows, min: valueFn(rows[0]), max: valueFn(rows[rows.length - 1]) });
  }
  return buckets;
}

async function fetchOutOfSampleRows(): Promise<EvaluationPredictionRow[]> {
  const all = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(and(inArray(evaluationPredictionsTable.runKind, ["historical_test", "paper_trade", "live"]), inArray(evaluationPredictionsTable.status, ["graded"])));

  return all.filter((r) => (r.runKind === "historical_test" ? r.segment === "test" : true) && r.includedInAccuracy === true);
}

async function runRealValidation(entries: Entry[]): Promise<void> {
  console.log(`Out-of-sample graded rows analyzed`);
  console.log(`Signal source mix: rank-gap=${entries.filter((e) => e.signal.source === "rank-gap").length}, elo-fallback=${entries.filter((e) => e.signal.source === "elo-gap-fallback").length}`);

  // 1) Decile validation for decisiveness score
  console.log("\n=== Decile validation: matchup decisiveness score vs realized accuracy ===");
  const deciles = decileBuckets(entries, (e) => e.signal.decisivenessScore);
  for (const d of deciles) {
    const rowsInBucket = d.rows.map((r) => r.row);
    const acc = accuracy(rowsInBucket);
    const conf = favoriteWinRateByConfidence(rowsInBucket);
    console.log(
      `Decile ${d.idx} score ${d.min.toFixed(1)}-${d.max.toFixed(1)} | n=${rowsInBucket.length} | accuracy=${acc.toFixed(1)}% | favWin=${conf.favoriteWinRate.toFixed(1)}% | avgConf=${conf.avgConfidence.toFixed(1)}% | gap=${conf.gap.toFixed(1)}pt`,
    );
  }

  // 2) DQ reversal check before vs after adjustment
  const beforeBuckets = new Map<string, EvaluationPredictionRow[]>();
  const afterBuckets = new Map<string, EvaluationPredictionRow[]>();

  for (const e of entries) {
    const bLabel = bucketLabel(e.dataQuality);
    const adjusted = adjustDataQualityForMatchupDifficulty(e.dataQuality, e.signal);
    const aLabel = bucketLabel(adjusted);

    if (!beforeBuckets.has(bLabel)) beforeBuckets.set(bLabel, []);
    if (!afterBuckets.has(aLabel)) afterBuckets.set(aLabel, []);
    beforeBuckets.get(bLabel)!.push(e.row);
    afterBuckets.get(aLabel)!.push(e.row);
  }

  console.log("\n=== DQ bucket accuracy BEFORE adjustment ===");
  for (const label of ["0-20", "20-25", "25-45", "45-55", "55-65", "65-85", "85-100"]) {
    const bucketRows = beforeBuckets.get(label) ?? [];
    if (bucketRows.length === 0) continue;
    console.log(`DQ ${label}: n=${bucketRows.length}, accuracy=${accuracy(bucketRows).toFixed(1)}%`);
  }

  console.log("\n=== DQ bucket accuracy AFTER adjustment ===");
  for (const label of ["0-20", "20-25", "25-45", "45-55", "55-65", "65-85", "85-100"]) {
    const bucketRows = afterBuckets.get(label) ?? [];
    if (bucketRows.length === 0) continue;
    console.log(`DQ ${label}: n=${bucketRows.length}, accuracy=${accuracy(bucketRows).toFixed(1)}%`);
  }

  // 3) Top-end reversal KPI (high trust vs mid trust)
  const beforeHigh = entries.filter((e) => e.dataQuality >= 65).map((e) => e.row);
  const beforeMid = entries.filter((e) => e.dataQuality >= 45 && e.dataQuality < 65).map((e) => e.row);
  const afterHigh = entries
    .filter((e) => adjustDataQualityForMatchupDifficulty(e.dataQuality, e.signal) >= 65)
    .map((e) => e.row);
  const afterMid = entries
    .filter((e) => {
      const adjusted = adjustDataQualityForMatchupDifficulty(e.dataQuality, e.signal);
      return adjusted >= 45 && adjusted < 65;
    })
    .map((e) => e.row);

  const beforeHighAcc = accuracy(beforeHigh);
  const beforeMidAcc = accuracy(beforeMid);
  const afterHighAcc = accuracy(afterHigh);
  const afterMidAcc = accuracy(afterMid);

  console.log("\n=== Reversal check (high-trust vs mid-trust) ===");
  console.log(`Before: DQ>=65 accuracy=${beforeHighAcc.toFixed(1)}% (n=${beforeHigh.length}) vs DQ45-65 accuracy=${beforeMidAcc.toFixed(1)}% (n=${beforeMid.length}) | delta=${(beforeHighAcc - beforeMidAcc).toFixed(1)}pt`);
  console.log(`After : DQ>=65 accuracy=${afterHighAcc.toFixed(1)}% (n=${afterHigh.length}) vs DQ45-65 accuracy=${afterMidAcc.toFixed(1)}% (n=${afterMid.length}) | delta=${(afterHighAcc - afterMidAcc).toFixed(1)}pt`);
}

async function runMockValidation(entries: MockEntry[]): Promise<void> {
  console.log(`Mock evaluation corpus: ${entries.length} synthetic matchups`);
  console.log("(LOCAL TEST MODE: Synthetic data validates methodology without DB)");

  // 1) Decile validation for decisiveness score
  console.log("\n=== Decile validation: matchup decisiveness score vs realized accuracy ===");
  const deciles = decileBuckets(entries, (e) => e.decisivenessScore);
  for (const d of deciles) {
    const acc = accuracy(d.rows);
    const conf = favoriteWinRateByConfidence(d.rows);
    console.log(
      `Decile ${d.idx} score ${d.min.toFixed(1)}-${d.max.toFixed(1)} | n=${d.rows.length} | accuracy=${acc.toFixed(1)}% | favWin=${conf.favoriteWinRate.toFixed(1)}% | avgConf=${conf.avgConfidence.toFixed(1)}% | gap=${conf.gap.toFixed(1)}pt`,
    );
  }

  // 2) DQ reversal check before vs after adjustment
  const beforeBuckets = new Map<string, MockEntry[]>();
  const afterBuckets = new Map<string, MockEntry[]>();

  for (const e of entries) {
    const bLabel = bucketLabel(e.dataQuality);
    const signal = computeMatchupDifficultySignal({
      player1Rank: e.rankGap !== null ? 50 : null,
      player2Rank: e.rankGap !== null ? 50 - e.rankGap : null,
      surfaceEloEdge: 0,
    });
    const adjusted = adjustDataQualityForMatchupDifficulty(e.dataQuality, signal);
    const aLabel = bucketLabel(adjusted);

    if (!beforeBuckets.has(bLabel)) beforeBuckets.set(bLabel, []);
    if (!afterBuckets.has(aLabel)) afterBuckets.set(aLabel, []);
    beforeBuckets.get(bLabel)!.push(e);
    afterBuckets.get(aLabel)!.push(e);
  }

  console.log("\n=== DQ bucket accuracy BEFORE adjustment ===");
  for (const label of ["0-20", "20-25", "25-45", "45-55", "55-65", "65-85", "85-100"]) {
    const bucketRows = beforeBuckets.get(label) ?? [];
    if (bucketRows.length === 0) continue;
    console.log(`DQ ${label}: n=${bucketRows.length}, accuracy=${accuracy(bucketRows).toFixed(1)}%`);
  }

  console.log("\n=== DQ bucket accuracy AFTER adjustment ===");
  for (const label of ["0-20", "20-25", "25-45", "45-55", "55-65", "65-85", "85-100"]) {
    const bucketRows = afterBuckets.get(label) ?? [];
    if (bucketRows.length === 0) continue;
    console.log(`DQ ${label}: n=${bucketRows.length}, accuracy=${accuracy(bucketRows).toFixed(1)}%`);
  }

  // 3) Top-end reversal KPI (high trust vs mid trust)
  const beforeHigh = entries.filter((e) => e.dataQuality >= 65);
  const beforeMid = entries.filter((e) => e.dataQuality >= 45 && e.dataQuality < 65);
  const afterHigh = entries.filter((e) => {
    const signal = computeMatchupDifficultySignal({
      player1Rank: e.rankGap !== null ? 50 : null,
      player2Rank: e.rankGap !== null ? 50 - e.rankGap : null,
      surfaceEloEdge: 0,
    });
    return adjustDataQualityForMatchupDifficulty(e.dataQuality, signal) >= 65;
  });
  const afterMid = entries.filter((e) => {
    const signal = computeMatchupDifficultySignal({
      player1Rank: e.rankGap !== null ? 50 : null,
      player2Rank: e.rankGap !== null ? 50 - e.rankGap : null,
      surfaceEloEdge: 0,
    });
    const adjusted = adjustDataQualityForMatchupDifficulty(e.dataQuality, signal);
    return adjusted >= 45 && adjusted < 65;
  });

  const beforeHighAcc = accuracy(beforeHigh);
  const beforeMidAcc = accuracy(beforeMid);
  const afterHighAcc = accuracy(afterHigh);
  const afterMidAcc = accuracy(afterMid);

  console.log("\n=== Reversal check (high-trust vs mid-trust) ===");
  console.log(`Before: DQ>=65 accuracy=${beforeHighAcc.toFixed(1)}% (n=${beforeHigh.length}) vs DQ45-65 accuracy=${beforeMidAcc.toFixed(1)}% (n=${beforeMid.length}) | delta=${(beforeHighAcc - beforeMidAcc).toFixed(1)}pt`);
  console.log(`After : DQ>=65 accuracy=${afterHighAcc.toFixed(1)}% (n=${afterHigh.length}) vs DQ45-65 accuracy=${afterMidAcc.toFixed(1)}% (n=${afterMid.length}) | delta=${(afterHighAcc - afterMidAcc).toFixed(1)}pt`);
}

async function main(): Promise<void> {
  const useMock = process.argv.includes("--mock");

  if (useMock) {
    console.log("╔════════════════════════════════════════════════════════╗");
    console.log("║  Matchup Difficulty Signal Validation (Mock Test Mode)  ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    const mockEntries = generateMockEntries(5000);
    await runMockValidation(mockEntries);
    return;
  }

  // Real data mode
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║  Matchup Difficulty Signal Validation (Real Data Mode)  ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  const rows = await fetchOutOfSampleRows();
  const historicalIds = [...new Set(rows.map((r) => r.historicalMatchId).filter((id): id is number => typeof id === "number"))];

  const historicalRows = historicalIds.length
    ? await db
        .select({
          id: historicalMatchesTable.id,
          player1Rank: historicalMatchesTable.player1Rank,
          player2Rank: historicalMatchesTable.player2Rank,
        })
        .from(historicalMatchesTable)
        .where(inArray(historicalMatchesTable.id, historicalIds))
    : [];

  const historicalById = new Map(historicalRows.map((r) => [r.id, r]));

  const entries: Entry[] = [];
  for (const row of rows) {
    const engine = extractEngine(row);
    const dataQuality = extractDataQuality(row);
    if (!engine || dataQuality === null || row.calibratedProbability === null) continue;

    const h = typeof row.historicalMatchId === "number" ? historicalById.get(row.historicalMatchId) ?? null : null;
    const surfaceEloEdge = (engine.surfaceElo.eloDifference ?? 0) / 8;
    const signal = computeMatchupDifficultySignal({
      player1Rank: h?.player1Rank ?? null,
      player2Rank: h?.player2Rank ?? null,
      surfaceEloEdge,
    });

    entries.push({ row, engine, dataQuality, historicalMatch: h, signal });
  }

  await runRealValidation(entries);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
