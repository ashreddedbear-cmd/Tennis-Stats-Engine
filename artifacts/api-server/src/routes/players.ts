import { Router, type IRouter } from "express";
import {
  SearchPlayersQueryParams,
  SearchPlayersResponse,
  GetPlayerParams,
  GetPlayerResponse,
  GetPlayerMatchesParams,
  GetPlayerMatchesResponse,
} from "@workspace/api-zod";
import { db, playerStatsTable, historicalMatchesTable } from "@workspace/db";
import { eq, notInArray, sql } from "drizzle-orm";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { resolvePlayerProfile, searchKnownPlayers, canonicalizePlayerId, getCachedPlayerIdentityIndex } from "../services/tennisData/playerIdentity";
import { PLAYER_STATS_FRESH_MS, refreshPlayerStats } from "../services/playerStats/compute";
import pino from "pino";

const logger = pino({ level: "info" });

const router: IRouter = Router();

router.get("/players/search", async (req, res): Promise<void> => {
  const parsed = SearchPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const players = await searchKnownPlayers(getTennisDataProvider(), parsed.data.query);
    res.json(SearchPlayersResponse.parse(players));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

router.get("/players/:playerId", async (req, res): Promise<void> => {
  const params = GetPlayerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const player = await resolvePlayerProfile(getTennisDataProvider(), params.data.playerId);
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    res.json(GetPlayerResponse.parse(player));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

/**
 * GET /players/:playerId/stats
 *
 * Returns the cached aggregate performance stats for a player from the `player_stats` table.
 * HTTP 404 when no stats row exists yet (not yet computed by the backfill pipeline).
 *
 * Callers may check `computedAt` to determine whether the cache is fresh (< 48 h) or stale.
 * Stale data is still returned — it reflects the last full replay; callers decide whether to
 * act on it or treat it as background context.
 */
router.get("/players/:playerId/stats", async (req, res): Promise<void> => {
  const params = GetPlayerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Resolve the raw player ID to its canonical form so we look up the right cache row
  // even when the caller passes an alias ID.
  const index = await getCachedPlayerIdentityIndex();
  const canonicalId = canonicalizePlayerId(index, params.data.playerId);

  const rows = await db
    .select()
    .from(playerStatsTable)
    .where(eq(playerStatsTable.playerId, canonicalId))
    .limit(1);

  if (rows.length === 0) {
    res.status(404).json({ error: "Stats not yet computed for this player — run the backfill pipeline first." });
    return;
  }

  const row = rows[0]!;
  const isStale = Date.now() - row.computedAt.getTime() > PLAYER_STATS_FRESH_MS;
  if (isStale) {
    res.setHeader("X-Stats-Stale", "true");
  }
  res.json(row);
});

/**
 * POST /players/stats/seed
 *
 * Task #38: seeds the player_stats cache from existing historical match data for every player
 * that doesn't already have a stats row. Runs in the background so the HTTP response is
 * immediate. Useful after the first historical backfill — newly backfilled players won't have
 * stats until this fires or they appear in a graded Ledger prediction.
 *
 * Returns { queued: number } — the number of distinct canonical player IDs dispatched.
 * Re-triggering while a previous seed is still running is safe (idempotent upserts).
 */
router.post("/players/stats/seed", async (req, res): Promise<void> => {
  // Collect all distinct player IDs from historical_matches that have no stats row yet.
  const allMatchPlayerIds = await db
    .selectDistinct({ id: historicalMatchesTable.player1Id })
    .from(historicalMatchesTable)
    .union(
      db.selectDistinct({ id: historicalMatchesTable.player2Id }).from(historicalMatchesTable),
    );

  const seededIds = (
    await db.select({ id: playerStatsTable.playerId }).from(playerStatsTable)
  ).map((r) => r.id);

  const seededSet = new Set(seededIds);
  const unseeded = allMatchPlayerIds.map((r) => r.id).filter((id) => !seededSet.has(id));

  const queued = unseeded.length;

  if (queued === 0) {
    res.json({ queued: 0, message: "All players in historical_matches already have stats rows." });
    return;
  }

  logger.info({ queued }, "Task #38: seeding player_stats from historical match data");

  // Fire-and-forget — caller gets the count immediately.
  setImmediate(() => {
    refreshPlayerStats(unseeded).catch((err) => {
      logger.error({ err }, "Task #38: player stats seed job failed");
    });
  });

  res.json({ queued, message: `Seeding stats for ${queued} players in the background. Check GET /players/:id/stats once complete.` });
});

router.get("/players/:playerId/matches", async (req, res): Promise<void> => {
  const params = GetPlayerMatchesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const matches = await getTennisDataProvider().getPlayerMatches(params.data.playerId);
    res.json(GetPlayerMatchesResponse.parse(matches));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

export default router;
