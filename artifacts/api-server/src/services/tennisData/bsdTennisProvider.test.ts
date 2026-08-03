/**
 * Unit tests for bsdTennisProvider name-resolution logic.
 *
 * Covers:
 *  - Exact cache hit (fast path, no fetch)
 *  - Full-word rankings-cache scan: same-surname ranked vs. sub-500 player
 *  - Search fallback: successful match, caching of resolved ID, resolvedVia field
 *  - Search fallback: 429 rate-limit → silent null (non-fatal)
 *  - Search fallback: invalid JSON → silent null (non-fatal)
 *  - Search fallback: no candidate passes full-name filter → null
 *  - Search fallback: multiple candidates pass (ambiguous) → null
 *  - fetchFromBsdTennis: no key → empty results without any fetch
 *
 * The BSD key is faked via process.env so the module initialises normally.
 * global.fetch is replaced per-test with a minimal stub.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fetchFromBsdTennis, resetBsdRankingsCacheForTests } from "./bsdTennisProvider.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_KEY = "test-key-bsd";

/** A minimal BSD paginated envelope. */
function paginated<T>(results: T[], count?: number) {
  return { count: count ?? results.length, next: null, previous: null, results };
}

function bsdPlayer(id: number, name: string, short_name = ""): object {
  return { id, name, short_name, gender: "M", country_code: "ESP", current_ranking: { position: id * 10, points: 1000, type: "ATP" } };
}

function bsdRankingEntry(id: number, name: string): object {
  return { id, player: bsdPlayer(id, name), ranking_type: "ATP", position: id * 10 };
}

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withFakeKey(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const original = process.env.BSD_TENNIS_API_KEY;
    process.env.BSD_TENNIS_API_KEY = FAKE_KEY;
    try {
      await fn();
    } finally {
      process.env.BSD_TENNIS_API_KEY = original;
      delete process.env.BSD_TENNIS_API_KEY;
      resetBsdRankingsCacheForTests();
    }
  };
}

function mockFetch(stub: FetchStub) {
  const prev = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  return () => { (globalThis as unknown as Record<string, unknown>).fetch = prev; };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("fetchFromBsdTennis: no API key → empty results, no fetch calls", async () => {
  const original = process.env.BSD_TENNIS_API_KEY;
  delete process.env.BSD_TENNIS_API_KEY;
  let fetchCalled = false;
  const restore = mockFetch(async () => { fetchCalled = true; return jsonResponse({}); });
  try {
    const result = await fetchFromBsdTennis("Rafael Nadal");
    assert.deepEqual(result.records, []);
    assert.equal(fetchCalled, false, "fetch must not be called when no key is configured");
  } finally {
    if (original !== undefined) process.env.BSD_TENNIS_API_KEY = original;
    restore();
    resetBsdRankingsCacheForTests();
  }
});

test("fetchFromBsdTennis: exact rankings-cache hit returns records without hitting search endpoint", withFakeKey(async () => {
  const calls: string[] = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes("/rankings/")) {
      // Cache: one ranked player "Pablo Cuevas" id=101
      return jsonResponse(paginated([bsdRankingEntry(101, "Pablo Cuevas")], 1));
    }
    if (url.includes("/matches/")) {
      return jsonResponse(paginated([]));
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Pablo Cuevas");
    assert.equal(result.resolvedVia, "rankings-cache");
    assert.deepEqual(result.records, []);
    // Second call must hit exact cache, no second rankings fetch
    const prevCalls = calls.length;
    await fetchFromBsdTennis("Pablo Cuevas");
    assert.equal(calls.filter(u => u.includes("/rankings/")).length, 1, "rankings must be fetched only once");
    void prevCalls;
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: ranked player with same surname is NOT aliased to sub-500 query", withFakeKey(async () => {
  // Rankings cache has "Pablo Cuevas" (id=101). Query is for "Carlos Cuevas" (sub-500).
  // "pablo cuevas" does NOT contain the word "carlos" → no cache match.
  // Search endpoint is queried for "cuevas", returns only "Pablo Cuevas" → fails full-name filter (missing "carlos").
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) {
      return jsonResponse(paginated([bsdRankingEntry(101, "Pablo Cuevas")], 1));
    }
    if (url.includes("/players/?search=")) {
      // Search returns the ranked Pablo, not the sub-500 Carlos
      return jsonResponse(paginated([bsdPlayer(101, "Pablo Cuevas")]));
    }
    if (url.includes("/matches/")) {
      return jsonResponse(paginated([]));
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Carlos Cuevas");
    // Pablo Cuevas does not match "carlos cuevas" → null → empty records
    assert.deepEqual(result.records, [], "ranked player with same surname must NOT be aliased to sub-500 query");
    assert.equal(result.resolvedVia, undefined, "resolvedVia must be absent when player is not found");
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: search fallback finds sub-500 player, caches result, second call is a cache hit", withFakeKey(async () => {
  let rankingsCalls = 0;
  let searchCalls = 0;
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) {
      rankingsCalls++;
      // Empty rankings — player is sub-500
      return jsonResponse(paginated([], 0));
    }
    if (url.includes("/players/?search=")) {
      searchCalls++;
      return jsonResponse(paginated([bsdPlayer(750, "Facundo Diaz Acosta")]));
    }
    if (url.includes("/matches/")) {
      return jsonResponse(paginated([]));
    }
    return jsonResponse({}, 404);
  });

  try {
    const first = await fetchFromBsdTennis("Facundo Diaz Acosta");
    assert.equal(first.resolvedVia, "search-fallback");
    assert.equal(searchCalls, 1, "search should fire once for the unknown player");

    // Second call: must hit the cache, no second search
    const second = await fetchFromBsdTennis("Facundo Diaz Acosta");
    assert.equal(second.resolvedVia, "rankings-cache", "second call must resolve via cache");
    assert.equal(searchCalls, 1, "search must not be called again after caching");
    assert.equal(rankingsCalls, 1, "rankings must not be re-fetched within the TTL");
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: search 429 rate-limit → empty results, non-fatal", withFakeKey(async () => {
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) return jsonResponse(paginated([], 0));
    if (url.includes("/players/?search=")) return new Response("rate limited", { status: 429 });
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Unknown Player");
    assert.deepEqual(result.records, []);
    assert.equal(result.resolvedVia, undefined);
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: search returns invalid JSON → empty results, non-fatal", withFakeKey(async () => {
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) return jsonResponse(paginated([], 0));
    if (url.includes("/players/?search=")) {
      return new Response("not json at all {{{{", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Unknown Player");
    assert.deepEqual(result.records, []);
    assert.equal(result.resolvedVia, undefined);
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: search returns no results matching full name → empty results", withFakeKey(async () => {
  // Search for "Marco Trungelliti" but only "Carlos Trungelliti" is returned (wrong first name)
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) return jsonResponse(paginated([], 0));
    if (url.includes("/players/?search=")) {
      return jsonResponse(paginated([bsdPlayer(800, "Carlos Trungelliti")]));
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Marco Trungelliti");
    assert.deepEqual(result.records, [], "wrong first name must block aliasing");
    assert.equal(result.resolvedVia, undefined);
  } finally {
    restore();
  }
}));

test("fetchFromBsdTennis: ambiguous search results (two candidates both pass full-name filter) → empty results", withFakeKey(async () => {
  // Both "Juan Martinez" and "Juan Martinez Lopez" fully contain all words of "Juan Martinez"
  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) return jsonResponse(paginated([], 0));
    if (url.includes("/players/?search=")) {
      return jsonResponse(paginated([
        bsdPlayer(901, "Juan Martinez"),
        bsdPlayer(902, "Juan Martinez Lopez"),
      ]));
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Juan Martinez");
    assert.deepEqual(result.records, [], "ambiguous search must not alias to either candidate");
    assert.equal(result.resolvedVia, undefined);
  } finally {
    restore();
  }
}));

// ─── Pagination tests ──────────────────────────────────────────────────────

test("fetchBsdPlayerMatches: follows next cursor and returns records from both pages", withFakeKey(async () => {
  const capturedUrls: string[] = [];

  // Build a finished match stub
  function finishedMatch(id: number, playerId: number): object {
    return {
      id,
      tournament: { id: 1, name: "Test Open", circuit: "ATP", category: "ATP250", surface: "Hard" },
      player1: { id: playerId, name: "Test Player", short_name: "T. Player", gender: "M", country_code: "ARG", current_ranking: null },
      player2: { id: 999, name: "Opponent Name", short_name: "O. Name", gender: "M", country_code: "ESP", current_ranking: null },
      match_date: "2025-06-01",
      status: "finished",
      round_name: "R32",
      player1_sets: 2,
      player2_sets: 0,
      sets_detail: [{ p1: 6, p2: 3 }, { p1: 6, p2: 4 }],
      winner_id: playerId,
      odds_player1: null,
      odds_player2: null,
    };
  }

  const PAGE2_URL = "https://sports.bzzoiro.com/tennis/api/v2/matches/?player=300&status=finished&date_from=2022-01-01&date_to=2025-01-01&limit=200&offset=200";

  const restore = mockFetch(async (url) => {
    capturedUrls.push(url);
    if (url.includes("/rankings/")) {
      return jsonResponse(paginated([bsdRankingEntry(300, "Test Player")], 1));
    }
    if (url.includes("/matches/") && !url.includes("offset=200")) {
      // First page: 1 match, next points to page 2
      return jsonResponse({
        count: 2,
        next: PAGE2_URL,
        previous: null,
        results: [finishedMatch(1001, 300)],
      });
    }
    if (url.includes("offset=200")) {
      // Second page: 1 match, no next
      return jsonResponse({
        count: 2,
        next: null,
        previous: null,
        results: [finishedMatch(1002, 300)],
      });
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Test Player");
    assert.equal(result.resolvedVia, "rankings-cache");
    // Both pages must be merged
    assert.equal(result.records.length, 2, "must return records from both pages");
    const ids = result.records.map(r => r.id).sort();
    assert.deepEqual(ids, ["bsd-1001", "bsd-1002"]);
    // Two matches requests (one per page) must have been made
    const matchRequests = capturedUrls.filter(u => u.includes("/matches/"));
    assert.equal(matchRequests.length, 2, "must make two matches requests for a two-page response");
  } finally {
    restore();
  }
}));

test("fetchBsdPlayerMatches: stops at hard cap and returns exactly MAX_MATCHES_HARD_CAP records", withFakeKey(async () => {
  // Simulate 6 pages × 200 raw results each = 1 200 total raw; all map cleanly.
  // The hard cap is 1 000, so we expect exactly 1 000 mapped records and no 6th-page request.

  let matchPageCount = 0;

  function makePage(pageIndex: number, hasNext: boolean): object {
    const results = Array.from({ length: 200 }, (_, i) => ({
      id: pageIndex * 200 + i + 1,
      tournament: { id: 1, name: "Big Open", circuit: "ATP", category: "ATP250", surface: "Hard" },
      player1: { id: 42, name: "Big Hitter", short_name: "B. Hitter", gender: "M", country_code: "USA", current_ranking: null },
      player2: { id: 999, name: "Opponent", short_name: "Opp", gender: "M", country_code: "ESP", current_ranking: null },
      match_date: "2025-05-01",
      status: "finished",
      round_name: "R32",
      player1_sets: 2,
      player2_sets: 0,
      sets_detail: [{ p1: 6, p2: 3 }, { p1: 6, p2: 4 }],
      winner_id: 42,
      odds_player1: null,
      odds_player2: null,
    }));
    return {
      count: 1200,
      next: hasNext ? `https://sports.bzzoiro.com/tennis/api/v2/matches/?player=42&offset=${(pageIndex + 1) * 200}` : null,
      previous: null,
      results,
    };
  }

  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) {
      return jsonResponse(paginated([bsdRankingEntry(42, "Big Hitter")], 1));
    }
    if (url.includes("/matches/")) {
      const page = makePage(matchPageCount, matchPageCount < 5);
      matchPageCount++;
      return jsonResponse(page);
    }
    return jsonResponse({}, 404);
  });

  try {
    const result = await fetchFromBsdTennis("Big Hitter");
    assert.equal(result.records.length, 1000, "must return exactly 1000 records at the hard cap");
    assert.ok(matchPageCount <= 5, `must stop fetching at or before 5 pages; fetched ${matchPageCount}`);
  } finally {
    restore();
  }
}));

test("fetchBsdPlayerMatches: hostile next cursor from different origin is rejected, does not forward auth token", withFakeKey(async () => {
  let maliciousFetchCalled = false;

  const restore = mockFetch(async (url) => {
    if (url.includes("/rankings/")) {
      return jsonResponse(paginated([bsdRankingEntry(77, "Safe Player")], 1));
    }
    if (url.includes("sports.bzzoiro.com") && url.includes("/matches/")) {
      // First page: next points to a different origin
      return jsonResponse({
        count: 300,
        next: "https://evil.example.com/steal-token?player=77&offset=200",
        previous: null,
        results: Array.from({ length: 200 }, (_, i) => ({
          id: i + 1,
          tournament: { id: 1, name: "Open", circuit: "ATP", category: "ATP250", surface: "Hard" },
          player1: { id: 77, name: "Safe Player", short_name: "S. Player", gender: "M", country_code: "AUS", current_ranking: null },
          player2: { id: 88, name: "Other", short_name: "O.", gender: "M", country_code: "ESP", current_ranking: null },
          match_date: "2025-06-01",
          status: "finished",
          round_name: "R32",
          player1_sets: 2,
          player2_sets: 0,
          sets_detail: [{ p1: 6, p2: 3 }, { p1: 6, p2: 1 }],
          winner_id: 77,
          odds_player1: null,
          odds_player2: null,
        })),
      });
    }
    if (url.includes("evil.example.com")) {
      maliciousFetchCalled = true;
      return jsonResponse({});
    }
    return jsonResponse({}, 404);
  });

  try {
    // Should throw (origin mismatch) rather than silently follow the hostile cursor
    await assert.rejects(
      () => fetchFromBsdTennis("Safe Player"),
      /origin mismatch/i,
      "must throw on a cursor pointing to a different origin",
    );
    assert.equal(maliciousFetchCalled, false, "must never send a request to the hostile origin");
  } finally {
    restore();
  }
}));

// ─── Match history URL parameter regression tests ──────────────────────────
// These guard against the silent bugs discovered during task #53:
//   1. `player_id=` is silently IGNORED by the BSD API; correct param is `player=`.
//   2. Without `date_from`/`date_to` BSD defaults to the next 7 days (no history).
//   3. Without `status=finished` in-progress/scheduled matches are included.
// Because BSD ignores unknown params without any error, any regression is invisible
// in production — these tests are the only safety net.

test("fetchBsdPlayerMatches: outgoing URL uses player= (not player_id), status=finished, and a date_from bound", withFakeKey(async () => {
  const capturedUrls: string[] = [];

  const restore = mockFetch(async (url) => {
    capturedUrls.push(url);
    if (url.includes("/rankings/")) {
      // Put the player in the rankings cache so we go directly to matches fetch.
      return jsonResponse(paginated([bsdRankingEntry(200, "Mariano Navone")], 1));
    }
    if (url.includes("/matches/")) {
      return jsonResponse(paginated([]));
    }
    return jsonResponse({}, 404);
  });

  try {
    await fetchFromBsdTennis("Mariano Navone");

    const matchUrl = capturedUrls.find(u => u.includes("/matches/"));
    assert.ok(matchUrl, "a matches request must be made");

    const parsed = new URL(matchUrl!);
    const params = parsed.searchParams;

    // 1. Correct player filter param (not the silently-ignored player_id).
    assert.ok(
      params.has("player"),
      `matches URL must contain player= param; got: ${matchUrl}`,
    );
    assert.ok(
      !params.has("player_id"),
      `matches URL must NOT contain player_id= (silently ignored by BSD); got: ${matchUrl}`,
    );

    // 2. Date range must be present — without it BSD defaults to the next 7 days.
    assert.ok(
      params.has("date_from"),
      `matches URL must contain date_from= param; got: ${matchUrl}`,
    );
    assert.ok(
      params.has("date_to"),
      `matches URL must contain date_to= param; got: ${matchUrl}`,
    );

    // 3. Status filter must restrict to finished matches.
    assert.equal(
      params.get("status"),
      "finished",
      `matches URL must contain status=finished; got: ${matchUrl}`,
    );
  } finally {
    restore();
  }
}));
