import { test } from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable, matchFeatureSnapshotsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { buildEloHistoryIndex, resolveOpponentStrength, resolveOpponentStrengthFromIndex, type EloHistoryIndex } from "./opponentStrength";
import { buildPlayerIdentityIndex, invalidatePlayerIdentityCacheForTests, type PlayerIdentityIndex } from "../tennisData/playerIdentity";
import type { MatchRecord } from "../tennisData/types";

/** Every `PlayerIdentityIndex` fixture below deliberately has no aliases beyond what's spelled
 * out in `canonicalIdById`/`canonicalIdByName` -- `getAliasIds` falls back to `[canonicalId]`
 * when a canonical id has no entry here, which is exactly what these small, hand-built fixtures
 * need. */
function emptyAliasMap(): Map<string, string[]> {
  return new Map();
}

function baseMatch(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: "m1",
    date: "2026-06-01",
    tournamentName: "Test Open",
    tournamentLevel: "ATP250",
    round: null,
    matchFormat: "BestOf3",
    surface: "Hard",
    indoor: null,
    opponentId: "raw_opponent_id",
    opponentName: "Jose Garcia",
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

test("resolveOpponentStrengthFromIndex resolves an opponent only identifiable via normalized-name cross-reference, not an exact id match", () => {
  // The opponent's real Elo history is indexed under their CANONICAL id ("canonical_1") -- a
  // different string than this match's own `opponentId` ("raw_opponent_id"), simulating a
  // provider that issued this opponent a second player_key. Nothing in the index is keyed by
  // "raw_opponent_id" itself, so an exact-id-only lookup (no `identity` argument) must fail.
  const index: EloHistoryIndex = new Map([["canonical_1", [{ t: new Date("2026-01-01").getTime(), elo: 1600 }]]]);
  const match = baseMatch({ opponentId: "raw_opponent_id", opponentName: "José García" });

  const withoutIdentity = resolveOpponentStrengthFromIndex([match], index);
  assert.equal(withoutIdentity.coverage, 0, "sanity check: an exact-id-only lookup can't see this opponent's history");

  // The identity index only knows "raw_opponent_id" through its NORMALIZED name (accent-folded,
  // lowercased) -- a real cross-reference signal, not an exact id match -- resolving it to the
  // same canonical id the Elo history above is keyed by.
  const identity: PlayerIdentityIndex = {
    canonicalIdByName: new Map([["jose garcia", "canonical_1"]]),
    canonicalIdById: new Map(),
    aliasIdsByCanonicalId: emptyAliasMap(),
  };

  const withIdentity = resolveOpponentStrengthFromIndex([match], index, identity);
  assert.equal(withIdentity.coverage, 1, "opponent should resolve via normalized-name cross-reference");
  assert.equal(withIdentity.lookup.get(match.id), 1600);
});

test("resolveOpponentStrengthFromIndex resolves an opponent aliased by id (historical-match cross-reference), even with a different reported name", () => {
  const index: EloHistoryIndex = new Map([["canonical_2", [{ t: new Date("2026-01-01").getTime(), elo: 1550 }]]]);
  // This match reports the opponent under an alias id the provider previously issued them --
  // the identity index (built from `historical_matches`) already knows this alias maps to the
  // canonical id, independent of whatever name string this particular match happens to report.
  const match = baseMatch({ opponentId: "alias_id_7", opponentName: "Some Alias Spelling" });

  const identity: PlayerIdentityIndex = {
    canonicalIdByName: new Map(),
    canonicalIdById: new Map([["alias_id_7", "canonical_2"]]),
    aliasIdsByCanonicalId: emptyAliasMap(),
  };

  const result = resolveOpponentStrengthFromIndex([match], index, identity);
  assert.equal(result.coverage, 1);
  assert.equal(result.lookup.get(match.id), 1550);
});

test("a genuinely unresolvable opponent (no exact id, no name match, no alias) is left unresolved rather than defaulting to a flat neutral value", () => {
  const index: EloHistoryIndex = new Map([["someone_else", [{ t: new Date("2026-01-01").getTime(), elo: 1600 }]]]);
  const match = baseMatch({ opponentId: "truly_unknown_id", opponentName: "Truly Unknown Player" });

  const identity: PlayerIdentityIndex = {
    canonicalIdByName: new Map([["a completely different name", "someone_else"]]),
    canonicalIdById: new Map(),
    aliasIdsByCanonicalId: emptyAliasMap(),
  };

  const result = resolveOpponentStrengthFromIndex([match], index, identity);
  // Honest degradation: this opponent stays unresolved (no lookup entry at all) so the caller
  // (surfaceElo.ts's replayElo) applies #76's real level-aware baseline for THIS match's own
  // tournament level -- never a fabricated/neutral Elo value invented here.
  assert.equal(result.coverage, 0);
  assert.equal(result.lookup.has(match.id), false);
});

test("resolveOpponentStrengthFromIndex still resolves the common, non-aliased case (id present directly in the index) with or without an identity index", () => {
  const index: EloHistoryIndex = new Map([["plain_id", [{ t: new Date("2026-01-01").getTime(), elo: 1500 }]]]);
  const match = baseMatch({ opponentId: "plain_id", opponentName: "Plain Player" });

  const withoutIdentity = resolveOpponentStrengthFromIndex([match], index);
  assert.equal(withoutIdentity.lookup.get(match.id), 1500);

  const identity: PlayerIdentityIndex = { canonicalIdByName: new Map(), canonicalIdById: new Map(), aliasIdsByCanonicalId: emptyAliasMap() };
  const withIdentity = resolveOpponentStrengthFromIndex([match], index, identity);
  assert.equal(withIdentity.lookup.get(match.id), 1500);
});

test("buildEloHistoryIndex uses the full chronological corpus and shared canonical/raw/alias timelines", async (t) => {
  let identity: PlayerIdentityIndex;
  try {
    identity = await buildPlayerIdentityIndex();
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND" || code === "ECONNREFUSED") {
      t.skip(`DB unavailable for full-corpus Elo index test (${code})`);
      return;
    }
    throw err;
  }

  const index = await buildEloHistoryIndex(identity);
  assert.ok(index.size > 0, "full historical corpus should produce an Elo lookup");
  for (const [canonicalId, aliases] of identity.aliasIdsByCanonicalId) {
    const timeline = index.get(canonicalId);
    if (!timeline) continue;
    for (const aliasId of aliases) assert.strictEqual(index.get(aliasId), timeline);
    for (let i = 1; i < timeline.length; i++) assert.ok(timeline[i - 1].t <= timeline[i].t);
  }
});

// Integration test against the real DB: proves `resolveOpponentStrength` (the LIVE, per-fixture
// caller -- not the whole-corpus-preloaded `buildEloHistoryIndex` path) actually merges Elo
// history recorded under an opponent's OLD alias id, not just their current canonical id. A
// regression here (canonicalizing the query key without also querying every alias id) would
// silently miss real, already-imported Elo snapshots for any player who was ever issued more than
// one provider id -- exactly the bug this task's code review caught before shipping.
test("resolveOpponentStrength (live path) merges Elo history recorded under an opponent's historical alias id, not just their current canonical id", async (t) => {
  const PROVIDER = "opponent-strength-alias-test";
  const CANONICAL_OPPONENT_ID = "ost-canonical-opp-001";
  const ALIAS_OPPONENT_ID = "ost-alias-opp-002";
  const OPPONENT_NAME = "Zzqtest Aliasplayer";

  // One real historical_matches row under each of the opponent's two ids (same normalized name)
  // is enough for `buildPlayerIdentityIndex` to treat ALIAS_OPPONENT_ID as an alias of
  // CANONICAL_OPPONENT_ID (whichever was seen more recently becomes canonical).
  const oldRow = {
    externalId: `${PROVIDER}-old`,
    provider: PROVIDER,
    tour: "Challenger",
    tournamentName: "Alias Test Series (old id)",
    tournamentLevel: null,
    surface: "Hard" as const,
    round: null,
    matchFormat: "BestOf3" as const,
    player1Id: ALIAS_OPPONENT_ID,
    player1Name: OPPONENT_NAME,
    player2Id: "ost-filler-opp-1",
    player2Name: "Zzqtest Filler One",
    winnerId: ALIAS_OPPONENT_ID,
    score: "6-4 6-4",
    retired: false,
    walkover: false,
    cancelled: false,
    scheduledStartAt: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)),
    cutoffMinutes: 30,
    cutoffAt: new Date(Date.UTC(2024, 0, 1, 11, 30, 0)),
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 4 }],
    rawSource: {},
  };
  const newRow = {
    ...oldRow,
    externalId: `${PROVIDER}-new`,
    tournamentName: "Alias Test Series (new/canonical id)",
    player1Id: CANONICAL_OPPONENT_ID,
    winnerId: CANONICAL_OPPONENT_ID,
    scheduledStartAt: new Date(Date.UTC(2025, 0, 1, 12, 0, 0)), // more recent -- this id becomes canonical
    cutoffAt: new Date(Date.UTC(2025, 0, 1, 11, 30, 0)),
  };

  let insertedMatches: Array<{ id: number }> = [];
  let snapshot: { id: number } | undefined;
  try {
    insertedMatches = await db.insert(historicalMatchesTable).values([oldRow, newRow]).returning({ id: historicalMatchesTable.id });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND" || code === "ECONNREFUSED") {
      t.skip(`DB unavailable for integration test (${code})`);
      return;
    }
    throw err;
  }
  // Real eloOverall snapshot stored under the OLD alias id, timestamped well before the fixture
  // match we'll resolve below -- this is exactly the kind of row a canonical-id-only query would
  // silently miss.
  try {
    [snapshot] = await db
      .insert(matchFeatureSnapshotsTable)
      .values({
        matchId: insertedMatches[0].id,
        playerId: ALIAS_OPPONENT_ID,
        featureName: "eloOverall",
        featureValue: 1610,
        sourceTimestamp: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)),
        matchCutoffAt: oldRow.cutoffAt,
        existedBeforeCutoff: true,
      })
      .returning({ id: matchFeatureSnapshotsTable.id });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND" || code === "ECONNREFUSED") {
      t.skip(`DB unavailable for integration test (${code})`);
      return;
    }
    throw err;
  }

  t.after(async () => {
    if (snapshot) {
      await db.delete(matchFeatureSnapshotsTable).where(inArray(matchFeatureSnapshotsTable.id, [snapshot.id]));
    }
    if (insertedMatches.length > 0) {
      await db.delete(historicalMatchesTable).where(
        inArray(
          historicalMatchesTable.id,
          insertedMatches.map((m) => m.id),
        ),
      );
    }
    invalidatePlayerIdentityCacheForTests();
  });

  invalidatePlayerIdentityCacheForTests();

  // The live fixture being scored reports the opponent under their CURRENT (canonical) id --
  // exactly the real-world case where a provider's id for a player changed after their Elo
  // history was already recorded under the old one.
  const fixtureMatch = baseMatch({
    id: "live-fixture-1",
    opponentId: CANONICAL_OPPONENT_ID,
    opponentName: OPPONENT_NAME,
    date: "2026-06-01",
  });

  const result = await resolveOpponentStrength([fixtureMatch]);
  assert.equal(result.coverage, 1, "expected the opponent's alias-id-recorded Elo history to resolve for the live per-fixture path");
  assert.equal(result.lookup.get(fixtureMatch.id), 1610);
});
