// Integration test for runBridgeRescore.
//
// Seeds a synthetic set of historical_matches whose player IDs have already been
// "corrected" by the ext-csv bridge (i.e. they are real player IDs, not ext-xxx
// placeholders). Clears any stale evaluation_predictions for those match IDs,
// runs the bridge rescore, and asserts the properties it promises:
//
//   1. One evaluation_predictions row is created per non-cancelled target match.
//   2. Every row has run_kind='historical_test', segment='test', foldId=null.
//   3. Player IDs in the created rows match the corrected IDs in historical_matches
//      (not the old ext-xxx placeholders — those have already been updated).
//   4. Cancelled target matches are skipped (never inserted).
//   5. runBridgeRescore([]) is a safe no-op (no DB calls).
//   6. Passing non-existent matchIds surfaces them in result.notFound without error.
//
// This test exercises the REAL walk-forward / scoring path (scoreHistoricalMatch,
// buildMatchHistoryIndex, buildEloHistoryIndex) against the real DB, proving that
// the full historical context is used — not just the target matches in isolation.

import test from "node:test";
import assert from "node:assert/strict";
import {
  db,
  historicalMatchesTable,
  evaluationPredictionsTable,
  matchFeatureSnapshotsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runBridgeRescore } from "./bridgeRescore";

const PROVIDER = "bridge-rescore-test";

/** Unique per-process invocation — prevents externalId collisions across test runs. */
function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeMatch(
  i: number,
  opts: {
    player1: string;
    player2: string;
    winner: string;
    cancelled?: boolean;
    retired?: boolean;
    walkover?: boolean;
  },
  runId: string,
) {
  const scheduledStartAt = new Date(Date.UTC(2020, 0, 2 + i, 12, 0, 0));
  const cutoffAt = new Date(scheduledStartAt.getTime() - 30 * 60_000);
  return {
    externalId: `br-${i}-${runId}`,
    provider: PROVIDER,
    tour: "ATP",
    tournamentName: "Bridge Rescore Test Series",
    tournamentLevel: null,
    surface: "Hard" as const,
    round: null,
    matchFormat: "BestOf3" as const,
    player1Id: opts.player1,
    player1Name: opts.player1,
    player2Id: opts.player2,
    player2Name: opts.player2,
    winnerId: opts.cancelled ? null : opts.winner,
    score: opts.cancelled ? null : "6-4 6-4",
    retired: !!opts.retired,
    walkover: !!opts.walkover,
    cancelled: !!opts.cancelled,
    scheduledStartAt,
    cutoffMinutes: 30,
    cutoffAt,
    gameMarginsPlayer1: opts.cancelled ? [] : [{ player1Games: 6, player2Games: 4 }],
    rawSource: {},
  };
}

/**
 * Seed feature snapshots for a match so scoreHistoricalMatch has real signal to
 * work with. Mirrors the pattern from walkForward.test.ts.
 */
function makeSnapshotRows(
  matchId: number,
  cutoffAt: Date,
  player1Id: string,
  player2Id: string,
  matchIndex: number,
) {
  const featuresFor = (playerId: string, isFavorite: boolean) => [
    { matchId, playerId, featureName: "matchesPlayed", featureValue: matchIndex + 1, sourceTimestamp: cutoffAt, matchCutoffAt: cutoffAt, existedBeforeCutoff: true },
    { matchId, playerId, featureName: "eloOverall", featureValue: isFavorite ? 1650 : 1400, sourceTimestamp: cutoffAt, matchCutoffAt: cutoffAt, existedBeforeCutoff: true },
    { matchId, playerId, featureName: "eloSurface", featureValue: isFavorite ? 1650 : 1400, sourceTimestamp: cutoffAt, matchCutoffAt: cutoffAt, existedBeforeCutoff: true },
    { matchId, playerId, featureName: "winPctLast10", featureValue: isFavorite ? 0.75 : 0.25, sourceTimestamp: cutoffAt, matchCutoffAt: cutoffAt, existedBeforeCutoff: true },
    { matchId, playerId, featureName: "gameShareLast10", featureValue: isFavorite ? 0.65 : 0.35, sourceTimestamp: cutoffAt, matchCutoffAt: cutoffAt, existedBeforeCutoff: true },
  ];
  return [...featuresFor(player1Id, true), ...featuresFor(player2Id, false)];
}

test("runBridgeRescore: creates evaluation_predictions for each non-cancelled target match using corrected player IDs", async (t) => {
  // ── Self-healing cleanup (handle crashes from prior runs) ─────────────────
  const staleMatches = await db
    .select({ id: historicalMatchesTable.id })
    .from(historicalMatchesTable)
    .where(eq(historicalMatchesTable.provider, PROVIDER));
  if (staleMatches.length > 0) {
    const staleIds = staleMatches.map((r) => r.id);
    await db.delete(evaluationPredictionsTable).where(inArray(evaluationPredictionsTable.historicalMatchId, staleIds));
    await db.delete(matchFeatureSnapshotsTable).where(inArray(matchFeatureSnapshotsTable.matchId, staleIds));
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, staleIds));
  }

  const RUN_ID = makeRunId();

  // Simulated "corrected" player IDs: what the ext-csv bridge resolves ext-xxx to.
  // Using RUN_ID-scoped names so concurrent test runs can't collide.
  const p1 = `br-p1-${RUN_ID}`;
  const p2 = `br-p2-${RUN_ID}`;
  const p3 = `br-p3-${RUN_ID}`;

  // ── Background matches (2019) — establishes prior match history ───────────
  // scoreHistoricalMatch returns null when a player has NO prior history at the
  // match cutoff date. We seed background context matches (dated 2019) before
  // the 2020 target matches so every player has prior history by the time any
  // target match is scored. These are included in contextMatchIds but NOT in
  // the target matchIds passed to runBridgeRescore.
  const bgMatchDefs = [
    { player1: p1, player2: p2, winner: p1, baseYear: 2019, day: 2 },
    { player1: p2, player2: p3, winner: p3, baseYear: 2019, day: 10 },
    { player1: p1, player2: p3, winner: p1, baseYear: 2019, day: 20 },
    { player1: p2, player2: p1, winner: p2, baseYear: 2019, day: 30 },
    { player1: p3, player2: p1, winner: p3, baseYear: 2019, day: 40 },
    { player1: p3, player2: p2, winner: p2, baseYear: 2019, day: 50 },
  ];

  const bgRows = bgMatchDefs.map(({ player1, player2, winner, baseYear, day }) => {
    const scheduledStartAt = new Date(Date.UTC(baseYear, 0, day, 12, 0, 0));
    const cutoffAt = new Date(scheduledStartAt.getTime() - 30 * 60_000);
    return {
      externalId: `br-bg-${day}-${RUN_ID}`,
      provider: PROVIDER,
      tour: "ATP",
      tournamentName: "Bridge Rescore Background Series",
      tournamentLevel: null,
      surface: "Hard" as const,
      round: null,
      matchFormat: "BestOf3" as const,
      player1Id: player1,
      player1Name: player1,
      player2Id: player2,
      player2Name: player2,
      winnerId: winner,
      score: "6-4 6-4",
      retired: false,
      walkover: false,
      cancelled: false,
      scheduledStartAt,
      cutoffMinutes: 30,
      cutoffAt,
      gameMarginsPlayer1: [{ player1Games: 6, player2Games: 4 }],
      rawSource: {},
    };
  });

  const insertedBg = await db
    .insert(historicalMatchesTable)
    .values(bgRows)
    .returning({ id: historicalMatchesTable.id, cutoffAt: historicalMatchesTable.cutoffAt });

  // Feature snapshots for background matches (gives the engine real Elo signal)
  const bgSnapshotRows = insertedBg.flatMap((row, i) => {
    const m = bgRows[i];
    return makeSnapshotRows(row.id, row.cutoffAt, m.player1Id, m.player2Id, i);
  });
  await db.insert(matchFeatureSnapshotsTable).values(bgSnapshotRows);

  // ── Target matches (2020) — the "corrected" rows the bridge just fixed ────
  const targetMatchDefs = [
    { player1: p1, player2: p2, winner: p1 },
    { player1: p2, player2: p3, winner: p3 },
    { player1: p1, player2: p3, winner: p1 },
    { player1: p2, player2: p3, winner: p2, cancelled: true }, // must be skipped
  ];
  const targetRows = targetMatchDefs.map((opts, i) => makeMatch(i, opts, RUN_ID));

  const insertedTarget = await db
    .insert(historicalMatchesTable)
    .values(targetRows)
    .returning({ id: historicalMatchesTable.id, cutoffAt: historicalMatchesTable.cutoffAt });

  // Feature snapshots for target matches
  const targetSnapshotRows = insertedTarget.flatMap((row, i) => {
    const m = targetRows[i];
    if (m.cancelled) return [];
    return makeSnapshotRows(row.id, row.cutoffAt, m.player1Id, m.player2Id, i + 10);
  });
  if (targetSnapshotRows.length > 0) {
    await db.insert(matchFeatureSnapshotsTable).values(targetSnapshotRows);
  }

  const bgIds = insertedBg.map((r) => r.id);
  const targetIds = insertedTarget.map((r) => r.id);
  const allSeededIds = [...bgIds, ...targetIds];

  t.after(async () => {
    // Always clean up regardless of test outcome, to leave the DB in a known state.
    await db.delete(evaluationPredictionsTable).where(inArray(evaluationPredictionsTable.historicalMatchId, allSeededIds));
    await db.delete(matchFeatureSnapshotsTable).where(inArray(matchFeatureSnapshotsTable.matchId, allSeededIds));
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, allSeededIds));
  });

  // ── Act: simulate post-bridge rescore ────────────────────────────────────
  // contextMatchIds scopes "all historical matches" to our seeded corpus only,
  // so the test completes in seconds without loading 100k+ production rows.
  // The corpus includes BOTH background rows (2019, for prior history) and
  // target rows (2020, the ones being rescored), proving the prior-history
  // requirement — each player has multiple recorded matches before any target
  // match date, so rawProbability is finite for every non-walkover/cancelled row.
  //
  // matchIds is ONLY the target IDs — background matches are context, not re-scored.
  const result = await runBridgeRescore(targetIds, { contextMatchIds: allSeededIds });

  // ── Assert: result shape ──────────────────────────────────────────────────
  assert.equal(result.notFound, 0,
    "all target matchIds must be found in historical_matches");
  assert.equal(result.failed, 0,
    "no scoring failures expected for well-formed synthetic matches with prior history");

  const nonCancelledCount = targetMatchDefs.filter((m) => !m.cancelled).length; // 3
  assert.equal(result.scored, nonCancelledCount,
    `scored must equal the number of non-cancelled target matches (${nonCancelledCount})`);

  // ── Assert: evaluation_predictions rows ───────────────────────────────────
  const predictions = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(inArray(evaluationPredictionsTable.historicalMatchId, targetIds));

  assert.equal(predictions.length, nonCancelledCount,
    `exactly ${nonCancelledCount} evaluation_predictions must exist for non-cancelled targets`);

  // Background matches must NOT appear in evaluation_predictions (they are
  // context only, not re-scored targets)
  const bgPredictions = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(inArray(evaluationPredictionsTable.historicalMatchId, bgIds));
  assert.equal(bgPredictions.length, 0,
    "background context matches must NOT appear in evaluation_predictions");

  const correctedPlayerIds = new Set([p1, p2, p3]);

  for (const pred of predictions) {
    // run_kind must always be 'historical_test'
    assert.equal(pred.runKind, "historical_test",
      `runKind must be 'historical_test', got: ${pred.runKind}`);

    // segment='test' — bridge rescore uses a single scoring pass, no validation split
    assert.equal(pred.segment, "test",
      `segment must be 'test', got: ${pred.segment}`);

    // foldId must be null — bridge rescore has no fold structure
    assert.equal(pred.foldId, null,
      "foldId must be null — bridge rescore does not create evaluation_runs folds");

    // historicalMatchId must reference one of our target matches (not background)
    assert.ok(
      targetIds.includes(pred.historicalMatchId as number),
      `historicalMatchId ${pred.historicalMatchId} must be a target matchId`,
    );

    // Player IDs in the prediction must be the CORRECTED IDs from historical_matches
    assert.ok(
      correctedPlayerIds.has(pred.player1Id as string),
      `player1Id '${pred.player1Id}' must be a corrected player ID`,
    );
    assert.ok(
      correctedPlayerIds.has(pred.player2Id as string),
      `player2Id '${pred.player2Id}' must be a corrected player ID`,
    );

    // rawProbability must be finite — every player has prior history (background matches)
    // so the engine has real data to compute Elo/form/h2h features from
    assert.ok(
      pred.rawProbability !== null && Number.isFinite(pred.rawProbability as number),
      `rawProbability must be finite (players have prior history from background matches), got: ${pred.rawProbability}`,
    );

    // status must not be 'pending'
    assert.notEqual(pred.status, "pending",
      "status must not be 'pending' after scoring");
  }

  // Verify the cancelled target match produced no prediction
  const cancelledTarget = insertedTarget.find((_, i) => targetMatchDefs[i].cancelled);
  if (cancelledTarget) {
    const cancelledPred = predictions.find((p) => p.historicalMatchId === cancelledTarget.id);
    assert.equal(cancelledPred, undefined,
      "cancelled target match must not produce an evaluation_prediction");
  }
});

test("runBridgeRescore: safe no-op for empty matchIds", async () => {
  const result = await runBridgeRescore([]);
  assert.equal(result.scored, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.notFound, 0);
});

test("runBridgeRescore: reports notFound for matchIds absent from historical_matches", async () => {
  // Use very large IDs that cannot exist as SERIAL PKs in a fresh DB
  const fakeIds = [2_147_483_640, 2_147_483_641];
  const result = await runBridgeRescore(fakeIds);
  assert.equal(result.notFound, fakeIds.length,
    "both non-existent matchIds must be reported in notFound");
  assert.equal(result.scored, 0);
  assert.equal(result.failed, 0);
});
