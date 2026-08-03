/**
 * DB-backed match history fallback for the prediction engine.
 *
 * Queries historical_matches for a player's completed matches when all live providers
 * (MatchStat, API-Tennis, BSD Tennis, Sofascore) return sparse or no history. This is the
 * final safety net before the engine falls to global Elo baselines and produces 50/50.
 *
 * Player IDs in historical_matches are api-tennis.com IDs — the same namespace the
 * prediction engine uses — so lookups can be done directly by playerId.
 */

import { db, historicalMatchesTable } from "@workspace/db";
import { or, eq, and, isNotNull, desc, notLike, inArray } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import type { MatchFormat, MatchRecord, Surface, TournamentLevel } from "./types.js";

const MAX_HISTORY_ROWS = 200;

/**
 * Tours that represent singles play in api-tennis's `tour` column.
 * Mixed Doubles, Teams Men/Mix/Women are excluded so doubles rows never
 * contaminate the player's singles match history.
 */
const SINGLES_TOURS = ["ATP", "WTA", "Challenger", "ITF", "Exhibition", "Junior"] as const;

interface GameMarginRow {
  player1Games: number;
  player2Games: number;
}

/**
 * Fetch a player's completed match history from the historical_matches DB table.
 *
 * Accepts either a single player ID or an array of IDs (alias group). Pass multiple IDs when
 * the player identity index has bridged a sackmann-* ID to a live provider ID — both IDs need
 * to be queried so the full history across both data eras is returned.
 *
 * Returns empty when the table has no records for any of the supplied IDs (non-throwing).
 */
export async function getPlayerMatchesFromDb(playerIdOrIds: string | string[]): Promise<MatchRecord[]> {
  const playerIds = Array.isArray(playerIdOrIds) ? playerIdOrIds : [playerIdOrIds];
  // Single canonical ID to use for result perspective (isP1 / opponentId logic).
  // When multiple IDs are supplied, the first entry is the canonical live ID.
  const primaryId = playerIds[0]!;
  try {
    const rows = await db
      .select()
      .from(historicalMatchesTable)
      .where(
        and(
          or(
            inArray(historicalMatchesTable.player1Id, playerIds),
            inArray(historicalMatchesTable.player2Id, playerIds),
          ),
          isNotNull(historicalMatchesTable.winnerId),
          eq(historicalMatchesTable.cancelled, false),
          // Exclude doubles/team events — their player IDs share the same api-tennis
          // namespace as singles players, so without this filter a doubles-team row
          // can silently contaminate a singles player's Elo history.
          inArray(historicalMatchesTable.tour, [...SINGLES_TOURS]),
          // Belt-and-suspenders: doubles team names contain "/" (e.g. "Nadal/ Verdasco")
          notLike(historicalMatchesTable.player1Name, "%/%"),
          notLike(historicalMatchesTable.player2Name, "%/%"),
        ),
      )
      .orderBy(desc(historicalMatchesTable.scheduledStartAt))
      .limit(MAX_HISTORY_ROWS);

    const records: MatchRecord[] = rows.map((row) => {
      // When alias IDs are supplied (Sackmann bridge), the row's player1Id/player2Id may be any
      // ID in the alias group. Use set-membership to determine perspective, then normalise the
      // opponentId to the primaryId's namespace so downstream Elo/surface callers are consistent.
      const isP1 = playerIds.includes(row.player1Id);
      const opponentId = isP1 ? row.player2Id : row.player1Id;
      const opponentName = isP1 ? row.player2Name : row.player1Name;
      const opponentRank = isP1 ? (row.player2Rank ?? null) : (row.player1Rank ?? null);

      const rawMargins = row.gameMarginsPlayer1 as GameMarginRow[] | null;
      const setGameMargins = (rawMargins ?? []).map((m) => ({
        playerGames: isP1 ? m.player1Games : m.player2Games,
        opponentGames: isP1 ? m.player2Games : m.player1Games,
      }));

      return {
        id: `db-${row.id}`,
        date: row.scheduledStartAt.toISOString().slice(0, 10),
        tournamentName: row.tournamentName ?? null,
        tournamentLevel: (row.tournamentLevel as TournamentLevel | null) ?? null,
        round: row.round ?? null,
        matchFormat: (row.matchFormat as MatchFormat | null) ?? null,
        surface: (row.surface as Surface | null) ?? null,
        indoor: row.indoor ?? null,
        opponentId,
        opponentName,
        opponentRank,
        result: playerIds.includes(row.winnerId ?? "") ? "W" : "L",
        score: row.score ?? null,
        retired: row.retired,
        walkover: row.walkover,
        stats: null,
        opponentStats: null,
        setGameMargins,
      } satisfies MatchRecord;
    });

    logger.debug(
      { primaryId, aliasCount: playerIds.length, dbRecords: records.length },
      "dbHistoryFallback: loaded match history from historical_matches",
    );
    return records;
  } catch (err) {
    logger.warn({ primaryId, aliasCount: playerIds.length, err }, "dbHistoryFallback: query failed (non-fatal)");
    return [];
  }
}
