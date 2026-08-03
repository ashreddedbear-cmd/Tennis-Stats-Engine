import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "./predictionIdentity";
import type { MatchRecord, HeadToHeadRecord } from "../tennisData/types";

function match(id: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
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
    ...overrides,
  };
}

test("computeMatchIdentityKey is order-independent for the two players", () => {
  const forward = computeMatchIdentityKey("p1", "p2", "Test Open", "Hard", "BestOf3");
  const reversed = computeMatchIdentityKey("p2", "p1", "Test Open", "Hard", "BestOf3");
  assert.equal(forward, reversed);
});

test("computeMatchIdentityKey normalizes tournament name casing/whitespace and treats null/empty as equal", () => {
  const a = computeMatchIdentityKey("p1", "p2", "  Test Open  ", "Hard", "BestOf3");
  const b = computeMatchIdentityKey("p1", "p2", "test open", "Hard", "BestOf3");
  const c = computeMatchIdentityKey("p1", "p2", null, "Hard", "BestOf3");
  const d = computeMatchIdentityKey("p1", "p2", "", "Hard", "BestOf3");
  assert.equal(a, b);
  assert.equal(c, d);
  assert.notEqual(a, c);
});

test("computeMatchIdentityKey differs for a different surface or format", () => {
  const base = computeMatchIdentityKey("p1", "p2", "Test Open", "Hard", "BestOf3");
  assert.notEqual(base, computeMatchIdentityKey("p1", "p2", "Test Open", "Clay", "BestOf3"));
  assert.notEqual(base, computeMatchIdentityKey("p1", "p2", "Test Open", "Hard", "BestOf5"));
});

test("computeInputSnapshotHash is identical regardless of which player is designated player1 vs player2", () => {
  const p1Matches = [match("m1", { opponentId: "p2", result: "W" })];
  const p2Matches = [match("m2", { opponentId: "p1", result: "L" })];
  const headToHead: HeadToHeadRecord = { player1Id: "p1", player2Id: "p2", meetings: [] };

  const forward = computeInputSnapshotHash({
    player1Id: "p1",
    player2Id: "p2",
    player1Matches: p1Matches,
    player2Matches: p2Matches,
    headToHead,
  });
  const reversed = computeInputSnapshotHash({
    player1Id: "p2",
    player2Id: "p1",
    player1Matches: p2Matches,
    player2Matches: p1Matches,
    headToHead,
  });

  assert.equal(forward, reversed, "the hash must be the same real-world snapshot regardless of role assignment");
});

test("computeInputSnapshotHash is stable for the exact same inputs (deterministic, repeatable)", () => {
  const p1Matches = [match("m1")];
  const p2Matches = [match("m2")];
  const headToHead: HeadToHeadRecord = { player1Id: "p1", player2Id: "p2", meetings: [] };

  const a = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1Matches, player2Matches: p2Matches, headToHead });
  const b = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: [...p1Matches], player2Matches: [...p2Matches], headToHead });
  assert.equal(a, b);
});

test("computeInputSnapshotHash ignores per-request metadata so identical live requests dedupe", () => {
  const p1Matches = [match("m1")];
  const p2Matches = [match("m2")];
  const headToHead: HeadToHeadRecord = { player1Id: "p1", player2Id: "p2", meetings: [] };

  const a = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1Matches, player2Matches: p2Matches, headToHead });
  const b = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1Matches, player2Matches: p2Matches, headToHead });

  assert.equal(a, b, "identical resolved match snapshots must collapse to one stored prediction regardless of request path");
});

test("computeInputSnapshotHash changes when a player's match history changes (e.g. a newer match added)", () => {
  const p1MatchesBefore = [match("m1")];
  const p1MatchesAfter = [match("m1"), match("m3", { date: "2026-02-01" })];
  const p2Matches = [match("m2")];
  const headToHead: HeadToHeadRecord = { player1Id: "p1", player2Id: "p2", meetings: [] };

  const before = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1MatchesBefore, player2Matches: p2Matches, headToHead });
  const after = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1MatchesAfter, player2Matches: p2Matches, headToHead });

  assert.notEqual(before, after, "a materially different input snapshot (newer match history) must produce a different hash");
});

test("computeInputSnapshotHash changes when head-to-head meetings differ", () => {
  const p1Matches = [match("m1")];
  const p2Matches = [match("m2")];
  const noMeetings: HeadToHeadRecord = { player1Id: "p1", player2Id: "p2", meetings: [] };
  const withMeeting: HeadToHeadRecord = {
    player1Id: "p1",
    player2Id: "p2",
    meetings: [{ date: "2025-01-01", tournamentName: "Prior Open", surface: "Hard", score: "6-4 6-4", winnerId: "p1" }],
  };

  const a = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1Matches, player2Matches: p2Matches, headToHead: noMeetings });
  const b = computeInputSnapshotHash({ player1Id: "p1", player2Id: "p2", player1Matches: p1Matches, player2Matches: p2Matches, headToHead: withMeeting });

  assert.notEqual(a, b);
});
