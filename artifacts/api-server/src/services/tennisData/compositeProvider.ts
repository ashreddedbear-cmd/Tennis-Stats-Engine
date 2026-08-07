/**
 * Composite (primary + fallback) TennisDataProvider.
 *
 * Tries the primary provider (RapidAPI/tennis-api-atp-wta-itf) for every request. When the primary
 * throws ProviderUnavailableError — which covers rate limits, network errors, subscription
 * mismatches, and any HTTP error — the fallback (API-Tennis) is tried instead.
 *
 * This keeps the rest of the app completely unaware of which physical provider served the
 * data; every caller just calls `getTennisDataProvider()` and gets the best available source.
 */
import { logger } from "../../lib/logger";
import type {
  Fixture,
  HeadToHeadRecord,
  HistoricalFixture,
  LiveScore,
  MatchRecord,
  PlayerProfile,
  PlayerSummary,
  ProviderStatusInfo,
  Surface,
  TennisDataProvider,
  TournamentLevel,
} from "./types";
import { ProviderUnavailableError } from "./types";
import { inferSurfaceAndLevel } from "./surfaceMap.js";
import { fetchFromSofascore } from "../parlayBuilder/sofascoreProvider.js";
import { fetchFromBsdTennis } from "./bsdTennisProvider.js";
import { getPlayerMatchesFromDb } from "./dbHistoryFallback.js";
import { getCachedPlayerIdentityIndex, getAliasIds } from "./playerIdentity.js";

// ─── Sofascore tertiary fixture fallback ──────────────────────────────────────
// Used when both RapidAPI (primary) and API-Tennis (fallback) are unavailable.
// Sofascore's public API requires no authentication and covers all tour levels.

const SF_BASE = "https://api.sofascore.com/api/v1";
const SF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.sofascore.com",
  Referer: "https://www.sofascore.com/",
};
const SF_TIMEOUT_MS = 10_000;

function sfFixtureFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SF_TIMEOUT_MS);
  return fetch(url, { headers: SF_HEADERS, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function mapSfSurface(g: string | undefined | null): Surface | null {
  if (!g) return null;
  const m: Record<string, Surface> = {
    HARD: "Hard", CLAY: "Clay", GRASS: "Grass",
    ARTIFICIAL_GRASS: "Grass", INDOOR_HARD: "IndoorHard",
    INDOOR_CLAY: "Clay", CARPET: "IndoorHard",
  };
  return m[g.toUpperCase()] ?? null;
}

function mapSfLevel(event: { tournament?: { name?: string; category?: { name?: string }; uniqueTournament?: { name?: string; category?: { name?: string } } } }): TournamentLevel | null {
  const n = (
    event.tournament?.uniqueTournament?.category?.name ??
    event.tournament?.category?.name ??
    event.tournament?.name ?? ""
  ).toLowerCase();
  if (n.includes("grand slam")) return "GrandSlam";
  if (n.includes("masters 1000") || n.includes("masters series")) return "Masters1000";
  if (n.includes("wta 1000") || n.includes("premier mandatory") || n.includes("premier 5")) return "WTA1000";
  if (n.includes("atp 500")) return "ATP500";
  if (n.includes("wta 500") || (n.includes("premier") && !n.includes("mandatory") && !n.includes(" 5"))) return "WTA500";
  if (n.includes("atp 250")) return "ATP250";
  if (n.includes("wta 250")) return "WTA250";
  if (n.includes("challenger")) return "Challenger";
  if (n.includes("125")) return "Challenger";
  if (n.includes("itf")) return "ITF";
  return "Other";
}

/**
 * Fetch upcoming singles tennis fixtures from Sofascore for a given date.
 * Returns an empty array (never throws) so it can always be used as a safe fallback.
 */
async function fetchSofascoreFixturesForDate(date: string): Promise<Fixture[]> {
  try {
    const res = await sfFixtureFetch(`${SF_BASE}/sport/tennis/scheduled-events/${date}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: Array<{
      id: number;
      tournament?: { name?: string; category?: { name?: string }; uniqueTournament?: { name?: string; category?: { name?: string } } };
      homeTeam?: { id: number; name: string };
      awayTeam?: { id: number; name: string };
      startTimestamp?: number;
      status?: { type?: string };
      groundType?: string;
      roundInfo?: { name?: string };
    }> };
    const events = data.events ?? [];
    const fixtures: Fixture[] = [];
    for (const ev of events) {
      const p1 = ev.homeTeam;
      const p2 = ev.awayTeam;
      if (!p1 || !p2) continue;
      // Skip doubles: player names containing "/" or "&"
      if (p1.name.includes("/") || p1.name.includes("&") || p2.name.includes("/") || p2.name.includes("&")) continue;
      // Skip already-finished matches
      const statusType = ev.status?.type ?? "";
      if (statusType === "finished" || statusType === "canceled" || statusType === "postponed") continue;

      const scheduledStart = ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : null;
      const isLive = statusType === "inprogress";

      fixtures.push({
        id: `sf-fixture-${ev.id}`,
        date,
        scheduledStart,
        timeConfirmed: !!scheduledStart,
        isLive,
        tournamentName: ev.tournament?.name ?? null,
        tournamentLevel: mapSfLevel(ev),
        round: ev.roundInfo?.name ?? null,
        surface: mapSfSurface(ev.groundType),
        indoor: null,
        matchFormat: null,
        player1Id: `sf-player-${p1.id}`,
        player1Name: p1.name,
        player2Id: `sf-player-${p2.id}`,
        player2Name: p2.name,
      });
    }
    return fixtures;
  } catch {
    return [];
  }
}

async function fetchSofascoreFixturesRange(dateStart: string, dateStop: string): Promise<Fixture[]> {
  // Enumerate dates in the range and fetch each day. Range is typically 1-3 days.
  const dates: string[] = [];
  const cursor = new Date(dateStart + "T00:00:00Z");
  const stop = new Date(dateStop + "T00:00:00Z");
  while (cursor <= stop && dates.length < 7) { // safety cap at 7 days
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const perDay = await Promise.all(dates.map(d => fetchSofascoreFixturesForDate(d)));
  return perDay.flat();
}

// Minimum number of match records below which supplemental tiers are attempted.
const SOFASCORE_MIN_RECORDS_THRESHOLD = 5;

export class CompositeTennisProvider implements TennisDataProvider {
  readonly name: string;
  /**
   * Caches player names keyed by player ID so the Sofascore tier-3 fallback in
   * getPlayerMatches can do a name-based search (Sofascore has no ID-based lookup).
   * Populated automatically on every successful getPlayer() call.
   */
  private readonly playerNameCache = new Map<string, string>();

  constructor(
    private readonly primary: TennisDataProvider,
    private readonly fallback: TennisDataProvider,
  ) {
    this.name = `${primary.name}+${fallback.name}`;
  }

  private async withFallback<T>(
    methodName: string,
    primaryCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
  ): Promise<T> {
    try {
      return await primaryCall();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        logger.warn({ method: methodName, primaryError: err.message }, `${this.primary.name} unavailable — falling back to ${this.fallback.name}`);
        return fallbackCall();
      }
      throw err;
    }
  }

  getStatus(): ProviderStatusInfo {
    // When the primary is connected, report it. When it isn't (rate-limited, quota exhausted,
    // network error) report the fallback instead — that's the provider actually serving requests,
    // and showing the primary's "disconnected" state while the app is perfectly functional causes
    // a misleading offline badge in the UI.
    const primaryStatus = this.primary.getStatus();
    if (primaryStatus.connected) return primaryStatus;
    const fallbackStatus = this.fallback.getStatus();
    if (fallbackStatus.connected) return fallbackStatus;
    // Both down: return primary so the error message is as specific as possible.
    return primaryStatus;
  }

  async searchPlayers(query: string): Promise<PlayerSummary[]> {
    return this.withFallback(
      "searchPlayers",
      () => this.primary.searchPlayers(query),
      () => this.fallback.searchPlayers(query),
    );
  }

  /**
   * Pre-seed the player name cache so the Sofascore tier-3 in getPlayerMatches
   * can activate even when both primary and fallback fail for getPlayer. Should
   * be called by any code that already has the player name from fixture data
   * (e.g. predictFromSnapshot when submittedPlayerName is available). Has no
   * effect if the ID is already cached from a prior getPlayer call.
   */
  seedPlayerName(playerId: string, name: string): void {
    if (!this.playerNameCache.has(playerId)) {
      this.playerNameCache.set(playerId, name);
    }
  }

  async getPlayer(playerId: string): Promise<PlayerProfile | null> {
    const profile = await this.withFallback(
      "getPlayer",
      () => this.primary.getPlayer(playerId),
      () => this.fallback.getPlayer(playerId),
    );
    // Cache name for Sofascore tier-3 in getPlayerMatches (name-based search).
    if (profile?.name) {
      this.playerNameCache.set(playerId, profile.name);
    }
    return profile;
  }

  async getPlayerMatches(playerId: string): Promise<MatchRecord[]> {
    // Match history is enrichment data — the prediction engine degrades gracefully to a
    // lower data-quality score when history is absent. If BOTH providers are unavailable
    // (MatchStat has no history endpoint; API-Tennis times out under load), return [] so
    // the prediction still runs rather than surfacing a 502 to the user.
    let records: MatchRecord[] = [];
    try {
      records = await this.primary.getPlayerMatches(playerId);
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) {
        throw err;
      }
      logger.warn({ playerId, err: err.message }, "Primary provider unavailable for getPlayerMatches — trying fallback");
    }

    // Empty or sparse success is not proof that the fallback has no data. Provider coverage
    // differs by tour and endpoint, so always query API-Tennis when the primary did not produce
    // a complete history, then retain the richer result.
    if (records.length < SOFASCORE_MIN_RECORDS_THRESHOLD) {
      try {
        const fallbackRecords = await this.fallback.getPlayerMatches(playerId);
        if (fallbackRecords.length > records.length) records = fallbackRecords;
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        logger.warn({ playerId, err: err.message }, "Fallback provider unavailable for getPlayerMatches — continuing to tertiary tiers");
      }
    }

    const playerName = this.playerNameCache.get(playerId);

    // Tier-3: BSD Tennis (sports.bzzoiro.com). Structured JSON API, covers top ATP/WTA
    // ranked players. Only fires when BSD_TENNIS_API_KEY is configured and both primary
    // and fallback are unavailable or return sparse history.
    if (records.length < SOFASCORE_MIN_RECORDS_THRESHOLD && playerName) {
      try {
        const bsdResult = await fetchFromBsdTennis(playerName);
        if (bsdResult.records.length > records.length) {
          logger.debug(
            { playerId, playerName, prior: records.length, bsd: bsdResult.records.length, resolvedVia: bsdResult.resolvedVia ?? "rankings-cache" },
            "compositeProvider: BSD Tennis tier-3 supplemented match history",
          );
          records = bsdResult.records;
        }
      } catch (bsdErr) {
        logger.debug({ playerId, playerName, err: bsdErr }, "compositeProvider: BSD Tennis tier-3 failed (non-fatal)");
      }
    }

    // Tier-4: Sofascore (public unauthenticated API). Broader coverage for Challenger/ITF/
    // WTA-lower players not in BSD's top-500 rankings. Only attempted when a player name
    // is cached (i.e. getPlayer was called first, which is the normal prediction flow).
    if (records.length < SOFASCORE_MIN_RECORDS_THRESHOLD && playerName) {
      try {
        const sfResult = await fetchFromSofascore(playerName);
        if (sfResult.records.length > records.length) {
          logger.debug(
            { playerId, playerName, prior: records.length, sofascore: sfResult.records.length },
            "compositeProvider: Sofascore tier-4 supplemented match history",
          );
          records = sfResult.records;
        }
      } catch (sfErr) {
        logger.debug({ playerId, playerName, err: sfErr }, "compositeProvider: Sofascore tier-4 failed (non-fatal)");
      }
    }

    // Tier-5: historical_matches DB. Final safety net when all live providers (MatchStat,
    // API-Tennis, BSD Tennis, Sofascore) are unavailable or return sparse history.
    // Resolve the full alias group (includes any sackmann-* ID bridged to this live ID) so
    // the Sackmann archive rows (pre-2024) are returned alongside 2025+ api-tennis rows.
    if (records.length < SOFASCORE_MIN_RECORDS_THRESHOLD) {
      try {
        const identityIndex = await getCachedPlayerIdentityIndex();
        const canonicalId = identityIndex.canonicalIdById.get(playerId) ?? playerId;
        const aliasIds = getAliasIds(identityIndex, canonicalId);
        const dbRecords = await getPlayerMatchesFromDb(aliasIds.length > 1 ? aliasIds : playerId);
        if (dbRecords.length > records.length) {
          logger.info(
            { playerId, canonicalId, aliasCount: aliasIds.length, prior: records.length, db: dbRecords.length },
            "compositeProvider: historical_matches DB tier-5 supplemented match history",
          );
          records = dbRecords;
        }
      } catch (dbErr) {
        logger.debug({ playerId, err: dbErr }, "compositeProvider: DB tier-5 failed (non-fatal)");
      }
    }

    return records;
  }

  async getUpcomingFixtures(date: string): Promise<Fixture[]> {
    return this.getUpcomingFixturesRange(date, date);
  }

  async getUpcomingFixturesRange(dateStart: string, dateStop: string, opts?: { bypassCache?: boolean }): Promise<Fixture[]> {
    // Tier-1: RapidAPI (MatchStat) — confirmed working endpoints, 30-min cache.
    // Tier-2: API-Tennis — only when tier-1 is rate-limited/quota-exhausted.
    // Tier-3: Sofascore public API — when both tier-1 and tier-2 are unavailable
    //         (e.g. API-Tennis billing lapsed and RapidAPI quota exhausted for the day).
    //         No auth required; covers ATP, WTA, Challenger, ITF.
    let fixtures: Fixture[] = [];
    let usedTier = "";

    try {
      fixtures = await this.primary.getUpcomingFixturesRange(dateStart, dateStop, opts);
      usedTier = "primary";
    } catch (primaryErr) {
      if (!(primaryErr instanceof ProviderUnavailableError)) throw primaryErr;
      logger.warn({ method: "getUpcomingFixturesRange", primaryError: (primaryErr as Error).message },
        `${this.primary.name} unavailable for fixtures — trying ${this.fallback.name}`);
      try {
        fixtures = await this.fallback.getUpcomingFixturesRange(dateStart, dateStop, opts);
        usedTier = "fallback";
      } catch (fallbackErr) {
        if (!(fallbackErr instanceof ProviderUnavailableError)) throw fallbackErr;
        logger.warn({ method: "getUpcomingFixturesRange", fallbackError: (fallbackErr as Error).message },
          `${this.fallback.name} also unavailable — using Sofascore tertiary for fixtures`);
      }
    }

    // If both primary and fallback failed (or returned 0 results while both are known to be down),
    // try Sofascore as a silent tertiary. Never throws.
    if (fixtures.length === 0 && usedTier === "") {
      fixtures = await fetchSofascoreFixturesRange(dateStart, dateStop);
      if (fixtures.length > 0) {
        logger.info({ dateStart, dateStop, count: fixtures.length },
          "compositeProvider: Sofascore tertiary provided fixture list (both primary providers unavailable)");
      }
    }

    // Surface enrichment: any fixture whose provider left surface=null gets a second attempt
    // using the static tournament-name lookup table (the same one that powers live predictions).
    // This covers all GrandSlams, Masters 1000s, and the prominent 500-level events by name.
    // Fixtures for smaller Challenger/ITF events that still can't be resolved stay null rather
    // than being guessed — the UI shows "Unknown" and the Predict button falls back safely.
    let enrichedCount = 0;
    fixtures = fixtures.map((f) => {
      if (f.surface !== null || !f.tournamentName) return f;
      const { surface } = inferSurfaceAndLevel(f.tournamentName);
      if (surface) {
        enrichedCount++;
        return { ...f, surface };
      }
      return f;
    });
    if (enrichedCount > 0) {
      logger.info({ enrichedCount }, "compositeProvider: surface-enriched fixtures via tournament-name lookup");
    }

    return fixtures;
  }

  async getHeadToHead(player1Id: string, player2Id: string): Promise<HeadToHeadRecord> {
    return this.withFallback(
      "getHeadToHead",
      () => this.primary.getHeadToHead(player1Id, player2Id),
      () => this.fallback.getHeadToHead(player1Id, player2Id),
    );
  }

  async getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]> {
    // Historical backfill uses API-Tennis exclusively — MatchStat doesn't support this endpoint.
    return this.fallback.getCompletedMatchesByDateRange(dateStart, dateStop);
  }

  async getLiveScores(fixtureIds: string[]): Promise<Map<string, LiveScore>> {
    // MatchStat (primary) does not provide live scores — hard-route to API-Tennis so real
    // in-progress score data is never silently replaced with an empty map. Same pattern
    // as getCompletedMatchesByDateRange, which MatchStat also doesn't support.
    return this.fallback.getLiveScores(fixtureIds);
  }

  async findTournamentSurfaceByName(name: string): Promise<{ surface: import("./types").Surface | null; level: import("./types").TournamentLevel | null } | null> {
    // Only API-Tennis has the tournament-surface-by-name lookup; delegate directly.
    if (this.fallback.findTournamentSurfaceByName) {
      return this.fallback.findTournamentSurfaceByName(name);
    }
    return null;
  }

  /**
   * Live standings come exclusively from API-Tennis (the fallback). The MatchStat primary does
   * not implement this method, so — like `getLiveScores` and `getCompletedMatchesByDateRange` —
   * we route directly to the provider that can actually serve the data. If the fallback also
   * doesn't implement it (e.g. a test stub), we return an empty array rather than throwing,
   * which is consistent with the `runRankingVerification` guard that already handles the
   * `totalProviderRankings: 0` sentinel.
   */
  async getCurrentStandings(): Promise<Array<{ playerKey: string; rank: number; name: string; tour: "ATP" | "WTA" }>> {
    if (!this.fallback.getCurrentStandings) {
      logger.warn({ provider: this.name }, "Neither primary nor fallback implements getCurrentStandings — ranking verification will be skipped");
      return [];
    }
    return this.fallback.getCurrentStandings();
  }
}
