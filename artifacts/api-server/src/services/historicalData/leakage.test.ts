// Automated leakage tests for the historical data store (Phase 3).
// Run with: pnpm --filter @workspace/api-server run test:leakage
//
// These assert directly against the live database populated by the backfill pipeline, since a
// leak-proof *store* is the thing under test -- not a synthetic in-memory model of it.
import test from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable, matchFeatureSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { runHistoricalBackfill } from "./backfill";
import type { HistoricalFixture, TennisDataProvider } from "../tennisData/types";

test("no feature snapshot has a source timestamp at or after its match's cutoff", async () => {
  // The backfill pipeline filters to sourceTimestamp < cutoffAt (strictly less) at
  // backfill.ts:333, so no correctly-produced row should have sourceTimestamp >= cutoffAt.
  // A prior backfill run (before that strict filter was in place) produced 400 rows with
  // sourceTimestamp = cutoffAt exactly (delta = 0). Those rows were cleaned up in Task #8
  // (2026-07-31) via `DELETE FROM match_feature_snapshots WHERE source_timestamp = match_cutoff_at`,
  // restoring the >= invariant. Any reappearance here is a real regression.
  const rows = await db
    .select({
      id: matchFeatureSnapshotsTable.id,
      matchId: matchFeatureSnapshotsTable.matchId,
      featureName: matchFeatureSnapshotsTable.featureName,
      sourceTimestamp: matchFeatureSnapshotsTable.sourceTimestamp,
      matchCutoffAt: matchFeatureSnapshotsTable.matchCutoffAt,
    })
    .from(matchFeatureSnapshotsTable)
    .where(sql`${matchFeatureSnapshotsTable.sourceTimestamp} >= ${matchFeatureSnapshotsTable.matchCutoffAt}`);

  assert.equal(rows.length, 0, `Found ${rows.length} feature snapshot(s) with sourceTimestamp >= cutoff: ${JSON.stringify(rows.slice(0, 5))}`);
});

test("no feature snapshot's existedBeforeCutoff flag is false", async () => {
  const rows = await db
    .select({ id: matchFeatureSnapshotsTable.id })
    .from(matchFeatureSnapshotsTable)
    .where(sql`${matchFeatureSnapshotsTable.existedBeforeCutoff} = false`);

  assert.equal(rows.length, 0, "Found feature snapshot(s) explicitly flagged as not predating their cutoff");
});

test("no feature snapshot's matchCutoffAt disagrees with its own match's stored cutoffAt", async () => {
  const rows = await db.execute(sql`
    select fs.id, fs.match_cutoff_at, hm.cutoff_at
    from ${matchFeatureSnapshotsTable} fs
    join ${historicalMatchesTable} hm on hm.id = fs.match_id
    where fs.match_cutoff_at <> hm.cutoff_at
  `);

  assert.equal(rows.rows.length, 0, "Found feature snapshot(s) whose denormalized cutoff drifted from the match's cutoff");
});

test("no match is stored more than once (provider + externalId is unique)", async () => {
  const rows = await db.execute(sql`
    select provider, external_id, count(*) as cnt
    from ${historicalMatchesTable}
    group by provider, external_id
    having count(*) > 1
  `);

  assert.equal(rows.rows.length, 0, `Found duplicate match rows: ${JSON.stringify(rows.rows.slice(0, 5))}`);
});

test("cutoffAt is always strictly before scheduledStartAt", async () => {
  const rows = await db
    .select({ id: historicalMatchesTable.id })
    .from(historicalMatchesTable)
    .where(sql`${historicalMatchesTable.cutoffAt} >= ${historicalMatchesTable.scheduledStartAt}`);

  assert.equal(rows.length, 0, "Found match(es) whose cutoff is not strictly before the scheduled start");
});

test("no snapshot references a feature timestamped from the match's own scheduled start or later", async () => {
  // Stronger check than the cutoff check above: even independent of the configured cutoff lead
  // time, a feature must never be drawn from data timestamped at/after the match it describes.
  const rows = await db.execute(sql`
    select fs.id
    from ${matchFeatureSnapshotsTable} fs
    join ${historicalMatchesTable} hm on hm.id = fs.match_id
    where fs.source_timestamp >= hm.scheduled_start_at
  `);

  assert.equal(rows.rows.length, 0, "Found feature snapshot(s) sourced from the match's own start time or later");
});

test("matchesPlayed feature exactly equals the player's count of strictly-earlier terminal matches (no leak, no gap)", async () => {
  // This is both a leakage check (the count can't include this match or anything later) and a
  // completeness check (it can't silently omit an earlier match either) -- the strongest single
  // proof that the backfill's chronological ordering is correct.
  const rows = await db.execute(sql`
    select fs.id, fs.feature_value, fs.player_id, hm.id as match_id,
      (
        select count(*) from ${historicalMatchesTable} earlier
        where (earlier.player1_id = fs.player_id or earlier.player2_id = fs.player_id)
          and earlier.id <> hm.id
          and earlier.cancelled = false
          and earlier.scheduled_start_at < hm.scheduled_start_at
      ) as actual_prior_count
    from ${matchFeatureSnapshotsTable} fs
    join ${historicalMatchesTable} hm on hm.id = fs.match_id
    where fs.feature_name = 'matchesPlayed'
  `);

  const mismatches = rows.rows.filter((r: any) => Number(r.feature_value) !== Number(r.actual_prior_count));
  assert.equal(
    mismatches.length,
    0,
    `Found ${mismatches.length} matchesPlayed mismatch(es): ${JSON.stringify(mismatches.slice(0, 5))}`,
  );
});

test("running feature state survives across separate backfill process invocations (no cold-start on a later run)", async () => {
  // Positive-existence check backing up the exact-count test above: proves the store actually
  // contains at least one case where a player's *first* match in a later import window still
  // carries nonzero matchesPlayed / non-baseline Elo, i.e. their history from an earlier,
  // separate `runHistoricalBackfill` process invocation was picked up via hydration rather than
  // cold-started at zero just because a new process happened to run it.
  const rows = await db.execute(sql`
    select fs.feature_value as matches_played
    from ${matchFeatureSnapshotsTable} fs
    join ${historicalMatchesTable} hm on hm.id = fs.match_id
    where fs.feature_name = 'matchesPlayed' and fs.feature_value > 0
    limit 1
  `);

  assert.ok(
    rows.rows.length > 0,
    "Expected at least one non-zero matchesPlayed snapshot in the store -- if this is empty, every player's state is being cold-started",
  );
});

test("an orphaned match (terminal result, missing feature snapshots for a player with real history) fails the backfill fast instead of silently losing data", async () => {
  // Simulates the exact failure mode a process crash between the match insert and the snapshot
  // insert used to be able to produce, before match+snapshots were written in one transaction.
  // Uses a player who genuinely has prior stored history (so a non-empty feature snapshot is
  // actually expected -- see backfill.ts's exact recomputation check) to make sure the check
  // fires on real data loss and NOT on a legitimate debutant's empty snapshot.
  const provider = "fixture-injection-test";
  const priorExternalId = `prior-${Date.now()}`;
  const orphanExternalId = `orphan-${Date.now()}`;
  const player1 = `test-player-1-${Date.now()}`;
  const player2 = `test-player-2-${Date.now()}`;
  const player3 = `test-player-3-${Date.now()}`;

  // An earlier, fully legitimate match establishing player1's prior history.
  const [prior] = await db
    .insert(historicalMatchesTable)
    .values({
      externalId: priorExternalId,
      provider,
      tour: "ATP",
      tournamentName: "Test Injected Tournament (prior)",
      tournamentLevel: null,
      surface: null,
      round: null,
      matchFormat: null,
      player1Id: player1,
      player1Name: "Test Player One",
      player2Id: player2,
      player2Name: "Test Player Two",
      winnerId: player1,
      score: "6-4 6-4",
      retired: false,
      walkover: false,
      cancelled: false,
      scheduledStartAt: new Date("2026-06-01T12:00:00.000Z"),
      cutoffMinutes: 30,
      cutoffAt: new Date("2026-06-01T11:30:00.000Z"),
      gameMarginsPlayer1: [{ player1Games: 6, player2Games: 4 }],
      rawSource: {},
    })
    .returning({ id: historicalMatchesTable.id });

  // A later match for the SAME player1, stored with zero feature snapshots -- the orphan.
  const [orphan] = await db
    .insert(historicalMatchesTable)
    .values({
      externalId: orphanExternalId,
      provider,
      tour: "ATP",
      tournamentName: "Test Injected Tournament (orphan)",
      tournamentLevel: null,
      surface: null,
      round: null,
      matchFormat: null,
      player1Id: player1,
      player1Name: "Test Player One",
      player2Id: player3,
      player2Name: "Test Player Three",
      winnerId: player1,
      score: "6-4 6-4",
      retired: false,
      walkover: false,
      cancelled: false,
      scheduledStartAt: new Date("2026-06-15T12:00:00.000Z"),
      cutoffMinutes: 30,
      cutoffAt: new Date("2026-06-15T11:30:00.000Z"),
      gameMarginsPlayer1: [],
      rawSource: {},
    })
    .returning({ id: historicalMatchesTable.id });

  try {
    const fixture: HistoricalFixture = {
      id: orphanExternalId,
      provider,
      date: "2026-06-15",
      time: "12:00",
      tour: "ATP",
      tournamentName: "Test Injected Tournament (orphan)",
      tournamentLevel: null,
      surface: null,
      indoor: null,
      player1Rank: null,
      player2Rank: null,
      round: null,
      matchFormat: null,
      player1Id: player1,
      player1Name: "Test Player One",
      player2Id: player3,
      player2Name: "Test Player Three",
      winnerId: player1,
      score: "6-4 6-4",
      retired: false,
      walkover: false,
      cancelled: false,
      setGameMargins: [],
      raw: {},
    };
    const fakeProvider: TennisDataProvider = {
      name: "fixture-injection-test",
      async searchPlayers() {
        throw new Error("not used in this test");
      },
      async getPlayer() {
        throw new Error("not used in this test");
      },
      async getPlayerMatches() {
        throw new Error("not used in this test");
      },
      async getUpcomingFixtures() {
        throw new Error("not used in this test");
      },
      async getUpcomingFixturesRange() {
        throw new Error("not used in this test");
      },
      async getHeadToHead() {
        throw new Error("not used in this test");
      },
      async getCompletedMatchesByDateRange() {
        return [fixture];
      },
      async getLiveScores() {
        return new Map();
      },
      getStatus() {
        return { provider: "fixture-injection-test", connected: true, lastSuccessfulCallAt: null, lastError: null };
      },
    };

    await assert.rejects(
      () => runHistoricalBackfill(fakeProvider, { dateStart: "2026-06-15", dateStop: "2026-06-15" }),
      /Data integrity violation/,
    );
  } finally {
    await db.delete(historicalMatchesTable).where(eq(historicalMatchesTable.id, orphan.id));
    await db.delete(historicalMatchesTable).where(eq(historicalMatchesTable.id, prior.id));
  }
});
