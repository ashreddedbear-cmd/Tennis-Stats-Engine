/**
 * Regression tests for Uchijima-family identity disambiguation (2026-07-24).
 *
 * Issues fixed:
 *   1. "M. Uchijima" (abbreviated) appearing as a duplicate alongside "Moyuka Uchijima" in
 *      searchKnownPlayers results — live provider returns abbreviated names that are weak
 *      identity keys and must be filtered out.
 *   2. resolvePlayerProfileForPrediction failing for a historical player whose full name
 *      ("Moyuka Uchijima") the provider only returns abbreviated ("M. Uchijima") — the
 *      reverse-abbreviation fallback now bridges this gap when the match is unique.
 *   3. Maiko Uchijima and Moyuka Uchijima must never be aliased or confused with each other,
 *      even when the provider returns "M. Uchijima" for both.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/services/tennisData/playerIdentity.uchijima.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  clearCountryCodeCacheForTests,
  invalidatePlayerIdentityCacheForTests,
  searchKnownPlayers,
  resolvePlayerProfileForPrediction,
} from "./playerIdentity";
import type { PlayerProfile, PlayerSummary, TennisDataProvider, LiveScore } from "./types";

const PROVIDER = "uchijima-test";

// Stable fictional IDs — use names clearly outside real player coverage to avoid
// colliding with live historical_matches rows.
const MOYUKA_HIST_ID = "uchijima-test-moyuka-001";
const MAIKO_HIST_ID  = "uchijima-test-maiko-002";
const OPPONENT_ID    = "uchijima-test-opponent-003";

function makeMatch(player1Id: string, player1Name: string, scheduledStartAt: Date) {
  return {
    externalId: `${PROVIDER}-${player1Id}-${scheduledStartAt.toISOString()}`,
    provider: PROVIDER,
    tour: "WTA" as const,
    tournamentName: "ITF W15 Brisbane",
    tournamentLevel: "ITF" as const,
    surface: "Hard" as const,
    round: "QF",
    matchFormat: "BestOf3" as const,
    player1Id,
    player1Name,
    player2Id: OPPONENT_ID,
    player2Name: "Zztestopponent Arakawa",
    winnerId: player1Id,
    score: "6-3 6-4",
    retired: false,
    walkover: false,
    cancelled: false,
    scheduledStartAt,
    cutoffMinutes: 30,
    cutoffAt: new Date(scheduledStartAt.getTime() - 30 * 60_000),
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }],
    rawSource: {},
  };
}

/**
 * Provider that behaves like a real provider where Uchijima players are stored
 * with abbreviated first names ("M. Uchijima") — the exact scenario reported.
 * Neither Moyuka nor Maiko is in live standings, so getPlayer returns null for
 * their historical IDs (ITF-only players not in the provider's index).
 * searchPlayers("Moyuka Uchijima") returns the abbreviated form.
 */
function makeProvider(): TennisDataProvider {
  return {
    name: "fake-uchijima-test",
    getStatus: () => ({ provider: "fake", connected: true, lastSuccessfulCallAt: null, lastError: null }),
    searchPlayers: async (query: string): Promise<PlayerSummary[]> => {
      const q = query.toLowerCase();
      if (q.includes("uchijima") || q.includes("uchiji")) {
        // Provider only knows the abbreviated form — both players show as "M. Uchijima"
        // with DIFFERENT IDs (simulating the real duplicate-in-standings scenario).
        return [
          { id: "provider-m-uchijima-a", name: "M. Uchijima", countryCode: "JPN", currentRank: 210, tour: "WTA" },
          { id: "provider-m-uchijima-b", name: "M. Uchijima", countryCode: "JPN", currentRank: 340, tour: "WTA" },
        ];
      }
      return [];
    },
    getPlayer: async (playerId: string): Promise<PlayerProfile | null> => {
      // Historical IDs for Moyuka and Maiko are NOT in the provider
      if (playerId === MOYUKA_HIST_ID || playerId === MAIKO_HIST_ID) return null;
      // Provider's own abbreviated-name IDs do resolve
      if (playerId === "provider-m-uchijima-a" || playerId === "provider-m-uchijima-b") {
        return {
          id: playerId,
          name: "M. Uchijima",
          fullName: null,
          countryCode: "JPN",
          currentRank: playerId === "provider-m-uchijima-a" ? 210 : 340,
          tour: null, // not in live standings
          age: null,
          plays: null,
        };
      }
      return null;
    },
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (p1, p2) => ({ player1Id: p1, player2Id: p2, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async (): Promise<Map<string, LiveScore>> => new Map(),
  };
}

test("Uchijima identity: searchKnownPlayers filters abbreviated live results, Maiko and Moyuka remain separate", async (t) => {
  const inserted = await db
    .insert(historicalMatchesTable)
    .values([
      makeMatch(MOYUKA_HIST_ID, "Moyuka Uchijima", new Date("2026-06-10T10:00:00Z")),
      makeMatch(MAIKO_HIST_ID,  "Maiko Uchijima",  new Date("2026-06-08T10:00:00Z")),
    ])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    clearCountryCodeCacheForTests();
    invalidatePlayerIdentityCacheForTests();
  });

  const provider = makeProvider();
  const results = await searchKnownPlayers(provider, "Uchijima");

  // Abbreviated "M. Uchijima" entries from live provider must be filtered out —
  // they're weak identity keys (first word is a single initial).
  const abbreviated = results.filter((r) => r.name === "M. Uchijima");
  assert.equal(abbreviated.length, 0, `Expected no abbreviated 'M. Uchijima' results, got ${abbreviated.length}: ${JSON.stringify(abbreviated.map((r) => r.name))}`);

  // Both full-name players must be findable from the historical fallback.
  const moyuka = results.find((r) => r.name === "Moyuka Uchijima");
  const maiko  = results.find((r) => r.name === "Maiko Uchijima");
  assert.ok(moyuka, "Moyuka Uchijima should appear in search results via historical match fallback");
  assert.ok(maiko,  "Maiko Uchijima should appear in search results via historical match fallback");

  // IDs must be DIFFERENT — the two players must not be conflated.
  assert.notEqual(moyuka!.id, maiko!.id, "Moyuka and Maiko Uchijima must have distinct IDs");
});

test("Uchijima identity: resolvePlayerProfileForPrediction is ambiguous when provider returns M. Uchijima for both", async (t) => {
  const inserted = await db
    .insert(historicalMatchesTable)
    .values([
      makeMatch(MOYUKA_HIST_ID, "Moyuka Uchijima", new Date("2026-06-10T10:00:00Z")),
      makeMatch(MAIKO_HIST_ID,  "Maiko Uchijima",  new Date("2026-06-08T10:00:00Z")),
    ])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    invalidatePlayerIdentityCacheForTests();
  });

  const provider = makeProvider();

  // When the provider returns TWO abbreviated "M. Uchijima" entries, the reverse-abbreviation
  // fallback must detect ambiguity and refuse to guess, returning profile: null with a detail.
  const resolution = await resolvePlayerProfileForPrediction(provider, MOYUKA_HIST_ID);
  assert.equal(resolution.profile, null, "Should not silently pick one Uchijima over the other when ambiguous");
  assert.ok(resolution.detail, "Should explain the ambiguity to the caller");
  assert.ok(
    resolution.detail!.toLowerCase().includes("ambiguous") || resolution.detail!.toLowerCase().includes("multiple"),
    `Detail should mention ambiguity, got: "${resolution.detail}"`,
  );
});

test("Uchijima identity: resolvePlayerProfileForPrediction succeeds via reverse-abbreviation when exactly one match", async (t) => {
  // Provider that returns exactly ONE abbreviated "M. Uchijima" (only Moyuka in standings)
  const uniqueProvider: TennisDataProvider = {
    name: "fake-unique-uchijima",
    getStatus: () => ({ provider: "fake", connected: true, lastSuccessfulCallAt: null, lastError: null }),
    searchPlayers: async (query: string): Promise<PlayerSummary[]> => {
      if (query.toLowerCase().includes("uchijima")) {
        return [{ id: "provider-moyuka-only", name: "M. Uchijima", countryCode: "JPN", currentRank: 210, tour: "WTA" }];
      }
      return [];
    },
    getPlayer: async (playerId: string): Promise<PlayerProfile | null> => {
      if (playerId === MOYUKA_HIST_ID) return null;
      if (playerId === "provider-moyuka-only") {
        return { id: "provider-moyuka-only", name: "M. Uchijima", fullName: null, countryCode: "JPN", currentRank: 210, tour: null, age: null, plays: null };
      }
      return null;
    },
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (p1, p2) => ({ player1Id: p1, player2Id: p2, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async (): Promise<Map<string, LiveScore>> => new Map(),
  };

  const inserted = await db
    .insert(historicalMatchesTable)
    .values([makeMatch(MOYUKA_HIST_ID, "Moyuka Uchijima", new Date("2026-06-10T10:00:00Z"))])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    invalidatePlayerIdentityCacheForTests();
  });

  const resolution = await resolvePlayerProfileForPrediction(uniqueProvider, MOYUKA_HIST_ID);
  assert.ok(resolution.profile, "Should resolve when exactly one abbreviated match exists");
  assert.equal(resolution.resolvedPlayerId, "provider-moyuka-only");
});

test("Uchijima identity: historical-only record with no provider match at all falls back to historical profile", async (t) => {
  const noMatchProvider: TennisDataProvider = {
    name: "fake-no-match",
    getStatus: () => ({ provider: "fake", connected: true, lastSuccessfulCallAt: null, lastError: null }),
    searchPlayers: async (): Promise<PlayerSummary[]> => [],
    getPlayer: async (): Promise<null> => null,
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (p1, p2) => ({ player1Id: p1, player2Id: p2, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async (): Promise<Map<string, LiveScore>> => new Map(),
  };

  const inserted = await db
    .insert(historicalMatchesTable)
    .values([makeMatch(MAIKO_HIST_ID, "Maiko Uchijima", new Date("2026-06-08T10:00:00Z"))])
    .returning({ id: historicalMatchesTable.id });

  t.after(async () => {
    await db.delete(historicalMatchesTable).where(inArray(historicalMatchesTable.id, inserted.map((r) => r.id)));
    invalidatePlayerIdentityCacheForTests();
  });

  const resolution = await resolvePlayerProfileForPrediction(noMatchProvider, MAIKO_HIST_ID);
  assert.ok(resolution.profile, "Historical-only fallback profile should be returned");
  assert.equal(resolution.profile!.id, MAIKO_HIST_ID);
  assert.equal(resolution.profile!.name, "Maiko Uchijima");
  assert.equal(resolution.profile!.source, "historical-match");
  assert.equal(resolution.detail, null);
});
