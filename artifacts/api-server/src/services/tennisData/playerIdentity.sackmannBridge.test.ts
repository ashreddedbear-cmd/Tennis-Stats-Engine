/**
 * Unit tests for the Sackmann identity bridge in buildPlayerIdentityIndex.
 *
 * The bridge lets a sackmann-* ID (historical archive, pre-2024) alias to a live
 * provider ID (api-tennis.com, 2024+) when both share an abbreviated player name
 * (e.g. "j sinner") and their active date windows are temporally disjoint.
 *
 * The general collision guard must remain intact: abbreviated names with overlapping
 * date ranges (two different real players active simultaneously) must NOT be aliased.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { buildPlayerIdentityIndex, invalidatePlayerIdentityCacheForTests } from "./playerIdentity.js";

const PROVIDER = "sackmann-bridge-test";

function makeRow(opts: {
  externalId: string;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  year: number;
  month: number; // 1-based
}) {
  const scheduledStartAt = new Date(Date.UTC(opts.year, opts.month - 1, 15, 12, 0, 0));
  return {
    externalId: opts.externalId,
    provider: PROVIDER,
    tour: "ATP" as const,
    tournamentName: "Sackmann Bridge Test",
    tournamentLevel: null,
    surface: "Hard" as const,
    round: null,
    matchFormat: "BestOf3" as const,
    player1Id: opts.player1Id,
    player1Name: opts.player1Name,
    player2Id: opts.player2Id,
    player2Name: opts.player2Name,
    winnerId: opts.player1Id,
    score: "6-3 6-4",
    retired: false,
    walkover: false,
    cancelled: false,
    scheduledStartAt,
    cutoffMinutes: 30,
    cutoffAt: new Date(scheduledStartAt.getTime() - 30 * 60_000),
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }, { player1Games: 6, player2Games: 4 }],
    rawSource: {},
  };
}

// Unique abbreviated name — "zzqtest j sackbridgetest" normalises to an initial-form weak key.
const ABBREV_NAME = "Zzqtest J. Sackbridgetest";

test("Sackmann bridge: disjoint date ranges alias sackmann ID to live ID", async (t) => {
  // Sackmann era 2019–2020, live era 2025 → clearly disjoint.
  // LIVE_ID must NOT start with "sackmann-" — that prefix is the bridge's sackmann detector.
  const SACKMANN_ID = "sackmann-bridge-test-s1";
  const LIVE_ID = "live-bridge-test-l1"; // starts with "live-", not "sackmann-"

  const rows = [
    makeRow({ externalId: `${PROVIDER}-disj-s1`, player1Id: SACKMANN_ID, player1Name: ABBREV_NAME, player2Id: "opp-disj-a1", player2Name: "Zzqtest Opp Disjoint1", year: 2019, month: 6 }),
    makeRow({ externalId: `${PROVIDER}-disj-s2`, player1Id: SACKMANN_ID, player1Name: ABBREV_NAME, player2Id: "opp-disj-a2", player2Name: "Zzqtest Opp Disjoint2", year: 2020, month: 3 }),
    makeRow({ externalId: `${PROVIDER}-disj-l1`, player1Id: LIVE_ID,     player1Name: ABBREV_NAME, player2Id: "opp-disj-a3", player2Name: "Zzqtest Opp Disjoint3", year: 2025, month: 5 }),
  ];

  const inserted = await db.insert(historicalMatchesTable).values(rows).returning({ id: historicalMatchesTable.id });
  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    invalidatePlayerIdentityCacheForTests();
  });
  invalidatePlayerIdentityCacheForTests();

  const index = await buildPlayerIdentityIndex();

  await t.test("sackmann ID canonicalises to the live ID", () => {
    const resolved = index.canonicalIdById.get(SACKMANN_ID);
    assert.equal(resolved, LIVE_ID, "sackmann ID should canonicalize to the live ID");
  });

  await t.test("live ID canonicalises to itself", () => {
    const resolved = index.canonicalIdById.get(LIVE_ID);
    assert.equal(resolved, LIVE_ID, "live ID should canonicalize to itself");
  });

  await t.test("alias group for live ID includes both IDs", () => {
    const aliases = index.aliasIdsByCanonicalId.get(LIVE_ID);
    assert.ok(aliases, "live ID should have an alias group");
    assert.ok(aliases!.includes(SACKMANN_ID), "alias group should include the sackmann ID");
    assert.ok(aliases!.includes(LIVE_ID), "alias group should include the live ID itself");
  });

  await t.test("name lookup resolves to the live ID, not a sackmann- ID", () => {
    const normalized = "zzqtest j sackbridgetest";
    const byName = index.canonicalIdByName.get(normalized);
    assert.equal(byName, LIVE_ID, "name lookup should return the live canonical ID");
  });
});

test("Sackmann bridge: overlapping or >2 IDs — collision guard blocks aliasing", async (t) => {
  // Same abbreviated name, but a third player (OVERLAP_ID) is also active in 2019.
  // Even though LIVE_ID is disjoint from SACKMANN_ID, there are now 3 IDs — bridge requires exactly 2.
  const SACKMANN_ID = "sackmann-bridge-test-s2";
  const LIVE_ID    = "live-bridge-test-l2";   // NOT a sackmann- ID
  const OVERLAP_ID = "live-bridge-test-o2";   // NOT a sackmann- ID, active in 2019

  const rows = [
    makeRow({ externalId: `${PROVIDER}-ovlp-s1`, player1Id: SACKMANN_ID, player1Name: ABBREV_NAME, player2Id: "opp-ovlp-b1", player2Name: "Zzqtest Opp Overlap1", year: 2019, month: 6 }),
    makeRow({ externalId: `${PROVIDER}-ovlp-l1`, player1Id: LIVE_ID,     player1Name: ABBREV_NAME, player2Id: "opp-ovlp-b2", player2Name: "Zzqtest Opp Overlap2", year: 2025, month: 5 }),
    makeRow({ externalId: `${PROVIDER}-ovlp-o1`, player1Id: OVERLAP_ID,  player1Name: ABBREV_NAME, player2Id: "opp-ovlp-b3", player2Name: "Zzqtest Opp Overlap3", year: 2019, month: 9 }),
  ];

  const inserted = await db.insert(historicalMatchesTable).values(rows).returning({ id: historicalMatchesTable.id });
  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    invalidatePlayerIdentityCacheForTests();
  });
  invalidatePlayerIdentityCacheForTests();

  const index = await buildPlayerIdentityIndex();

  await t.test("sackmann ID must NOT be aliased to live ID when 3 IDs share the name", () => {
    const resolved = index.canonicalIdById.get(SACKMANN_ID);
    // The sackmann ID may be self-canonical or absent, but must never point to LIVE_ID.
    assert.notEqual(resolved, LIVE_ID,
      "sackmann ID must not be bridged to live ID when a third overlapping ID shares the name");
  });

  await t.test("overlap ID must NOT be aliased to live ID", () => {
    const resolved = index.canonicalIdById.get(OVERLAP_ID);
    assert.notEqual(resolved, LIVE_ID,
      "overlap ID must not be aliased to live ID");
  });
});
