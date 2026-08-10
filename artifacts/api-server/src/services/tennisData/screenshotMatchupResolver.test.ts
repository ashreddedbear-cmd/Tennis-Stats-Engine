// Unit tests for the screenshot-import surface fallback and name-resolution helpers.
// Run with: pnpm --filter @workspace/api-server run test:tennisData
import test from "node:test";
import assert from "node:assert/strict";
import { resolveScreenshotMatchup, isInitialEquivalentGroup } from "./screenshotMatchupResolver";
import type { PlayerSummary, TennisDataProvider } from "./types";

// ── isInitialEquivalentGroup unit tests ────────────────────────────────────
// These are pure-function tests with no DB or provider dependency.
// They directly verify the collapse predicate covers its four safety rules.

test("isInitialEquivalentGroup: collapses abbreviated + full name sharing same surname", () => {
  // "G. Kravchenko" and "Georgii Kravchenko" are the same player
  const g   = ["g", "kravchenko"];
  const full = ["georgii", "kravchenko"];
  assert.equal(isInitialEquivalentGroup([g, full]), true);
  // Order-independent
  assert.equal(isInitialEquivalentGroup([full, g]), true);
});

test("isInitialEquivalentGroup: does NOT collapse when multiple distinct full first names share same initial", () => {
  // "G. Kravchenko" could be Georgii OR Goncalo — genuine ambiguity
  const initial  = ["g",       "kravchenko"];
  const georgii  = ["georgii", "kravchenko"];
  const goncalo  = ["goncalo", "kravchenko"];
  assert.equal(isInitialEquivalentGroup([initial, georgii, goncalo]), false);
});

test("isInitialEquivalentGroup: does NOT collapse two full names with the same surname", () => {
  // "Gonzalo Castro" and "Geraldo Castro" — no initial, genuinely different players
  assert.equal(
    isInitialEquivalentGroup([["gonzalo", "castro"], ["geraldo", "castro"]]),
    false,
  );
});

test("isInitialEquivalentGroup: does NOT collapse when surname parts differ (multi-word surname)", () => {
  // "G. Castro" (surname part "castro") vs "Goncalo Da Rosa Castro" (surname part "da rosa castro")
  const gCastro   = ["g",       "castro"];
  const fullCastro = ["goncalo", "da", "rosa", "castro"];
  assert.equal(isInitialEquivalentGroup([gCastro, fullCastro]), false);
});

test("isInitialEquivalentGroup: does NOT collapse fuzzy near-names (no single-char initial present)", () => {
  // "Geor Kravchenko" vs "Georgii Kravchenko" — looks similar but neither is an initial
  assert.equal(
    isInitialEquivalentGroup([["geor", "kravchenko"], ["georgii", "kravchenko"]]),
    false,
  );
});

test("isInitialEquivalentGroup: does NOT collapse when initial does not match full first name", () => {
  // "K. Kravchenko" cannot be an initial of "Georgii Kravchenko" — wrong letter
  assert.equal(
    isInitialEquivalentGroup([["k", "kravchenko"], ["georgii", "kravchenko"]]),
    false,
  );
});

test("isInitialEquivalentGroup: handles three candidates with one abbreviation correctly", () => {
  // "G. Kravchenko" (id=10071) and "G. Kravchenko" (id=28099) plus "Georgii Kravchenko" — all same player
  const g1   = ["g", "kravchenko"];
  const g2   = ["g", "kravchenko"];
  const full = ["georgii", "kravchenko"];
  assert.equal(isInitialEquivalentGroup([g1, g2, full]), true);
});

function makeProvider(overrides: Partial<TennisDataProvider> = {}): TennisDataProvider {
  return {
    name: "fake",
    getStatus: () => ({ provider: "fake", connected: true, lastSuccessfulCallAt: null, lastError: null }),
    searchPlayers: async (): Promise<PlayerSummary[]> => [],
    getPlayer: async () => null,
    getPlayerMatches: async () => [],
    getUpcomingFixtures: async () => [],
    getUpcomingFixturesRange: async () => [],
    getHeadToHead: async (player1Id: string, player2Id: string) => ({ player1Id, player2Id, meetings: [] }),
    getCompletedMatchesByDateRange: async () => [],
    getLiveScores: async () => new Map(),
    ...overrides,
  };
}

test("resolveScreenshotMatchup falls back to a real name search for a Challenger event the name table never covers", async () => {
  const provider = makeProvider({
    findTournamentSurfaceByName: async (name: string) => {
      assert.equal(name, "ATP Challenger Pozoblanco");
      return { surface: "Clay", level: "Challenger" };
    },
  });

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [{ player1Name: null, player2Name: null, eventName: "ATP Challenger Pozoblanco" }],
  });

  assert.equal(result.event.surface, "Clay");
  assert.equal(result.event.level, "Challenger");
  assert.ok(!result.warnings.some((w) => w.includes("couldn't determine its surface")));
});

test("resolveScreenshotMatchup still warns when the name-search fallback also finds nothing", async () => {
  const provider = makeProvider({
    findTournamentSurfaceByName: async () => null,
  });

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [{ player1Name: null, player2Name: null, eventName: "Some Untraceable Regional Event" }],
  });

  assert.equal(result.event.surface, null);
  assert.ok(result.warnings.some((w) => w.includes("couldn't determine its surface")));
});

test("resolveScreenshotMatchup never calls the name-search fallback when a provider doesn't implement it", async () => {
  const provider = makeProvider(); // no findTournamentSurfaceByName at all

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [{ player1Name: null, player2Name: null, eventName: "ATP Challenger Pozoblanco" }],
  });

  assert.equal(result.event.surface, null);
  assert.ok(result.warnings.some((w) => w.includes("couldn't determine its surface")));
});

test("resolveScreenshotMatchup prefers the precise named table over the name-search fallback for a major", async () => {
  const provider = makeProvider({
    findTournamentSurfaceByName: async () => {
      throw new Error("should never be called -- Wimbledon already resolves via the named table");
    },
  });

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [{ player1Name: null, player2Name: null, eventName: "Wimbledon" }],
  });

  assert.equal(result.event.surface, "Grass");
  assert.equal(result.event.level, "GrandSlam");
});

test("resolveScreenshotMatchup returns matchups array with multiple entries when input has multiple", async () => {
  // Use clearly fictional names ("Testington", "Fakeovsky") that cannot appear in the real
  // historical_matches DB rows — avoids the mock-id vs DB-id duplicate that trips isConfidentMatch.
  const provider = makeProvider({
    searchPlayers: async (query: string) => {
      if (query.toLowerCase().includes("testington"))
        return [{ id: "test-1", name: "John Testington", countryCode: "TST", currentRank: 99, tour: "ATP" }];
      if (query.toLowerCase().includes("fakeovsky"))
        return [{ id: "fake-1", name: "Ivan Fakeovsky", countryCode: "FAK", currentRank: 98, tour: "ATP" }];
      if (query.toLowerCase().includes("mockerson"))
        return [{ id: "mock-1", name: "Dave Mockerson", countryCode: "MCK", currentRank: 97, tour: "ATP" }];
      if (query.toLowerCase().includes("stubsworth"))
        return [{ id: "stub-1", name: "Carl Stubsworth", countryCode: "STB", currentRank: 96, tour: "ATP" }];
      return [];
    },
  });

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [
      { player1Name: "Testington", player2Name: "Fakeovsky", eventName: null },
      { player1Name: "Mockerson", player2Name: "Stubsworth", eventName: null },
    ],
  });

  assert.ok(result.matchups, "matchups array present");
  assert.equal(result.matchups!.length, 2);
  assert.equal(result.matchups![0].player1.player?.id, "test-1");
  assert.equal(result.matchups![0].player2.player?.id, "fake-1");
  assert.equal(result.matchups![1].player1.player?.id, "mock-1");
  assert.equal(result.matchups![1].player2.player?.id, "stub-1");
  assert.ok(result.matchups![0].resolved);
  assert.ok(result.matchups![1].resolved);
});

test("resolveScreenshotMatchup never auto-selects a player when multiple confident candidates exist", async () => {
  // Use two non-abbreviated full names that both match the OCR input "G. Castro" via
  // initial expansion ("gonzalo" ↔ "g", "geraldo" ↔ "g") — but they are genuinely
  // different players, so the initial-equivalent collapse must NOT fire (different first
  // names that aren't mutual initials of each other) and the result must be ambiguous.
  // Abbreviated names like "G. Castro" are filtered out of live-provider results by
  // searchKnownPlayers (prevents duplicate abbreviated/full collisions), so the test
  // must use full-name candidates to exercise the multi-confident ambiguity path.
  const provider = makeProvider({
    searchPlayers: async (query: string) => {
      if (query.toLowerCase().includes("castro")) {
        return [
          { id: "p-castro-a", name: "Gonzalo Castro", countryCode: "PT", currentRank: 100, tour: "ATP" },
          { id: "p-castro-b", name: "Geraldo Castro", countryCode: "BR", currentRank: 120, tour: "ATP" },
        ];
      }
      if (query.toLowerCase().includes("testington")) {
        return [{ id: "test-1", name: "John Testington", countryCode: "TST", currentRank: 99, tour: "ATP" }];
      }
      return [];
    },
  });

  const result = await resolveScreenshotMatchup(provider, {
    matchups: [{ player1Name: "G. Castro", player2Name: "Testington", eventName: null }],
  });

  assert.equal(result.player1.player, null);
  assert.equal(result.player2.player?.id, "test-1");
  assert.equal(result.matchups?.[0].resolved, false);
  assert.ok(result.warnings.some((w) => w.includes("multiple matching players were found")));
});
