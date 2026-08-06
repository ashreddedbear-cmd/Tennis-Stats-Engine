import { db, historicalMatchesTable, matchFeatureSnapshotsTable } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { MatchRecord } from "../tennisData/types";
import { buildPlayerIdentityIndex, canonicalizePlayerId, getAliasIds, getCachedPlayerIdentityIndex, type PlayerIdentityIndex } from "../tennisData/playerIdentity";
import { logger } from "../../lib/logger";
import { eloFallbackTracker } from "./fallbackTracking";

/**
 * Opponent-strength lookup for a set of live match records, keyed by `MatchRecord.id`. Value is
 * the opponent's real, persisted `eloOverall` rating (from Phase 3's leak-proof historical
 * backfill store) at the closest point in time strictly before the match's own date. This is
 * real data derived only from actual match results already imported into the historical store --
 * never fabricated -- but it is genuinely incomplete: an opponent who has never appeared in a
 * backfilled date range has no entry, and callers must treat a missing entry as "not available",
 * not as "average opponent".
 */
export type OpponentEloLookup = Map<string, number>;

export interface OpponentStrengthResolution {
  lookup: OpponentEloLookup;
  /** Share (0-1) of the input matches for which an opponent Elo estimate was found. */
  coverage: number;
}

const EMPTY: OpponentStrengthResolution = { lookup: new Map(), coverage: 0 };

/** Sorted-ascending elo history points for one player, keyed by player id. */
export type EloHistoryIndex = Map<string, Array<{ t: number; elo: number }>>;

/**
 * Resolves opponent-strength for every match in `matches` purely from an already-loaded
 * `EloHistoryIndex` -- no I/O. Shared by both the live per-fixture resolver below (which loads
 * just the opponents it needs from the DB) and the walk-forward backtest path (which preloads
 * the WHOLE `eloOverall` history once per run via `buildEloHistoryIndex`, then reuses it across
 * every match scored -- avoiding a fresh DB round-trip per match).
 *
 * Task #77: when `identity` is supplied, `match.opponentId` is canonicalized (normalized-name and
 * historical-match cross-reference resolution -- see `playerIdentity.ts`) before the index lookup,
 * so an opponent who is only identifiable through a name variant/alias -- not an exact id match --
 * still resolves to their real Elo history instead of being silently treated as "unresolved" and
 * handed to #76's fallback baseline more often than genuinely necessary. `index` itself must have
 * been built with the SAME identity index (see `buildEloHistoryIndex`) for this to actually find
 * anything for an aliased id -- passing `identity` here without also passing it to
 * `buildEloHistoryIndex` would canonicalize the lookup key but not the index's own keys.
 */
export function resolveOpponentStrengthFromIndex(matches: MatchRecord[], index: EloHistoryIndex, identity?: PlayerIdentityIndex): OpponentStrengthResolution {
  if (matches.length === 0) return EMPTY;

  const lookup: OpponentEloLookup = new Map();
  let resolved = 0;

  for (const match of matches) {
    const opponentKey = identity ? canonicalizePlayerId(identity, match.opponentId, match.opponentName) : match.opponentId;
    const history = index.get(opponentKey);
    if (!history || history.length === 0) continue;
    const matchTime = new Date(match.date).getTime();
    if (Number.isNaN(matchTime)) continue;

    // Latest snapshot strictly before this match's own date -- never a same-day-or-later one,
    // which could leak the outcome of this very match (or a same-day later one) into its own
    // opponent-strength estimate.
    let best: number | null = null;
    for (const point of history) {
      if (point.t < matchTime) best = point.elo;
      else break;
    }
    if (best === null) continue;

    lookup.set(match.id, best);
    resolved += 1;
  }

  return { lookup, coverage: matches.length > 0 ? resolved / matches.length : 0 };
}

/**
 * Preloads and indexes EVERY player's `eloOverall` feature history in a single query -- meant to
 * be called ONCE per walk-forward run (the corpus is small enough, tens of thousands of rows, to
 * hold entirely in memory) and then reused for every match scored via
 * `resolveOpponentStrengthFromIndex`, instead of re-querying the DB per match.
 *
 * Task #77: when `identity` is supplied, each row's `playerId` is canonicalized before grouping,
 * so a player whose real Elo history is fragmented across multiple provider ids/name variants has
 * every one of those fragments' history points merged into ONE continuous, correctly-sorted
 * timeline under their canonical id -- computed once here and reused for the rest of the run,
 * never re-replayed per opponent lookup.
 *
 * The index always loads the complete historical corpus. Callers may provide a run-scoped identity
 * index; when omitted, one is built from the complete historical match store before indexing.
 */
export async function buildEloHistoryIndex(identity?: PlayerIdentityIndex): Promise<EloHistoryIndex> {
  const identityIndex = identity ?? await buildPlayerIdentityIndex();
  const matches = await db
    .select({
      id: historicalMatchesTable.id,
      player1Id: historicalMatchesTable.player1Id,
      player1Name: historicalMatchesTable.player1Name,
      player2Id: historicalMatchesTable.player2Id,
      player2Name: historicalMatchesTable.player2Name,
      winnerId: historicalMatchesTable.winnerId,
      scheduledStartAt: historicalMatchesTable.scheduledStartAt,
    })
    .from(historicalMatchesTable)
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  const rawToCanonical = new Map<string, string>();
  const rawIds = new Set<string>();
  let unresolvedIds = 0;
  let aliasCollisions = 0;
  const registerRawId = (rawId: string, canonicalId: string): void => {
    rawIds.add(rawId);
    const previous = rawToCanonical.get(rawId);
    if (previous && previous !== canonicalId) aliasCollisions += 1;
    rawToCanonical.set(rawId, canonicalId);
    if (previous === undefined && previous !== canonicalId && !identityIndex.canonicalIdById.has(rawId) && rawId === canonicalId) {
      unresolvedIds += 1;
    }
  };
  for (const match of matches) {
    registerRawId(match.player1Id, canonicalizePlayerId(identityIndex, match.player1Id, match.player1Name));
    registerRawId(match.player2Id, canonicalizePlayerId(identityIndex, match.player2Id, match.player2Name));
    if (match.winnerId) registerRawId(match.winnerId, canonicalizePlayerId(identityIndex, match.winnerId));
  }

  const rows = await db
    .select({
      playerId: matchFeatureSnapshotsTable.playerId,
      featureValue: matchFeatureSnapshotsTable.featureValue,
      sourceTimestamp: matchFeatureSnapshotsTable.sourceTimestamp,
    })
    .from(matchFeatureSnapshotsTable)
    .where(eq(matchFeatureSnapshotsTable.featureName, "eloOverall"));

  const index: EloHistoryIndex = new Map();
  for (const row of rows) {
    const key = canonicalizePlayerId(identityIndex, row.playerId, null);
    const list = index.get(key) ?? [];
    list.push({ t: row.sourceTimestamp.getTime(), elo: row.featureValue });
    index.set(key, list);
  }

  // Ensure every participant observed in the complete historical corpus has an explicit
  // canonical/raw lookup entry, even when no snapshot row exists for that participant yet.
  for (const canonicalId of rawToCanonical.values()) {
    if (!index.has(canonicalId)) index.set(canonicalId, []);
  }
  for (const [canonicalId, aliases] of identityIndex.aliasIdsByCanonicalId) {
    const history = index.get(canonicalId) ?? [];
    index.set(canonicalId, history);
    for (const aliasId of aliases) index.set(aliasId, history);
  }
  for (const [rawId, canonicalId] of rawToCanonical) {
    const history = index.get(canonicalId) ?? [];
    index.set(canonicalId, history);
    index.set(rawId, history);
  }
  for (const list of new Set(index.values())) list.sort((a, b) => a.t - b.t);
  const canonicalPlayers = new Set<string>();
  for (const [key, timeline] of index) {
    if (key === canonicalizePlayerId(identityIndex, key)) canonicalPlayers.add(key);
    if (timeline.length > 0) canonicalPlayers.add(canonicalizePlayerId(identityIndex, key));
  }
  const aliasesMapped = new Set<string>();
  for (const [canonicalId, aliases] of identityIndex.aliasIdsByCanonicalId) {
    canonicalPlayers.add(canonicalId);
    for (const alias of aliases) if (alias !== canonicalId) aliasesMapped.add(alias);
  }
  logger.info({
    historicalMatchesProcessed: matches.length,
    eloSnapshotsProcessed: rows.length,
    canonicalPlayers: canonicalPlayers.size,
    rawIdsMapped: rawIds.size,
    aliasesMapped: aliasesMapped.size,
    unresolvedIds,
    aliasCollisions,
    timelinesCreated: new Set(index.values()).size,
    baselineFallbackCount: eloFallbackTracker.getStats().fallbackCount,
  }, "Elo history index built with canonical player identities");
  return index;
}

/**
 * Resolves opponent-strength estimates for every match in `matches`. Looks up each unique
 * opponent's `eloOverall` feature history (one row per match they were part of, timestamped at
 * that match's date) and, for each input match, picks the latest opponent snapshot strictly
 * before that match's date -- i.e. what was actually knowable about the opponent's strength at
 * that point in time, never a snapshot from after the fact. Meant for live/paper-trade callers
 * scoring a handful of fixtures at a time -- see `buildEloHistoryIndex` for the walk-forward,
 * whole-corpus-preloaded equivalent.
 *
 * Task #77: canonicalizes each match's opponent id/name through the (cached, whole-corpus)
 * player-identity index BEFORE deciding which ids to query, so an opponent who is only
 * identifiable through a name variant or a historical-match cross-reference -- not an exact id
 * match -- still has their real Elo history queried and resolved, instead of silently missing and
 * falling through to #76's fallback baseline.
 */
export async function resolveOpponentStrength(matches: MatchRecord[]): Promise<OpponentStrengthResolution> {
  if (matches.length === 0) return EMPTY;

  const identity = await getCachedPlayerIdentityIndex();
  const canonicalOpponentIds = Array.from(new Set(matches.map((m) => canonicalizePlayerId(identity, m.opponentId, m.opponentName))));
  if (canonicalOpponentIds.length === 0) return EMPTY;

  // `match_feature_snapshots` is keyed by the RAW provider id, which may be an alias of (not
  // equal to) an opponent's canonical id -- querying by canonical id alone would silently miss
  // every row stored under an older/alternate id for the same real person. Query the WHOLE alias
  // group for each canonical opponent instead, then canonicalize the results below so they merge
  // back onto one history under the canonical key, matching what `buildEloHistoryIndex` already
  // does for the whole-corpus/backtest path.
  const queryIds = Array.from(new Set(canonicalOpponentIds.flatMap((id) => getAliasIds(identity, id))));

  const rows = await db
    .select({
      playerId: matchFeatureSnapshotsTable.playerId,
      featureValue: matchFeatureSnapshotsTable.featureValue,
      sourceTimestamp: matchFeatureSnapshotsTable.sourceTimestamp,
    })
    .from(matchFeatureSnapshotsTable)
    .where(and(inArray(matchFeatureSnapshotsTable.playerId, queryIds), eq(matchFeatureSnapshotsTable.featureName, "eloOverall")));

  const index: EloHistoryIndex = new Map();
  for (const row of rows) {
    const key = canonicalizePlayerId(identity, row.playerId, null);
    const list = index.get(key) ?? [];
    list.push({ t: row.sourceTimestamp.getTime(), elo: row.featureValue });
    index.set(key, list);
  }
  for (const list of index.values()) list.sort((a, b) => a.t - b.t);

  return resolveOpponentStrengthFromIndex(matches, index, identity);
}
