/**
 * Compare frozen vs dynamic walk-forward calibration on the same historical test folds.
 *
 * This script mirrors the existing evaluation-only/training walk-forward split without
 * mutating evaluation tables:
 *   - frozen: applies the currently active deployed calibration to every fold
 *   - dynamic: fits a fold-specific calibration on each validation slice, then applies it
 *              to that fold's test slice
 *
 * Important nuance from the current implementation:
 *   - both modes use the same preloaded historical scoring context
 *   - both modes use the same previously-persisted specialist snapshot during scoring
 *   - the meaningful within-run difference today is frozen deployed calibration vs
 *     dynamic fold-fit calibration on identical test windows
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backtestFrozenVsDynamicWeights.ts
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backtestFrozenVsDynamicWeights.ts --start=2025-01-01 --end=2025-12-31
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backtestFrozenVsDynamicWeights.ts --folds=4 --warmup=0.4
 */

import { asc, gte, lte, and, eq } from "drizzle-orm";
import { db, historicalMatchesTable, calibrationModelsTable } from "@workspace/db";
import { buildPlayerIdentityIndex } from "../services/tennisData/playerIdentity";
import { buildMatchHistoryIndex } from "../services/historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../services/predictionEngine/opponentStrength";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "../services/evaluation/historicalScoring";
import { getActiveSpecialistSegments } from "../services/evaluation/specialistWeights";
import { fitBestCalibration, isKnownBadCascadeRow, applyCalibration } from "../services/evaluation/calibration";
import { getPredictionSettings } from "../services/evaluation/settle";
import type { CalibrationKnot, RetirementRule } from "../services/evaluation/types";

type HistoricalMatch = typeof historicalMatchesTable.$inferSelect;

interface ParsedArgs {
  start?: string;
  end?: string;
  folds: number;
  warmupFraction: number;
}

interface ScoredMatchRow {
  matchId: number;
  rawProbability: number | null;
  player1Won: boolean;
  includedInAccuracy: boolean;
  tieBreakerApplied: boolean;
  lockedAt: Date;
  player1Id: string;
  player2Id: string;
  actualWinnerId: string | null;
}

interface AccuracySummary {
  label: string;
  accuracyPct: number | null;
  gradedCount: number;
  correctCount: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const read = (name: string): string | undefined => {
    const direct = argv.find((arg) => arg.startsWith(`${name}=`));
    if (direct) return direct.slice(name.length + 1);
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const foldsRaw = read("--folds");
  const warmupRaw = read("--warmup");
  const folds = foldsRaw ? Number.parseInt(foldsRaw, 10) : 4;
  const warmupFraction = warmupRaw ? Number.parseFloat(warmupRaw) : 0.4;

  if (!Number.isInteger(folds) || folds < 1) throw new Error("--folds must be an integer >= 1");
  if (!Number.isFinite(warmupFraction) || warmupFraction <= 0 || warmupFraction >= 1) {
    throw new Error("--warmup must be a number between 0 and 1 (exclusive)");
  }

  return {
    start: read("--start"),
    end: read("--end"),
    folds,
    warmupFraction,
  };
}

function classifyResult(match: HistoricalMatch): "normal" | "retired" | "walkover" | "cancelled" {
  if (match.cancelled) return "cancelled";
  if (match.walkover) return "walkover";
  if (match.retired) return "retired";
  return "normal";
}

function buildScopedConditions(args: ParsedArgs) {
  const conditions = [];
  if (args.start) {
    conditions.push(gte(historicalMatchesTable.scheduledStartAt, new Date(`${args.start}T00:00:00.000Z`)));
  }
  if (args.end) {
    conditions.push(lte(historicalMatchesTable.scheduledStartAt, new Date(`${args.end}T23:59:59.999Z`)));
  }
  return conditions;
}

async function scoreMatchesRaw(
  matches: HistoricalMatch[],
  scoringContext: HistoricalScoringContext,
  retirementRule: RetirementRule,
): Promise<ScoredMatchRow[]> {
  const rows: ScoredMatchRow[] = [];

  for (const match of matches) {
    const resultType = classifyResult(match);
    const isVoid = resultType === "walkover" || resultType === "cancelled";
    const player1Won = match.winnerId === match.player1Id;
    const scored = scoreHistoricalMatch(match, scoringContext);
    const rawProbability = scored?.rawProbability ?? null;
    const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included") && rawProbability !== null;

    rows.push({
      matchId: match.id,
      rawProbability,
      player1Won,
      includedInAccuracy,
      tieBreakerApplied: scored?.snapshot.engine.tieBreakerApplied ?? false,
      lockedAt: new Date(),
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      actualWinnerId: match.winnerId,
    });
  }

  return rows;
}

function summarizeAccuracy(label: string, rows: ScoredMatchRow[], mapping: CalibrationKnot[]): AccuracySummary {
  const graded = rows.filter((row) => row.includedInAccuracy && row.rawProbability !== null && row.actualWinnerId !== null);
  const correct = graded.filter((row) => {
    const calibrated = applyCalibration(mapping, row.rawProbability as number);
    const predictedWinnerId = calibrated >= 0.5 ? row.player1Id : row.player2Id;
    return predictedWinnerId === row.actualWinnerId;
  }).length;

  return {
    label,
    gradedCount: graded.length,
    correctCount: correct,
    accuracyPct: graded.length > 0 ? Math.round((correct / graded.length) * 1000) / 10 : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.start && args.end && args.start > args.end) {
    throw new Error("--start must be <= --end");
  }

  const scopedConditions = buildScopedConditions(args);
  const allMatches = await db
    .select()
    .from(historicalMatchesTable)
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  const scopedMatches = scopedConditions.length > 0
    ? await db
        .select()
        .from(historicalMatchesTable)
        .where(and(...scopedConditions))
        .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id))
    : allMatches;

  const eligible = scopedMatches.filter((match) => !match.cancelled);
  if (eligible.length < 20) {
    throw new Error(`Not enough eligible matches in scope: ${eligible.length}. Need at least 20.`);
  }

  const warmupEndIdx = Math.floor(eligible.length * args.warmupFraction);
  const scorable = eligible.slice(warmupEndIdx);
  if (scorable.length < args.folds * 6) {
    throw new Error(`Not enough post-warmup matches (${scorable.length}) for ${args.folds} folds.`);
  }

  const [activeCalibration] = await db
    .select()
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);
  const frozenMapping = activeCalibration?.mapping as CalibrationKnot[] | null;
  const frozenOrIdentity = frozenMapping ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];

  const settings = await getPredictionSettings();
  const identityIndex = await buildPlayerIdentityIndex();
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
  const scoringContext: HistoricalScoringContext = {
    matchHistory: buildMatchHistoryIndex(allMatches),
    eloHistory: await buildEloHistoryIndex(identityIndex),
    identityIndex,
    specialistRowsBySegmentKey,
  };

  const chunkSize = Math.floor(scorable.length / args.folds);
  const frozenTestRows: ScoredMatchRow[] = [];
  const dynamicTestRowsWithMapping: Array<{ row: ScoredMatchRow; mapping: CalibrationKnot[] }> = [];

  for (let fold = 0; fold < args.folds; fold++) {
    const chunkStart = fold * chunkSize;
    const chunkEnd = fold === args.folds - 1 ? scorable.length : chunkStart + chunkSize;
    const chunk = scorable.slice(chunkStart, chunkEnd);
    if (chunk.length < 4) continue;

    const half = Math.floor(chunk.length / 2);
    const validationMatches = chunk.slice(0, half);
    const testMatches = chunk.slice(half);

    const validationRows = await scoreMatchesRaw(validationMatches, scoringContext, (settings.retirementRule as RetirementRule) ?? "excluded");
    const dynamicValidationPoints = validationRows
      .filter((row) => row.includedInAccuracy && row.rawProbability !== null)
      .filter((row) => !isKnownBadCascadeRow(row.lockedAt, row.tieBreakerApplied))
      .map((row) => ({ rawProbability: row.rawProbability as number, outcome: (row.player1Won ? 1 : 0) as 0 | 1 }));

    const dynamicMapping = dynamicValidationPoints.length > 0
      ? fitBestCalibration(dynamicValidationPoints).knots
      : [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    const testRows = await scoreMatchesRaw(testMatches, scoringContext, (settings.retirementRule as RetirementRule) ?? "excluded");
    frozenTestRows.push(...testRows);
    dynamicTestRowsWithMapping.push(...testRows.map((row) => ({ row, mapping: dynamicMapping })));
  }

  const frozenSummary = summarizeAccuracy("frozen", frozenTestRows, frozenOrIdentity);
  const dynamicSummaryRows = dynamicTestRowsWithMapping
    .filter(({ row }) => row.includedInAccuracy && row.rawProbability !== null && row.actualWinnerId !== null);
  const dynamicCorrect = dynamicSummaryRows.filter(({ row, mapping }) => {
    const calibrated = applyCalibration(mapping, row.rawProbability as number);
    const predictedWinnerId = calibrated >= 0.5 ? row.player1Id : row.player2Id;
    return predictedWinnerId === row.actualWinnerId;
  }).length;
  const dynamicSummary: AccuracySummary = {
    label: "dynamic",
    gradedCount: dynamicSummaryRows.length,
    correctCount: dynamicCorrect,
    accuracyPct: dynamicSummaryRows.length > 0 ? Math.round((dynamicCorrect / dynamicSummaryRows.length) * 1000) / 10 : null,
  };

  const delta = frozenSummary.accuracyPct !== null && dynamicSummary.accuracyPct !== null
    ? Math.round((dynamicSummary.accuracyPct - frozenSummary.accuracyPct) * 10) / 10
    : null;

  console.log("=== Frozen vs Dynamic Backtest ===");
  console.log(`scope_start=${args.start ?? "FULL"}`);
  console.log(`scope_end=${args.end ?? "FULL"}`);
  console.log(`folds=${args.folds}`);
  console.log(`warmup_fraction=${args.warmupFraction}`);
  console.log(`eligible_matches=${eligible.length}`);
  console.log(`test_rows_frozen=${frozenSummary.gradedCount}`);
  console.log(`test_rows_dynamic=${dynamicSummary.gradedCount}`);
  console.log(`frozen_accuracy=${frozenSummary.accuracyPct ?? "null"}% (${frozenSummary.correctCount}/${frozenSummary.gradedCount})`);
  console.log(`dynamic_accuracy=${dynamicSummary.accuracyPct ?? "null"}% (${dynamicSummary.correctCount}/${dynamicSummary.gradedCount})`);
  console.log(`delta_pp=${delta ?? "null"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
