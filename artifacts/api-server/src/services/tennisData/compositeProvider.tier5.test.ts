/**
 * Unit tests for CompositeTennisProvider's tier-5 DB fallback thin-data warning.
 *
 * Scenario: all live providers (primary, fallback, BSD, Sofascore) are unavailable or
 * return zero records, so tier-5 queries `historical_matches`. When that DB query also
 * returns fewer than SOFASCORE_MIN_RECORDS_THRESHOLD (5) records, a `logger.warn` must
 * fire to make the thin-data risk visible. When DB has ≥ 5 rows (player has walk-forward
 * history), the warning must NOT fire.
 *
 * Approach: subclass CompositeTennisProvider to override the two protected methods that
 * isolate the DB and identity steps, avoiding real DB connections in tests. The logger is
 * spied on via mock.method() — no module mocking required.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CompositeTennisProvider } from "./compositeProvider.js";
import { ProviderUnavailableError } from "./types.js";
import { logger } from "../../lib/logger.js";
import type {
  Fixture,
  HeadToHeadRecord,
  HistoricalFixture,
  LiveScore,
  MatchRecord,
  PlayerProfile,
  PlayerSummary,
  ProviderStatusInfo,
  TennisDataProvider,
} from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UNAVAILABLE = new ProviderUnavailableError("provider down");

function makeUnavailableProvider(name: string): TennisDataProvider {
  return {
    name,
    getStatus(): ProviderStatusInfo {
      return { provider: name, connected: false, lastSuccessfulCallAt: null, lastError: "down" };
    },
    async searchPlayers(): Promise<PlayerSummary[]> { throw UNAVAILABLE; },
    async getPlayer(): Promise<PlayerProfile | null> { throw UNAVAILABLE; },
    async getPlayerMatches(): Promise<MatchRecord[]> { throw UNAVAILABLE; },
    async getUpcomingFixtures(): Promise<Fixture[]> { throw UNAVAILABLE; },
    async getUpcomingFixturesRange(): Promise<Fixture[]> { throw UNAVAILABLE; },
    async getHeadToHead(): Promise<HeadToHeadRecord> { throw UNAVAILABLE; },
    async getCompletedMatchesByDateRange(): Promise<HistoricalFixture[]> { return []; },
    async getLiveScores(): Promise<Map<string, LiveScore>> { return new Map(); },
  };
}

function makeRecord(id: string): MatchRecord {
  return {
    id,
    date: "2026-01-01",
    tournamentName: null,
    tournamentLevel: null,
    round: null,
    matchFormat: null,
    surface: "Hard",
    indoor: null,
    opponentId: "opp-1",
    opponentName: "Opponent",
    opponentRank: null,
    result: "W",
    score: "6-3 6-4",
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

/**
 * Testable subclass that overrides the two protected tier-5 hooks so tests can control
 * what the DB returns without a real database connection.
 *
 * BSD Tennis and Sofascore are effectively disabled because no player name is ever seeded
 * (seedPlayerName is not called) — those tiers check `playerNameCache` before firing.
 */
class Tier5TestProvider extends CompositeTennisProvider {
  constructor(
    primary: TennisDataProvider,
    fallback: TennisDataProvider,
    private readonly dbRecords: MatchRecord[],
  ) {
    super(primary, fallback);
  }

  /** Return a trivial single-ID alias group — no real identity index needed. */
  protected override async resolveAliasIds(playerId: string): Promise<string[]> {
    return [playerId];
  }

  /** Return the pre-configured records instead of querying the real DB. */
  protected override async fetchDbHistory(_aliasIds: string | string[]): Promise<MatchRecord[]> {
    return this.dbRecords;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CompositeTennisProvider — tier-5 DB fallback thin-data warning", () => {
  // Spy on logger.warn so we can assert it fired (or did not fire) for the tier-5 path.
  // mock.method replaces the bound method and restores it in afterEach.
  let warnSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    warnSpy = mock.method(logger, "warn");
  });

  afterEach(() => {
    mock.restoreAll();
  });

  /** Returns all tier-5 thin-data warn calls captured during a test. */
  function tier5WarnCalls(): Array<{ arguments: unknown[] }> {
    return (warnSpy.mock.calls as Array<{ arguments: unknown[] }>).filter(({ arguments: args }) => {
      const msg = args[1];
      return typeof msg === "string" && (msg.includes("no DB fallback available") || msg.includes("thin-data path"));
    });
  }

  it("fires logger.warn with prior:0 and db:0 when all providers and DB return nothing", async () => {
    const composite = new Tier5TestProvider(
      makeUnavailableProvider("Primary"),
      makeUnavailableProvider("Fallback"),
      [], // DB returns zero records
    );

    const result = await composite.getPlayerMatches("player-new");

    // Contract 1: empty array returned — no throw
    assert.deepEqual(result, [], "should return empty array when all tiers have no data");

    // Contract 2: exactly one tier-5 thin-data warn
    const calls = tier5WarnCalls();
    assert.equal(calls.length, 1, `expected exactly 1 tier-5 warn; got ${JSON.stringify(calls)}`);

    const fields = calls[0]!.arguments[0] as Record<string, unknown>;
    assert.equal(fields["prior"], 0, "warn.prior should be 0 (no live-provider records)");
    assert.equal(fields["db"], 0, "warn.db should be 0 (DB is empty)");
    assert.equal(fields["playerId"], "player-new", "warn.playerId should match the requested player");
  });

  it("fires logger.warn with db:3 and returns those 3 rows when DB has minimal history", async () => {
    const dbRows = [makeRecord("db-1"), makeRecord("db-2"), makeRecord("db-3")];
    const composite = new Tier5TestProvider(
      makeUnavailableProvider("Primary"),
      makeUnavailableProvider("Fallback"),
      dbRows, // DB returns 3 rows (below threshold of 5)
    );

    const result = await composite.getPlayerMatches("player-sparse");

    // Contract 1: the 3 DB rows are returned
    assert.equal(result.length, 3, "should return the 3 DB rows");

    // Contract 2: warn fires (prior:0, db:3)
    const calls = tier5WarnCalls();
    assert.equal(calls.length, 1, `expected exactly 1 tier-5 warn; got ${JSON.stringify(calls)}`);

    const fields = calls[0]!.arguments[0] as Record<string, unknown>;
    assert.equal(fields["prior"], 0, "warn.prior should be 0 (all live providers returned zero)");
    assert.equal(fields["db"], 3, "warn.db should be 3 (minimal but non-zero DB records)");
  });

  it("does NOT fire logger.warn when DB returns 20+ rows (player has walk-forward history)", async () => {
    const dbRows = Array.from({ length: 20 }, (_, i) => makeRecord(`db-wf-${i}`));
    const composite = new Tier5TestProvider(
      makeUnavailableProvider("Primary"),
      makeUnavailableProvider("Fallback"),
      dbRows, // DB has sufficient walk-forward history
    );

    const result = await composite.getPlayerMatches("player-established");

    // Contract 1: all 20 DB rows returned
    assert.equal(result.length, 20, "should return all 20 DB rows");

    // Contract 2: no thin-data warn — walk-forward history is sufficient
    const calls = tier5WarnCalls();
    assert.equal(
      calls.length,
      0,
      `warn should NOT fire when DB has ≥5 records; got: ${JSON.stringify(calls)}`,
    );
  });
});

describe("CompositeTennisProvider — merge not replace across tiers", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("merges tier-2 fallback records with tier-5 DB records instead of discarding the smaller set", async () => {
    // Tier-2 fallback returns 2 records (below threshold of 5) — old behaviour would
    // discard these if tier-5 DB returned more; new behaviour keeps both.
    const fallbackProvider: TennisDataProvider = {
      ...makeUnavailableProvider("Fallback"),
      async getPlayerMatches(): Promise<MatchRecord[]> {
        return [makeRecord("api-1"), makeRecord("api-2")];
      },
    };

    // DB (tier-5) adds 3 records with different IDs.
    const composite = new Tier5TestProvider(
      makeUnavailableProvider("Primary"), // tier-1 → [] 
      fallbackProvider,                   // tier-2 → [api-1, api-2]
      [makeRecord("db-1"), makeRecord("db-2"), makeRecord("db-3")], // tier-5 adds 3
    );

    const result = await composite.getPlayerMatches("player-merge");

    // Must have all 5 unique records, not just 3 (the old "take the longer" behaviour).
    assert.equal(result.length, 5, `expected 5 merged records (2 from tier-2 + 3 from tier-5); got ${result.length}`);
    assert.deepEqual(
      result.map(r => r.id).sort(),
      ["api-1", "api-2", "db-1", "db-2", "db-3"],
    );
  });

  it("deduplicates by id — a record present in two tiers is counted once", async () => {
    // Tier-2 and tier-5 both contain "shared-1"; the merged set should include it only once.
    const fallbackProvider: TennisDataProvider = {
      ...makeUnavailableProvider("Fallback"),
      async getPlayerMatches(): Promise<MatchRecord[]> {
        return [makeRecord("shared-1"), makeRecord("api-2")];
      },
    };

    const composite = new Tier5TestProvider(
      makeUnavailableProvider("Primary"),
      fallbackProvider,
      [makeRecord("shared-1"), makeRecord("db-2"), makeRecord("db-3")],
    );

    const result = await composite.getPlayerMatches("player-dedup");

    // 2 from tier-2 + 3 from tier-5 with 1 shared id = 4 unique records.
    assert.equal(result.length, 4, `expected 4 unique records after id-dedup; got ${result.length}`);
    assert.deepEqual(
      result.map(r => r.id).sort(),
      ["api-2", "db-2", "db-3", "shared-1"],
    );
  });
});
