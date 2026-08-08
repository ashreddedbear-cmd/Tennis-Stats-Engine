// July 8-11 backtest merge task (2026-07-14), scoped per user instruction: add real, no-look-ahead
// Ledger (`predictions` table) rows for 2026-07-08..2026-07-09 ONLY. July 10-11 already exist
// (from the earlier `regenerateLedgerPredictions.ts` run) and must remain untouched/unduplicated
// -- so unlike that script, this one NEVER deletes/replaces an existing row; it skips (does not
// insert) any fixture whose matchIdentityKey already has a row, and logs it.
//
// Same no-look-ahead methodology as regenerateLedgerPredictions.ts (see that file's header for
// full rationale): live-provider match history/H2H bounded to strictly-before-cutoff
// (scheduledStart - 30min), activeCalibration/weather/segment/simulatorAdoption omitted (today's
// versions are fit from data covering this period), player profiles from current live standings
// (no point-in-time ranking snapshot exists from this provider), rows inserted already graded.
//
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/backtestLedgerJuly8_9.ts
import { eq } from "drizzle-orm";
import { db, predictionsTable, pool } from "@workspace/db";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { resolvePlayerProfile } from "../services/tennisData/playerIdentity";
import { runPredictionEngine } from "../services/predictionEngine";
import { buildPlayerProfileWarnings } from "../services/predictionEngine/playerProfileWarnings";
import { resolveOpponentStrength } from "../services/predictionEngine/opponentStrength";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "../services/predictionEngine/predictionIdentity";
import type { MatchRecord, HeadToHeadRecord } from "../services/tennisData/types";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATE_START = "2026-07-08";
const DATE_STOP = "2026-07-09";
const CUTOFF_MINUTES = 30;

function toScheduledStart(date: string, time: string | null): Date {
  return new Date(`${date}T${time ?? "00:00"}:00.000Z`);
}

function boundMatches(matches: MatchRecord[], cutoffAt: Date): MatchRecord[] {
  return matches.filter((m) => {
    const t = new Date(m.date).getTime();
    return !Number.isNaN(t) && t < cutoffAt.getTime();
  });
}

function boundHeadToHead(h2h: HeadToHeadRecord, cutoffAt: Date): HeadToHeadRecord {
  return {
    ...h2h,
    meetings: h2h.meetings.filter((m) => {
      const t = new Date(m.date).getTime();
      return !Number.isNaN(t) && t < cutoffAt.getTime();
    }),
  };
}

interface DateLevelCount {
  [date: string]: { [level: string]: number };
}

async function main(): Promise<void> {
  // Full-ledger backup before any write, per instruction.
  const allRowsBefore = await db.select().from(predictionsTable);
  const backupDir = path.join(__dirname, "..", "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `ledger-full-backup-pre-july8-9-backtest-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(allRowsBefore, null, 2));
  console.log(`Full ledger backup (${allRowsBefore.length} rows) written to: ${backupPath}`);

  const existingIdentityKeys = new Set(allRowsBefore.map((r) => r.matchIdentityKey));

  const provider = getTennisDataProvider();
  console.log(`\nFetching real completed matches ${DATE_START}..${DATE_STOP} from ${provider.name}...`);
  const fixtures = await provider.getCompletedMatchesByDateRange(DATE_START, DATE_STOP);
  console.log(`Provider returned ${fixtures.length} terminated fixtures in this window.`);

  const eligible = fixtures.filter((f) => !f.cancelled && f.winnerId !== null && f.surface !== null && f.matchFormat !== null);
  console.log(`${eligible.length} are eligible (not cancelled, real winner, resolved surface+format).`);

  const skippedReasons = { cancelledOrNoWinner: 0, noSurfaceOrFormat: 0 };
  for (const f of fixtures) {
    if (f.cancelled || f.winnerId === null) skippedReasons.cancelledOrNoWinner += 1;
    else if (f.surface === null || f.matchFormat === null) skippedReasons.noSurfaceOrFormat += 1;
  }

  const inserted: DateLevelCount = {};
  const skippedNoHistory: string[] = [];
  const skippedAlreadyExists: string[] = [];
  const errors: string[] = [];
  let insertedTotal = 0;
  const tourCounts: Record<string, number> = {};

  const sorted = [...eligible].sort((a, b) => {
    const at = toScheduledStart(a.date, a.time).getTime();
    const bt = toScheduledStart(b.date, b.time).getTime();
    return at - bt;
  });

  for (const fixture of sorted) {
    const scheduledStartAt = toScheduledStart(fixture.date, fixture.time);
    const cutoffAt = new Date(scheduledStartAt.getTime() - CUTOFF_MINUTES * 60_000);

    try {
      const [player1, player2] = await Promise.all([
        resolvePlayerProfile(provider, fixture.player1Id),
        resolvePlayerProfile(provider, fixture.player2Id),
      ]);
      if (!player1 || !player2) {
        skippedNoHistory.push(`${fixture.id} (${fixture.player1Name} vs ${fixture.player2Name}): player profile not found`);
        continue;
      }

      // Never touch/replace an existing row -- July 10-11 (and anything else already present)
      // must stay exactly as-is. Compute the identity key up front using a cheap pre-check; the
      // full key (needs player.id, tournament, surface, format) is computed below once resolved,
      // but tournament/surface/format are already known from the fixture, so we can pre-check here.
      const precheckKey = computeMatchIdentityKey(player1.id, player2.id, fixture.tournamentName, fixture.surface!, fixture.matchFormat!);
      if (existingIdentityKeys.has(precheckKey)) {
        skippedAlreadyExists.push(`${fixture.id} (${fixture.player1Name} vs ${fixture.player2Name}) on ${fixture.date}: matchIdentityKey already present in ledger -- skipped, not touched`);
        continue;
      }

      const [rawPlayer1Matches, rawPlayer2Matches, rawHeadToHead] = await Promise.all([
        provider.getPlayerMatches(fixture.player1Id),
        provider.getPlayerMatches(fixture.player2Id),
        provider.getHeadToHead(fixture.player1Id, fixture.player2Id),
      ]);

      const player1Matches = boundMatches(rawPlayer1Matches, cutoffAt);
      const player2Matches = boundMatches(rawPlayer2Matches, cutoffAt);
      const headToHead = boundHeadToHead(rawHeadToHead, cutoffAt);

      if (player1Matches.length === 0 || player2Matches.length === 0) {
        skippedNoHistory.push(
          `${fixture.id} (${fixture.player1Name} vs ${fixture.player2Name}) on ${fixture.date}: no real pre-cutoff match history for one or both players -- no honest prediction possible`,
        );
        continue;
      }

      // No-look-ahead sanity assertion: every bounded history/H2H entry must be strictly before
      // cutoffAt. This is the feature-leakage bug-scan check, enforced inline (not just trusted).
      for (const m of [...player1Matches, ...player2Matches]) {
        if (new Date(m.date).getTime() >= cutoffAt.getTime()) {
          throw new Error(`LOOK-AHEAD LEAK DETECTED: match ${m.date} is not strictly before cutoff ${cutoffAt.toISOString()} for fixture ${fixture.id}`);
        }
      }
      for (const m of headToHead.meetings) {
        if (new Date(m.date).getTime() >= cutoffAt.getTime()) {
          throw new Error(`LOOK-AHEAD LEAK DETECTED (H2H): match ${m.date} is not strictly before cutoff ${cutoffAt.toISOString()} for fixture ${fixture.id}`);
        }
      }

      const [player1OpponentStrength, player2OpponentStrength] = await Promise.all([
        resolveOpponentStrength(player1Matches),
        resolveOpponentStrength(player2Matches),
      ]);

      const output = await runPredictionEngine({
        player1,
        player2,
        player1Matches,
        player2Matches,
        headToHead,
        surface: fixture.surface!,
        matchFormat: fixture.matchFormat!,
        player1OpponentElo: player1OpponentStrength.lookup,
        player2OpponentElo: player2OpponentStrength.lookup,
        activeCalibration: null,
        weather: null,
        tournamentName: fixture.tournamentName,
        tournamentLevel: fixture.tournamentLevel,
        segment: null,
        simulatorAdoption: null,
      });
      output.engine.warnings.push(...buildPlayerProfileWarnings(player1, player2));

      const matchIdentityKey = computeMatchIdentityKey(player1.id, player2.id, fixture.tournamentName, fixture.surface!, fixture.matchFormat!);
      const inputSnapshotHash = computeInputSnapshotHash({
        player1Id: player1.id,
        player2Id: player2.id,
        player1Matches,
        player2Matches,
        headToHead,
        player1OpponentElo: player1OpponentStrength.lookup,
        player2OpponentElo: player2OpponentStrength.lookup,
      });

      const actualWinnerId = fixture.winnerId!;
      const actualWinnerName = actualWinnerId === player1.id ? player1.name : player2.name;

      await db.insert(predictionsTable).values({
        player1Id: player1.id,
        player1Name: player1.name,
        player2Id: player2.id,
        player2Name: player2.name,
        surface: fixture.surface!,
        matchFormat: fixture.matchFormat!,
        tournamentLevel: fixture.tournamentLevel,
        tournamentName: fixture.tournamentName,
        predictedWinnerId: output.predictedWinnerId,
        predictedWinnerName: output.predictedWinnerName,
        calibratedProbability: output.calibratedProbability,
        predictedWinnerProbability: output.predictedWinnerProbability,
        dataQuality: output.dataQuality,
        dataQualityLabel: output.dataQualityLabel,
        upsetRisk: output.upsetRisk,
        recommendation: output.recommendation,
        predictedSetScore: output.predictedSetScore,
        engine: output.engine,
        matchIdentityKey,
        inputSnapshotHash,
        actualWinnerId,
        actualWinnerName,
        resolvedAt: new Date(),
      });

      existingIdentityKeys.add(matchIdentityKey);
      const level = fixture.tournamentLevel ?? "Unknown";
      inserted[fixture.date] = inserted[fixture.date] ?? {};
      inserted[fixture.date][level] = (inserted[fixture.date][level] ?? 0) + 1;
      tourCounts[fixture.tour ?? "Unknown"] = (tourCounts[fixture.tour ?? "Unknown"] ?? 0) + 1;
      insertedTotal += 1;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        errors.push(`Fixture ${fixture.id}: provider unavailable (${err.message})`);
        continue;
      }
      errors.push(`Fixture ${fixture.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== July 8-9 backtest merge summary ===");
  console.log(`Fixtures returned by provider: ${fixtures.length}`);
  console.log(`Skipped (cancelled/no winner): ${skippedReasons.cancelledOrNoWinner}`);
  console.log(`Skipped (no resolved surface/format): ${skippedReasons.noSurfaceOrFormat}`);
  console.log(`Skipped (already exists in ledger): ${skippedAlreadyExists.length}`);
  console.log(`Skipped (no real pre-cutoff history for one/both players): ${skippedNoHistory.length}`);
  console.log(`Inserted: ${insertedTotal}`);
  console.log(`Errors: ${errors.length}`);
  console.log("\nPer date / tournament level:");
  for (const date of Object.keys(inserted).sort()) {
    for (const level of Object.keys(inserted[date]).sort()) {
      console.log(`  ${date} / ${level}: ${inserted[date][level]}`);
    }
  }
  console.log("\nPer tour:");
  for (const tour of Object.keys(tourCounts).sort()) {
    console.log(`  ${tour}: ${tourCounts[tour]}`);
  }
  if (skippedAlreadyExists.length > 0) {
    console.log("\nSkipped (already exists) detail:");
    skippedAlreadyExists.forEach((s) => console.log(`  - ${s}`));
  }
  if (skippedNoHistory.length > 0) {
    console.log("\nSkipped (no history) detail:");
    skippedNoHistory.forEach((s) => console.log(`  - ${s}`));
  }
  if (errors.length > 0) {
    console.log("\nErrors detail:");
    errors.forEach((e) => console.log(`  - ${e}`));
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    return pool.end().finally(() => process.exit(1));
  });
