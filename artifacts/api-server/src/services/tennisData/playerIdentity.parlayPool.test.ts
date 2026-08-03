/**
 * Regression tests for the three player-identity fixes that affect full parlay-pool resolution:
 *
 *   Fix 1 (parallel validation) — validateHistoricalPlayerId calls are now issued with
 *     Promise.all inside searchKnownPlayers, eliminating the 125 s serial-timeout when a
 *     provider is down and a single LIKE query returns many unique player IDs.
 *
 *   Fix 2 (transient-failure cache) — a 2-min TTL cache means the same player ID is probed
 *     at most once per 2 minutes when the provider is unavailable, so a 73-screenshot batch
 *     never re-queues the same slow MatchStat timeout repeatedly.
 *
 *   Fix 3 (extended abbreviated-fallback gate) — the abbreviated transient-fallback pool is
 *     now surfaced not only when the entire base result set is empty, but also when no base
 *     candidate's surname matches the query surname. This prevents a LIKE-matched player with
 *     a different (but overlapping) surname from permanently blocking the real abbreviated player.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx --test \
 *     src/services/tennisData/playerIdentity.parlayPool.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  clearCountryCodeCacheForTests,
  clearTransientFailureCacheForTests,
  invalidatePlayerIdentityCacheForTests,
  searchKnownPlayers,
} from "./playerIdentity";
import type { PlayerProfile, PlayerSummary, TennisDataProvider, LiveScore } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMatch(opts: {
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  tour: "ATP" | "WTA";
  scheduledStartAt: Date;
  provider: string;
  externalIdSuffix: string;
}) {
  return {
    externalId: `${opts.provider}-${opts.externalIdSuffix}`,
    provider: opts.provider,
    tour: opts.tour,
    tournamentName: "Parlay Pool Identity Test",
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
    scheduledStartAt: opts.scheduledStartAt,
    cutoffMinutes: 30,
    cutoffAt: new Date(opts.scheduledStartAt.getTime() - 30 * 60_000),
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }],
    rawSource: {},
  };
}

/** Provider that throws (simulates circuit-open / MatchStat timeout) on every call. */
function makeDownProvider(): TennisDataProvider {
  return {
    name: "down-provider",
    getStatus: () => ({ provider: "down", connected: false, lastSuccessfulCallAt: null, lastError: "circuit open" }),
    searchPlayers: async (): Promise<PlayerSummary[]> => {
      throw new Error("circuit open");
    },
    getPlayer: async (): Promise<PlayerProfile | null> => {
      throw new Error("circuit open");
    },
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (p1, p2) => ({ player1Id: p1, player2Id: p2, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async (): Promise<Map<string, LiveScore>> => new Map(),
  };
}

/** Provider that waits `delayMs` then throws — used to verify parallel execution in timing tests. */
function makeSlowProvider(delayMs: number): TennisDataProvider {
  const delay = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("circuit open")), delayMs));
  return {
    name: "slow-provider",
    getStatus: () => ({ provider: "slow", connected: false, lastSuccessfulCallAt: null, lastError: "circuit open" }),
    searchPlayers: async (): Promise<PlayerSummary[]> => { return delay(); },
    getPlayer: async (): Promise<PlayerProfile | null> => { return delay(); },
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (p1, p2) => ({ player1Id: p1, player2Id: p2, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async (): Promise<Map<string, LiveScore>> => new Map(),
  };
}

function clearCaches() {
  clearCountryCodeCacheForTests();
  invalidatePlayerIdentityCacheForTests();
  clearTransientFailureCacheForTests();
}

// ── Test 1: Abbreviated DB names resolve when provider is down ────────────────
// Scenario: DB has "T. Zzztestfritz" and "A. Zzztestsabalenka" — abbreviated first-name forms
// that are weak identity keys. When the live provider is down, validateHistoricalPlayerId
// throws → entries land in abbreviatedTransientFallback. Because the base result pool is empty
// (no live results, no validated non-weak historical entries), shouldUseFallback = true and both
// players surface via the last-resort fallback path.

test("abbreviated DB names (T. Fritz, A. Sabalenka style) resolve via transient fallback when provider is unavailable", async (t) => {
  const RUN_ID = `abbrev-${Date.now()}`;
  const PROVIDER = `parlay-pool-test-${RUN_ID}`;
  const FRITZ_ID = `${RUN_ID}-fritz`;
  const SABALENKA_ID = `${RUN_ID}-sabalenka`;
  const OPP_ID = `${RUN_ID}-opp`;
  const DATE = new Date("2026-01-15T10:00:00Z");
  // Use RUN_ID-suffixed surnames so the LIKE query only matches this test's rows.
  const FRITZ_NAME = `T. Zzztestfritz${RUN_ID}`;
  const SABALENKA_NAME = `A. Zzztestsabalenka${RUN_ID}`;

  const inserted = await db
    .insert(historicalMatchesTable)
    .values([
      makeMatch({ player1Id: FRITZ_ID, player1Name: FRITZ_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Zz1", tour: "ATP", scheduledStartAt: DATE, provider: PROVIDER, externalIdSuffix: `fritz-${RUN_ID}` }),
      makeMatch({ player1Id: SABALENKA_ID, player1Name: SABALENKA_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Zz2", tour: "WTA", scheduledStartAt: DATE, provider: PROVIDER, externalIdSuffix: `sabalenka-${RUN_ID}` }),
    ])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    clearCaches();
  });

  const downProvider = makeDownProvider();

  // ── Fritz search ──────────────────────────────────────────────────────────
  // LIKE pattern: %zzztestfritz{RUN_ID}% — only matches this test's row.
  // "T. Zzztestfritz{RUN_ID}" → isWeakIdentityNameKey = true → abbreviatedTransientFallback
  // baseResultsEmpty = true → shouldUseFallback = true → player surfaces.
  const fritzResults = await searchKnownPlayers(downProvider, `Zzztestfritz${RUN_ID}`);
  const fritz = fritzResults.find((r) => r.id === FRITZ_ID);
  assert.ok(
    fritz,
    `"${FRITZ_NAME}" must resolve via transient fallback when provider is down; got: ${JSON.stringify(fritzResults.map((r) => r.name))}`,
  );
  assert.equal(fritz!.name, FRITZ_NAME, "resolved name must match stored abbreviated name");

  // ── Sabalenka search ──────────────────────────────────────────────────────
  const sabalenkaResults = await searchKnownPlayers(downProvider, `Zzztestsabalenka${RUN_ID}`);
  const sabalenka = sabalenkaResults.find((r) => r.id === SABALENKA_ID);
  assert.ok(
    sabalenka,
    `"${SABALENKA_NAME}" must resolve via transient fallback when provider is down; got: ${JSON.stringify(sabalenkaResults.map((r) => r.name))}`,
  );
  assert.equal(sabalenka!.name, SABALENKA_NAME, "resolved name must match stored abbreviated name");
});

// ── Test 2: Extended fallback gate fires when base has a different-surnamed player ──────
// Scenario (issue 3): DB has:
//   - "M. Zzztestfbsurname{RUN_ID}"      — abbreviated, isWeakIdentityNameKey=true → transient fallback
//   - "Zora Zzztestfbsurname{RUN_ID}plus" — non-abbreviated. Its surname ends in "plus" so it differs
//     from the query surname "zzztestfbsurname{RUN_ID}", BUT its name contains
//     "zzztestfbsurname{RUN_ID}" as a substring → the LIKE matches both rows.
//
// LIKE `%zzztestfbsurname{RUN_ID}%` matches:
//   "m. zzztestfbsurname{RUN_ID}"              ✓  (exact suffix)
//   "zora zzztestfbsurname{RUN_ID}plus"         ✓  (suffix is prefix of "zzztestfbsurname{RUN_ID}plus")
//
// querySurnameForFallback = "zzztestfbsurname{RUN_ID}".
// "Zora Zzztestfbsurname{RUN_ID}plus" candidateSurname = "zzztestfbsurname{RUN_ID}plus"
//   ≠ querySurnameForFallback → baseHasSurnameMatch = false → shouldUseFallback = true
//   → "M. Zzztestfbsurname{RUN_ID}" correctly surfaces from abbreviatedTransientFallback.

test("extended fallback gate fires when base results contain only a different-surnamed player (issue 3 scenario)", async (t) => {
  const RUN_ID = `fb-${Date.now()}`;
  const PROVIDER = `parlay-pool-test-${RUN_ID}`;
  const ABBREV_ID = `${RUN_ID}-abbrev`;
  const BLOCKING_ID = `${RUN_ID}-blocking`;
  const OPP_ID = `${RUN_ID}-opp`;
  const DATE = new Date("2026-02-01T10:00:00Z");
  // Abbreviated target player — weak identity key (first word is single initial).
  const SURNAME = `Zzztestfbsurname${RUN_ID}`;
  const ABBREV_NAME = `M. ${SURNAME}`;
  // Non-abbreviated "blocking" player: surname ends in "plus" so it differs from the query
  // surname, but the name still contains SURNAME as a substring → LIKE matches.
  const BLOCKING_NAME = `Zora ${SURNAME}plus`;

  const inserted = await db
    .insert(historicalMatchesTable)
    .values([
      makeMatch({ player1Id: ABBREV_ID, player1Name: ABBREV_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Za1", tour: "WTA", scheduledStartAt: DATE, provider: PROVIDER, externalIdSuffix: `abbrev-${RUN_ID}` }),
      makeMatch({ player1Id: BLOCKING_ID, player1Name: BLOCKING_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Za2", tour: "ATP", scheduledStartAt: DATE, provider: PROVIDER, externalIdSuffix: `blocking-${RUN_ID}` }),
    ])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    clearCaches();
  });

  const downProvider = makeDownProvider();

  // Search by the exact surname.  LIKE %{SURNAME}% matches both rows.
  // "Zora {SURNAME}plus" → non-weak → historicalSummaries (provider unavailable) → filteredHistorical.
  // "M. {SURNAME}"       → weak     → abbreviatedTransientFallback.
  //
  // querySurnameForFallback = lower(SURNAME).
  // "Zora {SURNAME}plus" candidateSurname = lower("{SURNAME}plus") ≠ lower(SURNAME)
  //   → baseHasSurnameMatch = false → shouldUseFallback = true → abbreviated player surfaces.
  const results = await searchKnownPlayers(downProvider, SURNAME);

  // The abbreviated player must surface despite the base pool being non-empty.
  const abbrevPlayer = results.find((r) => r.id === ABBREV_ID);
  assert.ok(
    abbrevPlayer,
    `"${ABBREV_NAME}" must surface via the extended fallback gate even though "${BLOCKING_NAME}" fills the base pool; got: ${JSON.stringify(results.map((r) => ({ id: r.id, name: r.name })))}`,
  );

  // The blocking player must also appear (it legitimately matched the LIKE and its name is non-weak).
  const blockingPlayer = results.find((r) => r.id === BLOCKING_ID);
  assert.ok(
    blockingPlayer,
    `"${BLOCKING_NAME}" should also be present in results (non-weak name, provider unavailable → added to historicalSummaries); got: ${JSON.stringify(results.map((r) => ({ id: r.id, name: r.name })))}`,
  );
});

// ── Test 3: Ambiguous-abbreviation guard holds ─────────────────────────────────
// When two distinct players are both stored with the same abbreviated name (e.g. "M. Zzztestambig{RUN_ID}"),
// searchKnownPlayers must return BOTH with distinct IDs — never conflate them into one, never
// silently drop one. This validates the collision-guard in buildPlayerIdentityIndex (isWeakIdentityNameKey
// prevents aliasing) and the deduplication-by-ID in the final results.

test("two players stored with the same abbreviated name return as distinct IDs — no silent conflation", async (t) => {
  const RUN_ID = `ambig-${Date.now()}`;
  const PROVIDER = `parlay-pool-test-${RUN_ID}`;
  const PLAYER_A_ID = `${RUN_ID}-ambig-a`;
  const PLAYER_B_ID = `${RUN_ID}-ambig-b`;
  const OPP_ID = `${RUN_ID}-opp`;
  const DATE_A = new Date("2026-03-01T10:00:00Z");
  const DATE_B = new Date("2026-03-02T10:00:00Z");
  // Both players share the same abbreviated name — the classic initial-collision scenario.
  const SHARED_NAME = `M. Zzztestambig${RUN_ID}`;

  const inserted = await db
    .insert(historicalMatchesTable)
    .values([
      makeMatch({ player1Id: PLAYER_A_ID, player1Name: SHARED_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Zb1", tour: "WTA", scheduledStartAt: DATE_A, provider: PROVIDER, externalIdSuffix: `ambig-a-${RUN_ID}` }),
      makeMatch({ player1Id: PLAYER_B_ID, player1Name: SHARED_NAME, player2Id: OPP_ID, player2Name: "Zzztestopp Zb2", tour: "WTA", scheduledStartAt: DATE_B, provider: PROVIDER, externalIdSuffix: `ambig-b-${RUN_ID}` }),
    ])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    clearCaches();
  });

  const downProvider = makeDownProvider();

  const results = await searchKnownPlayers(downProvider, `Zzztestambig${RUN_ID}`);
  const ours = results.filter((r) => r.id === PLAYER_A_ID || r.id === PLAYER_B_ID);

  // Both players must appear — the abbreviated transient fallback surfaces all unambiguous
  // abbreviated entries when the base pool is empty.
  assert.equal(
    ours.length,
    2,
    `Both players with shared name "${SHARED_NAME}" must appear in results with distinct IDs; got: ${JSON.stringify(ours)}`,
  );

  // IDs must be distinct — no aliasing or conflation.
  const ids = ours.map((r) => r.id);
  assert.ok(ids.includes(PLAYER_A_ID), "Player A must be in results");
  assert.ok(ids.includes(PLAYER_B_ID), "Player B must be in results");
  assert.notEqual(
    ids[0],
    ids[1],
    "The two players must have distinct IDs — they must not be aliased to the same identity",
  );
});

// ── Test 4: 73-player batch completes in < 4 s despite 100 ms per provider call ──────────
// Validates Fix 1 (parallel validateHistoricalPlayerId calls).
//
// Scenario: a single searchKnownPlayers call returns 73 distinct player IDs from the DB.
// The provider takes 100 ms per call before throwing (simulates MatchStat timeout).
//
//   Sequential execution (broken): 73 × 100 ms = 7,300 ms  → FAILS 4 s budget
//   Parallel execution (fixed):         ~100 ms             → PASSES 4 s budget
//
// The test seeds 73 distinct abbreviated players all sharing the query surname "Zzztestbatch{RUN_ID}"
// so a single LIKE query finds all of them, triggering a batch validation in the same Promise.all.

test("73-player batch validates in parallel — completes in < 4 s with 100 ms per provider call", async (t) => {
  const BATCH_SIZE = 73;
  const DELAY_MS  = 100;
  const BUDGET_MS = 4_000;

  const RUN_ID  = `batch-${Date.now()}`;
  const PROVIDER = `parlay-pool-test-${RUN_ID}`;
  const OPP_ID  = `${RUN_ID}-opp`;
  const DATE     = new Date("2026-04-01T10:00:00Z");
  // All 73 players share surname "Zzztestbatch{RUN_ID}" so one LIKE query finds all.
  // First-name initials A–Z repeated as needed to keep names distinct.
  const INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const players  = Array.from({ length: BATCH_SIZE }, (_, i) => {
    const initial = INITIALS[i % INITIALS.length]!;
    const seq     = String(i + 1).padStart(3, "0");
    const id      = `${RUN_ID}-batch-${seq}`;
    const name    = `${initial}. Zzztestbatch${RUN_ID}${seq}`;
    return { id, name };
  });

  const matchRows = players.map((p, i) =>
    makeMatch({
      player1Id: p.id,
      player1Name: p.name,
      player2Id: OPP_ID,
      player2Name: `Zzztestbatchopp${i}`,
      tour: "ATP",
      scheduledStartAt: new Date(DATE.getTime() + i * 60_000),
      provider: PROVIDER,
      externalIdSuffix: `batch-${RUN_ID}-${i}`,
    }),
  );

  const inserted = await db
    .insert(historicalMatchesTable)
    .values(matchRows)
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    clearCaches();
  });

  // Clear the transient-failure cache so all 73 IDs need a fresh provider probe.
  clearTransientFailureCacheForTests();

  const slowProvider = makeSlowProvider(DELAY_MS);

  const startMs = Date.now();
  // Query "Zzztestbatch{RUN_ID}" — the LIKE pattern matches all 73 players (their names contain
  // "zzztestbatch{RUN_ID}" as a prefix of their unique suffix).
  const results = await searchKnownPlayers(slowProvider, `Zzztestbatch${RUN_ID}`);
  const elapsedMs = Date.now() - startMs;

  // searchKnownPlayers caps its output at 25. All 73 IDs are still validated in parallel
  // (the Promise.all runs over all DB rows regardless of the output cap), so the timing
  // assertion below proves parallelism. The count assertion just confirms the function
  // returned the expected maximum.
  const RESULT_CAP = 25;
  const ours = results.filter((r) => players.some((p) => p.id === r.id));
  assert.equal(
    ours.length,
    RESULT_CAP,
    `searchKnownPlayers caps results at ${RESULT_CAP}; got ${ours.length}`,
  );

  // ── Timing assertion ──────────────────────────────────────────────────────
  // Sequential would take ${BATCH_SIZE} × ${DELAY_MS} ms = ${BATCH_SIZE * DELAY_MS} ms.
  // Parallel takes ≈ ${DELAY_MS} ms (one round-trip for all).
  assert.ok(
    elapsedMs < BUDGET_MS,
    `Batch of ${BATCH_SIZE} players with ${DELAY_MS} ms provider delay must complete in < ${BUDGET_MS} ms (parallel), ` +
    `but took ${elapsedMs} ms. Sequential execution would take ${BATCH_SIZE * DELAY_MS} ms — ` +
    `if elapsed ≈ ${BATCH_SIZE * DELAY_MS} ms, the Promise.all parallelism fix has regressed.`,
  );
});
