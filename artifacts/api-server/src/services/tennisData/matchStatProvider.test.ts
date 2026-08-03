/**
 * Unit tests for MatchStatProvider.
 *
 * Covers:
 *  - searchPlayers() populates playerById from rankings data
 *  - getPlayer() returns a profile when rankings are fresh
 *  - getPlayer() throws (does NOT return stale data) after RANKINGS_TTL_MS
 *    elapses without a fresh searchPlayers() call
 *  - getPlayer() returns fresh data after a subsequent searchPlayers() re-populates
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MatchStatProvider, RANKINGS_TTL_MS } from "./matchStatProvider.js";
import { ProviderUnavailableError } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(stub: FetchStub): () => void {
  const prev = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  return () => {
    (globalThis as unknown as Record<string, unknown>).fetch = prev;
  };
}

/** Advance Date.now by offsetMs; returns a restore function. */
function advanceDateNow(offsetMs: number): () => void {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  return () => { Date.now = real; };
}

function rankingEntry(id: number, name: string, rank: number) {
  return { rank, player: { id, name, country: "ESP", points: 1000 } };
}

/** Build a fetch stub that serves mock ATP/WTA rankings and 404s everything else. */
function rankingsFetchStub(atpEntries: object[], wtaEntries: object[]): FetchStub {
  return async (url: string) => {
    if (url.includes("/ranking/atp")) return jsonResponse(atpEntries);
    if (url.includes("/ranking/wta")) return jsonResponse(wtaEntries);
    // Upcoming fixtures not needed for these tests
    return jsonResponse({}, 404);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("searchPlayers() populates playerById so getPlayer() returns a profile", async () => {
  const provider = new MatchStatProvider("test-key");
  const restore = mockFetch(rankingsFetchStub(
    [rankingEntry(101, "Carlos Alcaraz", 1)],
    [rankingEntry(201, "Iga Swiatek", 1)],
  ));
  try {
    await provider.searchPlayers("alcaraz");
    const profile = await provider.getPlayer("101");
    assert.equal(profile?.name, "Carlos Alcaraz");
    assert.equal(profile?.tour, "ATP");
    assert.equal(profile?.currentRank, 1);
    assert.equal(profile?.source, "live-standings");
    // WTA player also accessible
    const wtaProfile = await provider.getPlayer("201");
    assert.equal(wtaProfile?.name, "Iga Swiatek");
  } finally {
    restore();
  }
});

test("getPlayer() returns null/throws for a player not present in rankings", async () => {
  const provider = new MatchStatProvider("test-key");
  const restore = mockFetch(rankingsFetchStub(
    [rankingEntry(101, "Carlos Alcaraz", 1)],
    [],
  ));
  try {
    await provider.searchPlayers("alcaraz");
    await assert.rejects(
      () => provider.getPlayer("999"),
      ProviderUnavailableError,
    );
  } finally {
    restore();
  }
});

test("getPlayer() throws after RANKINGS_TTL_MS elapses without a re-fetch (stale-cache guard)", async () => {
  const provider = new MatchStatProvider("test-key");
  const restore = mockFetch(rankingsFetchStub(
    [rankingEntry(101, "Carlos Alcaraz", 1)],
    [],
  ));
  try {
    // Populate rankings
    await provider.searchPlayers("alcaraz");

    // Confirm getPlayer works while fresh
    const fresh = await provider.getPlayer("101");
    assert.equal(fresh?.name, "Carlos Alcaraz");

    // Advance clock past TTL — playerById should be treated as expired
    const restoreTime = advanceDateNow(RANKINGS_TTL_MS + 1);
    try {
      await assert.rejects(
        () => provider.getPlayer("101"),
        ProviderUnavailableError,
        "getPlayer must NOT return a stale profile after TTL expiry",
      );
    } finally {
      restoreTime();
    }
  } finally {
    restore();
  }
});

test("getPlayer() returns fresh data after searchPlayers() re-fetches past expiry", async () => {
  const provider = new MatchStatProvider("test-key");

  // First fetch — Alcaraz at rank 1
  const restoreFirst = mockFetch(rankingsFetchStub(
    [rankingEntry(101, "Carlos Alcaraz", 1)],
    [],
  ));
  await provider.searchPlayers("alcaraz");
  restoreFirst();

  // Advance past TTL so TtlCache considers the entry stale
  const restoreTime = advanceDateNow(RANKINGS_TTL_MS + 1);
  try {
    // Second fetch — Alcaraz at rank 2 (simulating a rankings change)
    const restoreSecond = mockFetch(rankingsFetchStub(
      [rankingEntry(101, "Carlos Alcaraz", 2)],
      [],
    ));
    await provider.searchPlayers("alcaraz");
    restoreSecond();

    const profile = await provider.getPlayer("101");
    assert.equal(profile?.currentRank, 2, "getPlayer must return the refreshed rank, not the stale one");
  } finally {
    restoreTime();
  }
});
