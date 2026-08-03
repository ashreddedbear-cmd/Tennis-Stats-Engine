/**
 * Unit tests for builderProviderFetch.ts
 *
 * Pure name-matching helpers are tested directly (no mocking needed).
 * The provider chain is tested via the `_providers` injection parameter so
 * no module mocking or network access is required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchPlayerMatchesFromProviders,
  type BuilderProviders,
} from "./builderProviderFetch.js";
import { ProviderUnavailableError } from "../tennisData/index.js";
import type { MatchRecord, PlayerSummary } from "../tennisData/index.js";
import type { SofascoreFetchResult } from "./sofascoreProvider.js";
import { isConfidentSofascoreMatch } from "./sofascoreProvider.js";

// ─── Test doubles ─────────────────────────────────────────────────────────────

/** Minimal provider stub with sensible defaults — override only what the test needs. */
function makeRapidApiStub(overrides: {
  searchPlayers?: (q: string) => Promise<PlayerSummary[]>;
} = {}): BuilderProviders["rapidApi"] {
  return {
    searchPlayers: overrides.searchPlayers ?? (async () => []),
    // MatchStat never has match history
    getPlayerMatches: async () => {
      throw new ProviderUnavailableError("MatchStat: player match history endpoint not available");
    },
  } as unknown as BuilderProviders["rapidApi"];
}

function makeApiTennisStub(overrides: {
  searchPlayers?: (q: string) => Promise<PlayerSummary[]>;
  getPlayerMatches?: (id: string) => Promise<MatchRecord[]>;
} = {}): BuilderProviders["apiTennis"] {
  return {
    searchPlayers: overrides.searchPlayers ?? (async () => []),
    getPlayerMatches: overrides.getPlayerMatches ?? (async () => []),
  } as unknown as BuilderProviders["apiTennis"];
}

function makeSofascoreStub(overrides: {
  player?: PlayerSummary | null;
  records?: MatchRecord[];
  error?: string | null;
}): BuilderProviders["sofascore"] {
  const result: SofascoreFetchResult = {
    player: overrides.player ?? null,
    records: overrides.records ?? [],
    error: overrides.error ?? null,
  };
  return async () => result;
}

function makeRecord(id = "m1"): MatchRecord {
  return {
    id,
    result: "W",
    opponentId: "opp1",
    opponentName: "Opp Player",
    tournamentName: "Roland Garros",
    surface: "Clay",
    round: "QF",
    date: "2024-06-01",
    score: "6-3 6-4",
    retired: false,
    walkover: false,
    opponentRank: 10,
    tournamentLevel: "GrandSlam",
    matchFormat: "BestOf3",
    indoor: null,
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

function makePlayer(id = "at-1", name = "Test Player", tour = "ATP"): PlayerSummary {
  return { id, name, tour, currentRank: 50, countryCode: "XX" };
}

function makeProviderError(message: string, status?: number): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  if (status !== undefined) err.status = status;
  return err;
}

describe("shared playerIdentity resolver path", () => {
  it("resolves the six target players through the builder using the shared name resolver", async () => {
    const cases = [
      { playerName: "Taylor Fritz", providerName: "Fritz, Taylor", providerId: "p-fritz" },
      { playerName: "Matteo Berrettini", providerName: "Berrettini, Matteo", providerId: "p-berrettini" },
      { playerName: "Zheng Qinwen", providerName: "Qinwen Zheng", providerId: "p-zheng" },
      { playerName: "Miomir Kecmanovic", providerName: "Kecmanovic, Miomir", providerId: "p-kecmanovic" },
      { playerName: "James Duckworth", providerName: "James Duckworth", providerId: "p-duckworth" },
      { playerName: "Christopher O'Connell", providerName: "O’Connell, Christopher", providerId: "p-oconnell" },
    ] as const;

    for (const testCase of cases) {
      const providers: BuilderProviders = {
        rapidApi: null,
        apiTennis: makeApiTennisStub({
          searchPlayers: async () => [makePlayer(testCase.providerId, testCase.providerName)],
          getPlayerMatches: async () => [makeRecord(`${testCase.providerId}-m1`)],
        }),
        sofascore: makeSofascoreStub({ player: null, records: [] }),
      };

      const result = await fetchPlayerMatchesFromProviders(testCase.playerName, undefined, providers);

      assert.equal(result.diagnostics.outcome, "DATA_FOUND", `${testCase.playerName} should resolve through the builder`);
      assert.equal(result.resolvedPlayerName, testCase.providerName);
      assert.equal(result.resolvedPlayerId, testCase.providerId);
      assert.equal(result.records.length, 1);
      assert.ok(result.diagnostics.sourcesSuccessful.includes("api-tennis"));
      assert.equal(result.diagnostics.playerResolutionMethod, "shared-player-identity");
    }
  });

  it("accepts the same six names in Sofascore candidate formatting", () => {
    const cases = [
      { playerName: "Taylor Fritz", candidateName: "Fritz, Taylor" },
      { playerName: "Matteo Berrettini", candidateName: "Berrettini, Matteo" },
      { playerName: "Zheng Qinwen", candidateName: "Qinwen Zheng" },
      { playerName: "Miomir Kecmanovic", candidateName: "Kecmanovic, Miomir" },
      { playerName: "James Duckworth", candidateName: "James Duckworth" },
      { playerName: "Christopher O'Connell", candidateName: "O’Connell, Christopher" },
    ] as const;

    for (const testCase of cases) {
      assert.ok(
        isConfidentSofascoreMatch(testCase.candidateName, testCase.playerName),
        `${testCase.playerName} should match candidate ${testCase.candidateName}`,
      );
    }
  });
});

// ─── fetchPlayerMatchesFromProviders — provider chain ────────────────────────

describe("fetchPlayerMatchesFromProviders — provider chain", () => {
  // ── Happy paths ────────────────────────────────────────────────────────────

  it("DATA_FOUND when API-Tennis finds player + records", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-1", "Carlos Alcaraz")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Carlos Alcaraz", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.equal(result.records.length, 1);
    assert.equal(result.resolvedPlayerId, "at-1");
    assert.ok(result.diagnostics.sourcesSuccessful.includes("api-tennis"));
  });

  it("RapidAPI player identity recorded in diagnostics even though no records", async () => {
    const providers: BuilderProviders = {
      rapidApi: makeRapidApiStub({
        searchPlayers: async (q) =>
          q.toLowerCase().includes("alcaraz")
            ? [makePlayer("rapid-99", "Carlos Alcaraz")]
            : [],
      }),
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-1", "Carlos Alcaraz")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Carlos Alcaraz", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.ok(result.diagnostics.sourcesAttempted.includes("rapidapi"));
    assert.ok(result.diagnostics.sourcesSuccessful.includes("rapidapi"));
    assert.equal(result.diagnostics.providerIdsFound["rapidapi"], "rapid-99");
    assert.equal(result.diagnostics.recordsPerSource["rapidapi"], 0);
  });

  it("falls through to Sofascore when API-Tennis returns 0 records", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-2", "Luca Nardi")],
        getPlayerMatches: async () => [],
      }),
      sofascore: makeSofascoreStub({
        player: { id: "sf-1", name: "Luca Nardi", tour: "ATP", countryCode: "IT", currentRank: 100 },
        records: [makeRecord("sf-m1"), makeRecord("sf-m2")],
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("Luca Nardi", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.equal(result.records.length, 2);
    assert.equal(result.resolvedPlayerId, "sf-1");
    assert.ok(result.diagnostics.sourcesSuccessful.includes("sofascore"));
  });

  // ── Diacritic normalisation end-to-end ────────────────────────────────────

  it("finds player when query has NFD-decomposable diacritics and provider returns ASCII name", async () => {
    // é = e + combining acute → NFD + strip combining → e; "Clément" → "Clement"
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-clem", "Arnaud Clement")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Arnaud Clément", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND",
      "diacritic query (é) should match ASCII provider result after NFD normalisation");
    assert.equal(result.resolvedPlayerName, "Arnaud Clement");
  });

  it("finds player when provider result has diacritics and query is ASCII", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-nar", "David Nalbandián")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("David Nalbandian", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND",
      "ASCII query should match diacritic provider result");
  });

  // ── Reversed / abbreviated name format ────────────────────────────────────

  it("matches provider result in 'Lastname, F.' reversed format", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-kok", "Kokkinakis, T.")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Thanasi Kokkinakis", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND",
      "reversed-format provider name should match");
  });

  it("matches abbreviated 'T. Kokkinakis' query against full provider name", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-kok", "Thanasi Kokkinakis")],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("T. Kokkinakis", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND",
      "abbreviated query should match full provider name");
  });

  // ── Provider unavailable / fallback ───────────────────────────────────────

  it("continues to API-Tennis when RapidAPI throws ProviderUnavailableError", async () => {
    const providers: BuilderProviders = {
      rapidApi: makeRapidApiStub({
        searchPlayers: async () => { throw new ProviderUnavailableError("rate-limit"); },
      }),
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer()],
        getPlayerMatches: async () => [makeRecord()],
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.ok(result.diagnostics.sourcesFailed.includes("rapidapi"));
    assert.ok(result.diagnostics.sourcesSuccessful.includes("api-tennis"));
  });

  it("surfaces RapidAPI 401 as SOURCE_UNAVAILABLE instead of PLAYER_NOT_FOUND", async () => {
    const providers: BuilderProviders = {
      rapidApi: makeRapidApiStub({
        searchPlayers: async () => { throw makeProviderError("Unauthorized", 401); },
      }),
      apiTennis: makeApiTennisStub(),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "SOURCE_UNAVAILABLE");
    assert.ok(result.diagnostics.sourcesFailed.includes("rapidapi"));
    assert.ok(result.diagnostics.failureReasons.some((reason) => reason.includes("401")));
    assert.ok(result.diagnostics.failureReasons.some((reason) => reason.includes("rapidapi search")));
  });

  it("surfaces API-Tennis 429 as SOURCE_UNAVAILABLE instead of PLAYER_NOT_FOUND", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => { throw makeProviderError("Too Many Requests", 429); },
      }),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "SOURCE_UNAVAILABLE");
    assert.ok(result.diagnostics.sourcesFailed.includes("api-tennis"));
    assert.ok(result.diagnostics.failureReasons.some((reason) => reason.includes("429")));
    assert.ok(result.diagnostics.failureReasons.some((reason) => reason.includes("api-tennis search")));
  });

  it("surfaces Sofascore timeout as SOURCE_UNAVAILABLE instead of PLAYER_NOT_FOUND", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: null,
      sofascore: async () => {
        throw makeProviderError("timeout while reading response");
      },
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "SOURCE_UNAVAILABLE");
    assert.ok(result.diagnostics.sourcesFailed.includes("sofascore"));
    assert.ok(result.diagnostics.failureReasons.some((reason) => reason.toLowerCase().includes("timeout")));
  });

  it("falls through to Sofascore when API-Tennis search throws ProviderUnavailableError", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => { throw new ProviderUnavailableError("timeout"); },
      }),
      sofascore: makeSofascoreStub({
        player: { id: "sf-1", name: "Test Player", tour: "ATP", countryCode: null, currentRank: null },
        records: [makeRecord()],
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.ok(result.diagnostics.sourcesFailed.includes("api-tennis"));
    assert.ok(result.diagnostics.sourcesSuccessful.includes("sofascore"));
  });

  it("returns PLAYER_NOT_FOUND when all three providers return no matching player", async () => {
    const providers: BuilderProviders = {
      rapidApi: makeRapidApiStub(),           // returns []
      apiTennis: makeApiTennisStub(),         // returns []
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Unknown Player XYZ", undefined, providers);

    assert.equal(result.diagnostics.outcome, "PLAYER_NOT_FOUND");
    assert.equal(result.records.length, 0);
    assert.equal(result.resolvedPlayerId, null);
  });

  it("returns NO_MATCH_HISTORY when API-Tennis finds player but both it and Sofascore return 0 records", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub({
        searchPlayers: async () => [makePlayer("at-new", "New Player")],
        getPlayerMatches: async () => [],
      }),
      sofascore: makeSofascoreStub({
        player: { id: "sf-new", name: "New Player", tour: "ATP", countryCode: null, currentRank: null },
        records: [],
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("New Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "NO_MATCH_HISTORY");
    assert.equal(result.records.length, 0);
  });

  // ── No providers configured ───────────────────────────────────────────────

  it("uses only Sofascore when both RapidAPI and API-Tennis providers are null", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: null,
      sofascore: makeSofascoreStub({
        player: { id: "sf-only", name: "Solo Player", tour: "ATP", countryCode: null, currentRank: null },
        records: [makeRecord()],
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("Solo Player", undefined, providers);

    assert.equal(result.diagnostics.outcome, "DATA_FOUND");
    assert.deepEqual(result.diagnostics.sourcesAttempted, ["sofascore"]);
  });

  it("returns PLAYER_NOT_FOUND when all providers null and Sofascore responds but finds nothing", async () => {
    // Sofascore IS attempted and responds (player not found) — the correct outcome
    // is PLAYER_NOT_FOUND, not DATA_UNAVAILABLE.  DATA_UNAVAILABLE means all
    // providers were *unreachable* (threw errors), not that they searched and missed.
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: null,
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Nobody", undefined, providers);

    assert.equal(result.diagnostics.outcome, "PLAYER_NOT_FOUND");
    assert.equal(result.diagnostics.sourcesAttempted.length, 1);
    assert.ok(result.diagnostics.sourcesAttempted.includes("sofascore"));
  });

  // ── Diagnostics completeness ──────────────────────────────────────────────

  it("sourcesConfigured reflects which injected providers are non-null", async () => {
    const providers: BuilderProviders = {
      rapidApi: makeRapidApiStub(),
      apiTennis: makeApiTennisStub(),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Anyone", undefined, providers);

    assert.ok(result.diagnostics.sourcesConfigured.includes("rapidapi"));
    assert.ok(result.diagnostics.sourcesConfigured.includes("api-tennis"));
    assert.ok(result.diagnostics.sourcesConfigured.includes("sofascore"));
  });

  it("rapidapi not in sourcesConfigured when rapidApi is null", async () => {
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: makeApiTennisStub(),
      sofascore: makeSofascoreStub({ player: null, records: [] }),
    };

    const result = await fetchPlayerMatchesFromProviders("Anyone", undefined, providers);

    assert.ok(!result.diagnostics.sourcesConfigured.includes("rapidapi"));
    assert.ok(result.diagnostics.sourcesConfigured.includes("api-tennis"));
  });

  // ── Sofascore rate-limit branch ───────────────────────────────────────────

  it("records Sofascore rate-limit failure in diagnostics and does not mark it successful", async () => {
    // Sofascore returns an error string that includes "rate-limit" — this triggers
    // the specific branch in attemptSofascore that records the failure and bails out.
    // A regression that makes this branch silently succeed would drop validation evidence
    // with no explanation.
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: null,
      sofascore: makeSofascoreStub({
        player: null,
        records: [],
        error: "rate-limit exceeded",
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("Test Player", undefined, providers);

    assert.ok(
      result.diagnostics.sourcesFailed.includes("sofascore"),
      "sofascore must appear in sourcesFailed on rate-limit error",
    );
    assert.ok(
      !result.diagnostics.sourcesSuccessful.includes("sofascore"),
      "sofascore must NOT appear in sourcesSuccessful on rate-limit error",
    );
    assert.equal(
      result.diagnostics.outcome,
      "SOURCE_UNAVAILABLE",
      "outcome must be SOURCE_UNAVAILABLE when Sofascore rate-limits",
    );
  });

  it("NO_MATCH_HISTORY and providerIdsFound populated when Sofascore finds player but returns 0 records", async () => {
    // Player was identified on Sofascore but has no completed matches stored there.
    // The outcome must be NO_MATCH_HISTORY (not DATA_FOUND) and the provider ID
    // must be recorded so callers know the player was actually recognised.
    const providers: BuilderProviders = {
      rapidApi: null,
      apiTennis: null,
      sofascore: makeSofascoreStub({
        player: { id: "sf-sparse", name: "Sparse Player", tour: "WTA", countryCode: "US", currentRank: 250 },
        records: [],
        error: null,
      }),
    };

    const result = await fetchPlayerMatchesFromProviders("Sparse Player", undefined, providers);

    assert.equal(
      result.diagnostics.outcome,
      "NO_MATCH_HISTORY",
      "outcome must be NO_MATCH_HISTORY when Sofascore finds the player but has 0 records",
    );
    assert.equal(
      result.diagnostics.providerIdsFound["sofascore"],
      "sf-sparse",
      "providerIdsFound must contain the Sofascore player ID",
    );
    assert.ok(
      !result.diagnostics.sourcesSuccessful.includes("sofascore") ||
        result.diagnostics.providerIdsFound["sofascore"] !== undefined,
      "Sofascore player ID must be recorded regardless of records count",
    );
  });
});

// ─── attemptOddsApi tests ─────────────────────────────────────────────────────
//
// These tests use the injectable `_fetchFn` parameter so no real network call is
// ever made. The core invariants proven here:
//   - Backfill mode (asOfDate set)  → always null, _fetchFn never called
//   - Provider returns null          → null (no odds available for this matchup)
//   - Provider returns valid quote   → player1DecimalOdds returned (player ordering)
//   - Provider throws                → null (non-fatal fallback, never throws)
//   - Odds value ≤ 1                 → null (invalid decimal odds rejected)

import { attemptOddsApi } from "./builderProviderFetch.js";
import type { OddsQuote } from "../oddsData/index.js";

function makeQuote(player1DecimalOdds: number, player2DecimalOdds: number): OddsQuote {
  return {
    provider: "Test Provider",
    player1DecimalOdds,
    player2DecimalOdds,
    fetchedAt: new Date().toISOString(),
  };
}

describe("attemptOddsApi — market odds fetch for Parlay Builder", () => {
  it("returns null immediately in backfill mode (asOfDate set) and never calls _fetchFn", async () => {
    let fetchCalled = false;
    const fetchFn = async (): Promise<OddsQuote | null> => {
      fetchCalled = true;
      return makeQuote(1.60, 2.40);
    };

    const result = await attemptOddsApi("Player A", "Player B", null, new Date("2024-06-01"), fetchFn);

    assert.strictEqual(result, null, "must return null in backfill mode");
    assert.strictEqual(fetchCalled, false, "_fetchFn must not be called in backfill mode");
  });

  it("returns null when the provider finds no odds for this matchup", async () => {
    const fetchFn = async (): Promise<OddsQuote | null> => null;

    const result = await attemptOddsApi("Player A", "Player B", null, undefined, fetchFn);

    assert.strictEqual(result, null, "must return null when provider returns null");
  });

  it("returns player1DecimalOdds (the selected player's odds) when provider returns a valid quote", async () => {
    // selectedPlayerName is always passed as player1 to fetchMarketOdds, so quote.player1DecimalOdds
    // belongs to the selected player — no additional name-mapping needed.
    const fetchFn = async (): Promise<OddsQuote | null> => makeQuote(1.75, 2.10);

    const result = await attemptOddsApi("Selected Player", "Opponent", null, undefined, fetchFn);

    assert.strictEqual(result, 1.75, "must return player1DecimalOdds (the selected player's odds)");
  });

  it("returns null (non-throwing) when the provider throws", async () => {
    const fetchFn = async (): Promise<OddsQuote | null> => {
      throw new Error("provider down");
    };

    // Must not throw — market odds are supplemental and provider errors must never surface
    await assert.doesNotReject(() => attemptOddsApi("Player A", "Player B", null, undefined, fetchFn));
    const result = await attemptOddsApi("Player A", "Player B", null, undefined, fetchFn);
    assert.strictEqual(result, null, "must return null on provider error, not rethrow");
  });

  it("returns null when provider returns odds <= 1 (invalid decimal odds)", async () => {
    const fetchFn = async (): Promise<OddsQuote | null> => makeQuote(0.9, 2.0);

    const result = await attemptOddsApi("Player A", "Player B", null, undefined, fetchFn);

    assert.strictEqual(result, null, "must reject decimal odds <= 1 as invalid");
  });

  it("passes selectedPlayerName as player1 to _fetchFn (player ordering check)", async () => {
    let capturedP1: string | undefined;
    let capturedP2: string | undefined;
    const fetchFn = async (p1: string, p2: string): Promise<OddsQuote | null> => {
      capturedP1 = p1;
      capturedP2 = p2;
      return makeQuote(1.85, 1.95);
    };

    await attemptOddsApi("Jannik Sinner", "Carlos Alcaraz", null, undefined, fetchFn);

    assert.strictEqual(capturedP1, "Jannik Sinner", "selectedPlayerName must be passed as player1 to fetchFn");
    assert.strictEqual(capturedP2, "Carlos Alcaraz", "opponentName must be passed as player2 to fetchFn");
  });
});
