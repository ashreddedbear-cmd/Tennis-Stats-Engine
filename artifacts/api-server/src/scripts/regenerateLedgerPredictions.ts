// Regenerates real Ledger predictions for real completed matches in a given recent date range,
// under a STRICT no-look-ahead rule. Reusable any time real matches need adding to the Ledger
// and/or existing Ledger rows in that window need regrading against the current engine (e.g.
// after an engine upgrade) -- both are the same "surgical replace" operation below.
//
// Methodology (read before re-running):
//  - `historical_matches` (the "leak-proof historical store" used by walk-forward/backfill) only
//    covers 2025-01-01..2025-04-01 -- nowhere near recent real dates -- so it cannot be used here.
//  - Real matches for the target dates are discovered via the SAME provider call the historical
//    backfill pipeline uses, `getCompletedMatchesByDateRange`, for the requested window.
//  - Each player's match history / head-to-head is pulled live from the provider (which returns
//    everything up to today) and then explicitly filtered down to only matches dated strictly
//    BEFORE this match's own cutoff (scheduledStart - 30min, the same convention
//    `historical_matches.cutoffAt` uses) -- so nothing that happened on or after the cutoff can
//    leak into that match's own prediction. This is the same principle
//    `reconstructPlayerMatchHistory` applies to the historical store, applied directly to live
//    provider data instead, since no frozen historical snapshot exists for this period.
//  - Player profiles (rank, country, etc) are resolved via the provider's CURRENT live standings,
//    same as every other live/paper-trade prediction already does -- there is no point-in-time
//    ranking snapshot available from this provider. For a match only days/weeks old this is a
//    minor, disclosed limitation, not a fabrication.
//  - Weather, the active (today-fit) calibration model, tour/surface specialist segments, and
//    Monte Carlo simulator adoption are all deliberately omitted (null), exactly as
//    `historicalScoring.ts` already documents for backtesting: calibration/specialists are FIT
//    FROM data that includes this exact period, so using today's active versions on a match still
//    inside that fit window would itself be a look-ahead leak. `calibratedProbability` for these
//    rows is therefore the raw ensemble probability, uncalibrated -- consistent with how
//    walk-forward's own historical_test rows are produced.
//  - Every match discovered already has a real, known result (it's in the past) -- each row is
//    inserted already graded (actualWinnerId/actualWinnerName/resolvedAt set) rather than left
//    pending, since there is no honest "wait for a future result" step for a match that already
//    happened.
//
// Usage: pnpm --filter @workspace/api-server run regenerate-ledger -- --start 2026-07-06 --stop 2026-07-12
import { eq } from "drizzle-orm";
import { db, predictionsTable, pool } from "@workspace/db";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { resolvePlayerProfile } from "../services/tennisData/playerIdentity";
import { runPredictionEngine } from "../services/predictionEngine";
import { buildPlayerProfileWarnings } from "../services/predictionEngine/playerProfileWarnings";
import { resolveOpponentStrength } from "../services/predictionEngine/opponentStrength";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "../services/predictionEngine/predictionIdentity";
import type { MatchRecord, HeadToHeadRecord } from "../services/tennisData/types";

function parseArgs(argv: string[]): { dateStart: string; dateStop: string } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const dateStart = get("--start");
  const dateStop = get("--stop");
  if (!dateStart || !dateStop) {
    throw new Error("Usage: --start YYYY-MM-DD --stop YYYY-MM-DD");
  }
  return { dateStart, dateStop };
}

const { dateStart: DATE_START, dateStop: DATE_STOP } = parseArgs(process.argv.slice(2));
const CUTOFF_MINUTES = 30;

function toScheduledStart(date: string, time: string | null): Date {
  return new Date(`${date}T${time ?? "00:00"}:00.000Z`);
}

/** Filters a player's live-provider match list down to matches strictly before `cutoffAt`. */
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
  const provider = getTennisDataProvider();
  console.log(`Fetching real completed matches ${DATE_START}..${DATE_STOP} from ${provider.name}...`);
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
  const errors: string[] = [];
  let insertedTotal = 0;
  let replacedTotal = 0;

  // Chronological order, so if the same player appears twice in the window, the later match's
  // own bounded history naturally includes the earlier one (it's already in provider data by
  // date, this doesn't change anything, but keeps processing order sane/debuggable).
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
        // Deliberately omitted to avoid a look-ahead leak -- see file header.
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

      // Surgical replace: the table has no stored match-date column, so we can't identify "the
      // July 10-11 rows" by created_at (that's insertion time, not match time). matchIdentityKey
      // is a deterministic function of (player1Id, player2Id, tournamentName, surface, matchFormat)
      // -- i.e. of the fixture itself, not of any particular prediction run -- so any existing row
      // for this exact match (old, buggy or otherwise) shares this key regardless of when it was
      // inserted. Delete only those rows before inserting the fresh one, leaving every unrelated
      // row (including the 205 legitimate post-fix live predictions for other matches) untouched.
      const replaced = await db.delete(predictionsTable).where(eq(predictionsTable.matchIdentityKey, matchIdentityKey)).returning({ id: predictionsTable.id });
      if (replaced.length > 0) {
        replacedTotal += replaced.length;
      }

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

      const level = fixture.tournamentLevel ?? "Unknown";
      inserted[fixture.date] = inserted[fixture.date] ?? {};
      inserted[fixture.date][level] = (inserted[fixture.date][level] ?? 0) + 1;
      insertedTotal += 1;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        errors.push(`Fixture ${fixture.id}: provider unavailable (${err.message})`);
        continue;
      }
      errors.push(`Fixture ${fixture.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== Regeneration summary ===");
  console.log(`Fixtures returned by provider: ${fixtures.length}`);
  console.log(`Skipped (cancelled/no winner): ${skippedReasons.cancelledOrNoWinner}`);
  console.log(`Skipped (no resolved surface/format): ${skippedReasons.noSurfaceOrFormat}`);
  console.log(`Skipped (no real pre-cutoff history for one/both players): ${skippedNoHistory.length}`);
  console.log(`Inserted: ${insertedTotal}`);
  console.log(`Replaced (old row for the same exact match deleted first): ${replacedTotal}`);
  console.log(`Errors: ${errors.length}`);
  console.log("\nPer date / tournament level:");
  for (const date of Object.keys(inserted).sort()) {
    for (const level of Object.keys(inserted[date]).sort()) {
      console.log(`  ${date} / ${level}: ${inserted[date][level]}`);
    }
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
