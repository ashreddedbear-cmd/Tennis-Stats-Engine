/**
 * Task #77 one-time operational script: richer-identity-resolution full-corpus Elo rebuild.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx src/scripts/eloOpponentResolutionRebuild.ts
 *
 * Does NOT write to `evaluation_predictions`/`evaluation_runs` (those are the walk-forward
 * fit/out-of-sample-test ledger) -- everything here is computed in memory and written to a
 * standalone report file, mirroring `ablation.ts`'s existing pattern for diagnostic replays
 * against the frozen historical corpus.
 *
 * "Before" vs "after" isolates exactly the causal effect of #77's own change (richer opponent
 * identity resolution) while holding #76's baseline/shrink mechanism fixed in both: "before" is
 * produced by calling the SAME current opponent-resolution functions with no `identity` index
 * (their behavior when `identity` is omitted is byte-for-byte identical to the pre-#77 exact-id-
 * match-only behavior, since the identity parameter is purely additive) -- "after" passes the
 * real, whole-corpus identity index. No git stash is used or needed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db, historicalMatchesTable, matchFeatureSnapshotsTable, type HistoricalMatchRow, type MatchFeatureSnapshotRow } from "@workspace/db";
import { asc, gt } from "drizzle-orm";
import { runPredictionEngine } from "../services/predictionEngine";
import { computeSurfaceEloModule } from "../services/predictionEngine/surfaceElo";
import { buildEloHistoryIndex, resolveOpponentStrengthFromIndex, type EloHistoryIndex } from "../services/predictionEngine/opponentStrength";
import { buildMatchHistoryIndex, reconstructHeadToHead, reconstructPlayerMatchHistory, type MatchHistoryIndex } from "../services/historicalData/matchRecordReconstruction";
import { buildPlayerIdentityIndex, type PlayerIdentityIndex } from "../services/tennisData/playerIdentity";
import { eloFallbackTracker } from "../services/predictionEngine/fallbackTracking";
import { brierScore, logLoss } from "../services/evaluation/calibration";
import { computeECE } from "../services/evaluation/metrics";
import type { MatchFormat, PlayerProfile, Surface, TournamentLevel } from "../services/tennisData/types";

const CAP = 4000;
const SNAPSHOT_BACKUP_BATCH_SIZE = 1_000;

export interface SnapshotBackupResult {
  backupPath: string;
  totalRows: number;
  batchesCompleted: number;
  finalSizeBytes: number;
  lastExportedRowId: number | null;
}

interface SnapshotBackupFile {
  writeFile(data: string): Promise<void>;
  close(): Promise<void>;
}

interface SnapshotBackupFiles {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  open(path: string, flags: string): Promise<SnapshotBackupFile>;
  rename(source: string, destination: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
}

export async function backupMatchFeatureSnapshots(options: {
  backupDir: string;
  fetchBatch: (lastId: number) => Promise<MatchFeatureSnapshotRow[]>;
  files?: SnapshotBackupFiles;
  batchSize?: number;
  finalFilename?: string;
}): Promise<SnapshotBackupResult> {
  const files = options.files ?? fs;
  const batchSize = options.batchSize ?? SNAPSHOT_BACKUP_BATCH_SIZE;
  const backupPath = path.join(options.backupDir, options.finalFilename ?? "match_feature_snapshots_backup_2026-07-13.jsonl");
  const partialPath = `${backupPath}.partial`;
  await files.mkdir(options.backupDir, { recursive: true });

  let output: SnapshotBackupFile | null = null;
  let totalRows = 0;
  let batchesCompleted = 0;
  let lastExportedRowId = 0;
  try {
    output = await files.open(partialPath, "w");
    while (true) {
      const rows = await options.fetchBatch(lastExportedRowId);
      if (rows.length === 0) break;
      for (const row of rows) {
        await output.writeFile(`${JSON.stringify(row)}\n`);
        totalRows += 1;
        lastExportedRowId = row.id;
      }
      batchesCompleted += 1;
    }
    await output.close();
    output = null;
    await files.rename(partialPath, backupPath);
    const stats = await files.stat(backupPath);
    return { backupPath, totalRows, batchesCompleted, finalSizeBytes: stats.size, lastExportedRowId: totalRows > 0 ? lastExportedRowId : null };
  } catch (error) {
    await output?.close().catch(() => undefined);
    throw new Error(`Snapshot backup failed; partial file preserved at ${partialPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function minimalProfile(id: string, name: string): PlayerProfile {
  return { id, name, countryCode: null, currentRank: null, tour: null, age: null, plays: null, fullName: null };
}

interface ScoreResult {
  rawProbability: number; // 0-1, player1 win prob
  predictedWinnerId: string;
}

/** Scores one historical match with an explicit choice of eloHistory/identity index -- lets the caller compare "before" (no identity) vs "after" (real identity) using the exact same production code path. */
function scoreMatch(
  match: HistoricalMatchRow,
  matchHistory: MatchHistoryIndex,
  eloHistory: EloHistoryIndex,
  identity: PlayerIdentityIndex | undefined,
): ScoreResult | null {
  if (!match.surface || !match.matchFormat) return null;
  const surface = match.surface as Surface;
  const matchFormat = match.matchFormat as MatchFormat;

  const player1Matches = reconstructPlayerMatchHistory(matchHistory, match.player1Id, match.cutoffAt);
  const player2Matches = reconstructPlayerMatchHistory(matchHistory, match.player2Id, match.cutoffAt);
  if (player1Matches.length === 0 || player2Matches.length === 0) return null;

  const player1OpponentStrength = resolveOpponentStrengthFromIndex(player1Matches, eloHistory, identity);
  const player2OpponentStrength = resolveOpponentStrengthFromIndex(player2Matches, eloHistory, identity);
  const headToHead = reconstructHeadToHead(matchHistory, match.player1Id, match.player2Id, match.cutoffAt);

  const output = runPredictionEngine({
    player1: minimalProfile(match.player1Id, match.player1Name),
    player2: minimalProfile(match.player2Id, match.player2Name),
    player1Matches,
    player2Matches,
    headToHead,
    surface,
    matchFormat,
    player1OpponentElo: player1OpponentStrength.lookup,
    player2OpponentElo: player2OpponentStrength.lookup,
    tournamentName: match.tournamentName,
    weather: null,
    segment: null,
    simulatorAdoption: null,
    activeCalibration: null,
  });

  const rawProbability = output.rawEnsembleProbability / 100;
  return { rawProbability, predictedWinnerId: rawProbability >= 0.5 ? match.player1Id : match.player2Id };
}

export interface VerificationHistoryCache {
  playerHistory: Map<string, ReturnType<typeof reconstructPlayerMatchHistory>>;
  headToHead: Map<string, ReturnType<typeof reconstructHeadToHead>>;
}

export function createVerificationHistoryCache(): VerificationHistoryCache {
  return { playerHistory: new Map(), headToHead: new Map() };
}

export function cachedPlayerHistory(cache: VerificationHistoryCache, matchHistory: MatchHistoryIndex, playerId: string, cutoffAt: Date): ReturnType<typeof reconstructPlayerMatchHistory> {
  const key = `${playerId}\u0000${cutoffAt.getTime()}`;
  const existing = cache.playerHistory.get(key);
  if (existing) return existing;
  const history = reconstructPlayerMatchHistory(matchHistory, playerId, cutoffAt);
  cache.playerHistory.set(key, history);
  return history;
}

export function cachedHeadToHead(cache: VerificationHistoryCache, matchHistory: MatchHistoryIndex, player1Id: string, player2Id: string, cutoffAt: Date): ReturnType<typeof reconstructHeadToHead> {
  const key = `${player1Id}\u0000${player2Id}\u0000${cutoffAt.getTime()}`;
  const existing = cache.headToHead.get(key);
  if (existing) return existing;
  const h2h = reconstructHeadToHead(matchHistory, player1Id, player2Id, cutoffAt);
  cache.headToHead.set(key, h2h);
  return h2h;
}

function scoreMatchWithVerificationCache(match: HistoricalMatchRow, matchHistory: MatchHistoryIndex, eloHistory: EloHistoryIndex, identity: PlayerIdentityIndex | undefined, cache: VerificationHistoryCache): ScoreResult | null {
  if (!match.surface || !match.matchFormat) return null;
  const player1Matches = cachedPlayerHistory(cache, matchHistory, match.player1Id, match.cutoffAt);
  const player2Matches = cachedPlayerHistory(cache, matchHistory, match.player2Id, match.cutoffAt);
  if (player1Matches.length === 0 || player2Matches.length === 0) return null;

  const player1OpponentStrength = resolveOpponentStrengthFromIndex(player1Matches, eloHistory, identity);
  const player2OpponentStrength = resolveOpponentStrengthFromIndex(player2Matches, eloHistory, identity);
  const headToHead = cachedHeadToHead(cache, matchHistory, match.player1Id, match.player2Id, match.cutoffAt);
  const output = runPredictionEngine({
    player1: minimalProfile(match.player1Id, match.player1Name),
    player2: minimalProfile(match.player2Id, match.player2Name),
    player1Matches,
    player2Matches,
    headToHead,
    surface: match.surface as Surface,
    matchFormat: match.matchFormat as MatchFormat,
    player1OpponentElo: player1OpponentStrength.lookup,
    player2OpponentElo: player2OpponentStrength.lookup,
    tournamentName: match.tournamentName,
    weather: null,
    segment: null,
    simulatorAdoption: null,
    activeCalibration: null,
  });
  const rawProbability = output.rawEnsembleProbability / 100;
  return { rawProbability, predictedWinnerId: rawProbability >= 0.5 ? match.player1Id : match.player2Id };
}

interface TierMetrics {
  level: string;
  n: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
}

function summarize(level: string, rows: Array<{ match: HistoricalMatchRow; result: ScoreResult }>): TierMetrics {
  if (rows.length === 0) return { level, n: 0, accuracy: null, brier: null, logLoss: null, ece: null };
  let correct = 0;
  const points = rows.map(({ match, result }) => {
    const outcome: 0 | 1 = match.winnerId === match.player1Id ? 1 : 0;
    if ((result.rawProbability >= 0.5 ? 1 : 0) === outcome) correct += 1;
    return { rawProbability: result.rawProbability, outcome };
  });
  return {
    level,
    n: rows.length,
    accuracy: Math.round((correct / rows.length) * 1000) / 10,
    brier: brierScore(points),
    logLoss: logLoss(points),
    ece: computeECE(points),
  };
}

async function main() {
  const startedAt = Date.now();
  console.log("[eloRebuild] Backing up match_feature_snapshots before rebuild...");

  const backupDir = path.resolve(process.cwd(), "backups");
  const snapshotBackup = await backupMatchFeatureSnapshots({
    backupDir,
    fetchBatch: (lastId) => db
      .select()
      .from(matchFeatureSnapshotsTable)
      .where(gt(matchFeatureSnapshotsTable.id, lastId))
      .orderBy(asc(matchFeatureSnapshotsTable.id))
      .limit(SNAPSHOT_BACKUP_BATCH_SIZE),
  });
  console.log(
    `[eloRebuild] Backed up ${snapshotBackup.totalRows} feature-snapshot rows in ${snapshotBackup.batchesCompleted} batch(es) ` +
    `to ${snapshotBackup.backupPath} (${snapshotBackup.finalSizeBytes} bytes), last row ID ${snapshotBackup.lastExportedRowId ?? "none"}`,
  );
  const backupPath = snapshotBackup.backupPath;

  console.log("[eloRebuild] Loading full historical corpus...");
  const allMatches = await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));
  const eligible = allMatches.filter((m) => !m.cancelled && m.winnerId !== null && m.surface && m.matchFormat);
  console.log(`[eloRebuild] ${allMatches.length} total rows, ${eligible.length} eligible for scoring.`);

  const matchHistory = buildMatchHistoryIndex(allMatches);
  const identityIndex = await buildPlayerIdentityIndex();
  console.log(
    `[eloRebuild] Identity index: ${identityIndex.canonicalIdByName.size} distinct normalized names, ${identityIndex.canonicalIdById.size} id->canonical mappings (${identityIndex.canonicalIdById.size - identityIndex.canonicalIdByName.size} extra aliases beyond the 1-per-name baseline).`,
  );

  const eloHistoryBefore = await buildEloHistoryIndex(identityIndex);
  const eloHistoryAfter = eloHistoryBefore;

  // --- Full-corpus rebuild (Task #77 step 4): re-score EVERY eligible match with the improved
  // resolution, tracking the fallback rate across the entire corpus, not just a sample. ---
  console.log(`[eloRebuild] Rebuilding Elo across the full corpus (${eligible.length} matches) with improved opponent resolution...`);
  eloFallbackTracker.reset();
  let rebuiltScored = 0;
  for (const match of eligible) {
    if (!match.surface) continue;
    const surface = match.surface as Surface;
    const player1Matches = reconstructPlayerMatchHistory(matchHistory, match.player1Id, match.cutoffAt);
    const player2Matches = reconstructPlayerMatchHistory(matchHistory, match.player2Id, match.cutoffAt);
    if (player1Matches.length === 0 || player2Matches.length === 0) continue;
    const player1OpponentStrength = resolveOpponentStrengthFromIndex(player1Matches, eloHistoryAfter, identityIndex);
    const player2OpponentStrength = resolveOpponentStrengthFromIndex(player2Matches, eloHistoryAfter, identityIndex);
    // Only the surface-Elo replay is needed to rebuild Elo and track fallback usage across the
    // full corpus (this is the module the fallback tracker instruments) -- the remaining engine
    // modules (fatigue/availability/serve-return/etc.) don't affect Elo or fallback tracking, so
    // running them here would only add cost without changing this step's result. The stratified
    // backtest below still runs the FULL engine for its accuracy/Brier/calibration numbers.
    computeSurfaceEloModule(player1Matches, player2Matches, surface, player1OpponentStrength.lookup, player2OpponentStrength.lookup, match.player1Id, match.player2Id);
    rebuiltScored += 1;
  }
  const fullCorpusFallbackStats = eloFallbackTracker.getStats();
  console.log(
    `[eloRebuild] Full-corpus rebuild complete: ${rebuiltScored}/${eligible.length} matches scored. Fallback rate: ${(fullCorpusFallbackStats.fallbackRate * 100).toFixed(2)}% (${fullCorpusFallbackStats.fallbackCount}/${fullCorpusFallbackStats.totalAttempts} opponent lookups).`,
  );

  // --- Stratified, capped 4,000-match backtest (Task #77 step 5) ---
  const byLevel = new Map<string, HistoricalMatchRow[]>();
  for (const m of eligible) {
    const level = m.tournamentLevel ?? "Unknown";
    const list = byLevel.get(level) ?? [];
    list.push(m);
    byLevel.set(level, list);
  }
  const knownLevelTotal = [...byLevel.entries()].filter(([lvl]) => lvl !== "Unknown").reduce((sum, [, list]) => sum + list.length, 0);

  const targetCounts = new Map<string, number>();
  let allocated = 0;
  const levels = [...byLevel.keys()].filter((lvl) => lvl !== "Unknown").sort();
  for (const level of levels) {
    const share = byLevel.get(level)!.length / knownLevelTotal;
    const target = Math.min(byLevel.get(level)!.length, Math.round(share * CAP));
    targetCounts.set(level, target);
    allocated += target;
  }
  console.log(`[eloRebuild] Stratified sample target (proportional to real corpus share, capped at ${CAP}): ${JSON.stringify(Object.fromEntries(targetCounts))} (sum=${allocated})`);

  function evenSample<T>(arr: T[], n: number): T[] {
    if (n >= arr.length) return arr;
    if (n <= 0) return [];
    const step = arr.length / n;
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  const sample: HistoricalMatchRow[] = [];
  for (const level of levels) {
    sample.push(...evenSample(byLevel.get(level)!, targetCounts.get(level) ?? 0));
  }
  console.log(`[eloRebuild] Sampled ${sample.length} matches for the stratified backtest.`);

  const beforeByLevel = new Map<string, Array<{ match: HistoricalMatchRow; result: ScoreResult }>>();
  const afterByLevel = new Map<string, Array<{ match: HistoricalMatchRow; result: ScoreResult }>>();
  for (const match of sample) {
    const level = match.tournamentLevel ?? "Unknown";
    const before = scoreMatch(match, matchHistory, eloHistoryBefore, identityIndex);
    const after = scoreMatch(match, matchHistory, eloHistoryAfter, identityIndex);
    if (before) (beforeByLevel.get(level) ?? beforeByLevel.set(level, []).get(level)!).push({ match, result: before });
    if (after) (afterByLevel.get(level) ?? afterByLevel.set(level, []).get(level)!).push({ match, result: after });
  }

  const beforeTiers = levels.map((level) => summarize(level, beforeByLevel.get(level) ?? []));
  const afterTiers = levels.map((level) => summarize(level, afterByLevel.get(level) ?? []));
  const beforeOverall = summarize("ALL", levels.flatMap((l) => beforeByLevel.get(l) ?? []));
  const afterOverall = summarize("ALL", levels.flatMap((l) => afterByLevel.get(l) ?? []));

  // --- Targeted re-verification of the six originally-flagged matchups (Task #77 step 4) ---
  const sixMatchups: Array<{ label: string; p1Id: string; p1Name: string; p2Id: string; p2Name: string; surface: Surface; level: TournamentLevel; tournament: string }> = [
    { label: "Krumich vs. Passaro (prediction id 316)", p1Id: "8442", p1Name: "F. Passaro", p2Id: "906", p2Name: "M. Krumich", surface: "Clay", level: "ATP250", tournament: "(live fixture)" },
    { label: "Pearson vs. Kirchheimer (prediction id 276)", p1Id: "13158", p1Name: "K. Pearson", p2Id: "3706", p2Name: "S. Kirchheimer", surface: "Hard", level: "ATP250", tournament: "(live fixture)" },
  ];
  const cutoffAt = new Date(); // "now" -- mirrors scoring these as live/current-standing fixtures against the real historical corpus.
  const sixResults: Array<Record<string, unknown>> = [];
  const verificationStartedAt = Date.now();
  const verificationCache = createVerificationHistoryCache();
  console.log(`[eloRebuild] Six-matchup verification cache initialized in ${Date.now() - verificationStartedAt}ms`);
  for (const m of sixMatchups) {
    const syntheticRow = {
      id: -1,
      player1Id: m.p1Id,
      player1Name: m.p1Name,
      player2Id: m.p2Id,
      player2Name: m.p2Name,
      surface: m.surface,
      matchFormat: "BestOf3",
      tournamentLevel: m.level,
      tournamentName: m.tournament,
      cutoffAt,
      cancelled: false,
      winnerId: null,
    } as unknown as HistoricalMatchRow;
    const beforeStartedAt = Date.now();
    const before = scoreMatchWithVerificationCache(syntheticRow, matchHistory, eloHistoryBefore, identityIndex, verificationCache);
    console.log(`[eloRebuild] Six-matchup before score: ${m.label} completed in ${Date.now() - beforeStartedAt}ms`);
    const afterStartedAt = Date.now();
    const after = scoreMatchWithVerificationCache(syntheticRow, matchHistory, eloHistoryAfter, identityIndex, verificationCache);
    console.log(`[eloRebuild] Six-matchup after score: ${m.label} completed in ${Date.now() - afterStartedAt}ms`);
    sixResults.push({
      label: m.label,
      before: before ? { player1WinProb: Math.round(before.rawProbability * 1000) / 10, predictedWinnerId: before.predictedWinnerId } : "insufficient data (no prior recorded matches for one player)",
      after: after ? { player1WinProb: Math.round(after.rawProbability * 1000) / 10, predictedWinnerId: after.predictedWinnerId } : "insufficient data (no prior recorded matches for one player)",
      player1: m.p1Name,
      player2: m.p2Name,
    });
  }
  console.log(`[eloRebuild] Six-matchup verification completed in ${Date.now() - verificationStartedAt}ms`);

  const unfindable = [
    "Feldbausch/Kecmanović",
    "Podoroska/Marčinko",
    "De Lange/Geerts",
    "Dalmasso's match",
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    backupPath,
    identityIndex: {
      distinctNormalizedNames: identityIndex.canonicalIdByName.size,
      totalIdMappings: identityIndex.canonicalIdById.size,
    },
    fullCorpusRebuild: {
      matchesScored: rebuiltScored,
      totalEligible: eligible.length,
      fallbackRate: fullCorpusFallbackStats.fallbackRate,
      fallbackCount: fullCorpusFallbackStats.fallbackCount,
      totalOpponentLookups: fullCorpusFallbackStats.totalAttempts,
    },
    stratifiedBacktest: {
      cap: CAP,
      sampledCount: sample.length,
      perTierTargetCounts: Object.fromEntries(targetCounts),
      before: { overall: beforeOverall, byTier: beforeTiers },
      after: { overall: afterOverall, byTier: afterTiers },
    },
    sixFlaggedMatchups: { reVerified: sixResults, unfindableInAnyTable: unfindable },
  };

  const reportPath = path.join(backupDir, "task77-rebuild-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[eloRebuild] Wrote full report to ${reportPath}`);
  console.log(`[eloRebuild] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
