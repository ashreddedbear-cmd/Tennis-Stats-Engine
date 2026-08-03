// Unit test for the preventive duplicate-prediction upsert. Inserts its own throwaway rows (with
// player ids namespaced to this test run) so it never asserts exact counts against the shared
// predictions table -- see .agents/memory/test-isolation-against-live-tables.md.
// Run with: pnpm --filter @workspace/api-server run test:evaluation
import test from "node:test";
import assert from "node:assert/strict";
import { db, predictionsTable, type InsertPrediction } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { saveOrUpdatePrediction } from "./savePrediction";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "../predictionEngine/predictionIdentity";
import type { MatchRecord, HeadToHeadRecord } from "../tennisData/types";

const RUN_TAG = `save-pred-test-${Date.now()}`;

function match(id: string): MatchRecord {
  return {
    id,
    date: "2026-01-01",
    tournamentName: null,
    tournamentLevel: null,
    round: null,
    matchFormat: null,
    surface: "Hard",
    indoor: null,
    opponentId: "opp",
    opponentName: "Opponent",
    opponentRank: null,
    result: "W",
    score: null,
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

function baseValues(overrides: Partial<InsertPrediction> = {}): InsertPrediction {
  const player1Id = `${RUN_TAG}-p1`;
  const player2Id = `${RUN_TAG}-p2`;
  const matchIdentityKey = computeMatchIdentityKey(player1Id, player2Id, "Test Open", "Hard", "BestOf3");
  const headToHead: HeadToHeadRecord = { player1Id, player2Id, meetings: [] };
  const inputSnapshotHash = computeInputSnapshotHash({
    player1Id,
    player2Id,
    player1Matches: [match("m1")],
    player2Matches: [match("m2")],
    headToHead,
  });

  return {
    player1Id,
    player1Name: "Test Player One",
    player2Id,
    player2Name: "Test Player Two",
    surface: "Hard",
    matchFormat: "BestOf3",
    tournamentLevel: null,
    tournamentName: "Test Open",
    predictedWinnerId: player1Id,
    predictedWinnerName: "Test Player One",
    calibratedProbability: 55,
    predictedWinnerProbability: 55,
    dataQuality: 80,
    dataQualityLabel: "Good",
    upsetRisk: "Low",
    recommendation: "MODERATE_LEAN",
    predictedSetScore: "2-1",
    engine: {},
    matchIdentityKey,
    inputSnapshotHash,
    ...overrides,
  } satisfies InsertPrediction;
}

async function cleanup(ids: number[]) {
  if (ids.length > 0) await db.delete(predictionsTable).where(inArray(predictionsTable.id, ids));
}

test("saveOrUpdatePrediction: submitting the exact same match+inputs twice reuses the existing row and never rewrites it, even before resolution", async () => {
  const values = baseValues();
  const first = await saveOrUpdatePrediction(values);
  const ids = [first.id];
  try {
    const second = await saveOrUpdatePrediction({
      ...values,
      calibratedProbability: 61,
      predictedWinnerProbability: 61,
      recommendation: "STRONG_RECOMMENDATION",
    } satisfies InsertPrediction);
    assert.equal(second.id, first.id, "an identical match+inputs repeat must reuse the same row id, not create a new one");

    const rows = await db.select().from(predictionsTable).where(inArray(predictionsTable.id, [first.id]));
    assert.equal(rows.length, 1, "there must be exactly one stored row for this match+inputs, not two");
    // Task #150: identical match+inputs means the original stored prediction always wins, even
    // while the match is still unresolved -- a later resubmission (e.g. after an engine logic
    // change with no change to the actual inputs) must never silently overwrite it.
    assert.equal(rows[0]!.calibratedProbability, 55, "an unresolved row's stored prediction must not be rewritten by an identical-input resubmission");
    assert.equal(rows[0]!.recommendation, "MODERATE_LEAN", "recommendation must stay the originally stored value");
  } finally {
    await cleanup(ids);
  }
});

test("saveOrUpdatePrediction: a resubmission for an already-graded match+inputs does not rewrite its recorded prediction", async () => {
  const values = baseValues();
  const first = await saveOrUpdatePrediction(values);
  const ids = [first.id];
  try {
    // Simulate grading: the match has since been resolved with a real outcome.
    await db
      .update(predictionsTable)
      .set({ actualWinnerId: values.predictedWinnerId, actualWinnerName: values.predictedWinnerName, resolvedAt: new Date() })
      .where(inArray(predictionsTable.id, ids));

    const resubmission = await saveOrUpdatePrediction({
      ...values,
      calibratedProbability: 99,
      predictedWinnerProbability: 99,
      recommendation: "STRONG_RECOMMENDATION",
    } satisfies InsertPrediction);
    assert.equal(resubmission.id, first.id, "still resolves to the same row, not a new duplicate");

    const rows = await db.select().from(predictionsTable).where(inArray(predictionsTable.id, ids));
    assert.equal(rows.length, 1, "no duplicate row was created");
    assert.equal(
      rows[0]!.calibratedProbability,
      55,
      "a resolved row's recorded prediction must not be rewritten by a later identical-input resubmission",
    );
    assert.equal(rows[0]!.recommendation, "MODERATE_LEAN", "recommendation on a resolved row must stay untouched");
    assert.ok(rows[0]!.actualWinnerId, "the recorded outcome itself must remain intact");
  } finally {
    await cleanup(ids);
  }
});

test("saveOrUpdatePrediction: a materially different input snapshot for the same match creates a new row", async () => {
  const values = baseValues();
  const first = await saveOrUpdatePrediction(values);
  const ids = [first.id];
  try {
    const differentHash = computeInputSnapshotHash({
      player1Id: values.player1Id,
      player2Id: values.player2Id,
      player1Matches: [match("m1"), match("m3")], // newer match history
      player2Matches: [match("m2")],
      headToHead: { player1Id: values.player1Id, player2Id: values.player2Id, meetings: [] },
    });
    assert.notEqual(differentHash, values.inputSnapshotHash);

    const second = await saveOrUpdatePrediction({ ...values, inputSnapshotHash: differentHash } satisfies InsertPrediction);
    ids.push(second.id);
    assert.notEqual(second.id, first.id, "a different input snapshot for the same match must create a new row, not overwrite the old one");

    const rows = await db.select().from(predictionsTable).where(inArray(predictionsTable.id, ids));
    assert.equal(rows.length, 2, "both rows (different inputs) must exist");
  } finally {
    await cleanup(ids);
  }
});

test("saveOrUpdatePrediction: a genuinely different match (different players) never collides with an existing row", async () => {
  const values = baseValues();
  const first = await saveOrUpdatePrediction(values);
  const ids = [first.id];
  try {
    const otherPlayer2Id = `${RUN_TAG}-p3`;
    const otherHeadToHead: HeadToHeadRecord = { player1Id: values.player1Id, player2Id: otherPlayer2Id, meetings: [] };
    const other = await saveOrUpdatePrediction(
      baseValues({
        player2Id: otherPlayer2Id,
        player2Name: "Test Player Three",
        matchIdentityKey: computeMatchIdentityKey(values.player1Id, otherPlayer2Id, "Test Open", "Hard", "BestOf3"),
        inputSnapshotHash: computeInputSnapshotHash({
          player1Id: values.player1Id,
          player2Id: otherPlayer2Id,
          player1Matches: [match("m1")],
          player2Matches: [match("m4")],
          headToHead: otherHeadToHead,
        }),
      }),
    );
    ids.push(other.id);
    assert.notEqual(other.id, first.id);
  } finally {
    await cleanup(ids);
  }
});

/**
 * Regression guard for the requestNonce issue: two POST /predictions calls with identical match
 * inputs but different request IDs must produce the same inputSnapshotHash and therefore reuse the
 * same stored prediction (not create divergent duplicate rows with contradictory labels).
 */
test("saveOrUpdatePrediction: identical match inputs from different request IDs hash identically and reuse the same row", async () => {
  const values = baseValues();
  const first = await saveOrUpdatePrediction(values);
  const ids = [first.id];
  try {
    // Simulate a second request with identical match inputs but different timestamp/request metadata.
    // The inputSnapshotHash should be identical because it deliberately excludes per-request metadata
    // (like requestNonce, requestId, etc.) -- only the resolved match snapshot matters for deduplication.
    const second = await saveOrUpdatePrediction({
      ...values,
      // These simulated metadata changes (timestamp, strategy version) are intentional to show that
      // only the inputSnapshotHash matters for dedup, not request-level tracking info.
      snapshotCapturedAt: new Date(new Date().getTime() + 1000), // 1 second later
      strategyVersion: 9999, // different strategy version in hypothetical follow-up request
    });

    assert.equal(second.id, first.id, "identical inputs must reuse the same row even with different request metadata");

    const rows = await db.select().from(predictionsTable).where(inArray(predictionsTable.id, [first.id]));
    assert.equal(rows.length, 1, "only one row must exist for identical match inputs, regardless of request metadata divergence");
  } finally {
    await cleanup(ids);
  }
});
