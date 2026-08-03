/**
 * RapidAPI tennis provider — wraps tennis-api-atp-wta-itf.p.rapidapi.com.
 *
 * Confirmed working endpoints (as of 2026-07-18):
 *   GET /tennis/v2/ms-api/upcoming/matches/atp   — upcoming ATP fixtures
 *   GET /tennis/v2/ms-api/upcoming/matches/wta   — upcoming WTA fixtures
 *   GET /tennis/v2/ms-api/ranking/{tour}?date=YYYY-MM-DD&group=<group>
 *                                                — rankings (group value TBD)
 *
 * Response shape (upcoming/matches):
 *   { total: number, matches: RawMatch[] }
 *   RawMatch: { tournament, court, roundId, rank, date, type, odds, player1, player2, h2h }
 *   player1/player2: { id: number, name: string, countryAcr: string, seed?: string }
 *   h2h: string "W1-W2" (e.g. "0-1")
 *
 * This API provides upcoming fixture data only.  Per-player match history,
 * player profiles, H2H detail, and completed results are not available — those
 * calls throw ProviderUnavailableError immediately so the composite provider
 * can route them to API-Tennis without an HTTP round-trip.
 *
 * Host is read at startup from RAPIDAPI_HOST; key is passed at construction.
 */
import { CircuitBreaker, CircuitOpenError } from "../../lib/circuitBreaker";
import { logger } from "../../lib/logger";
import { TtlCache } from "./cache";
import { normalizeProviderSurface } from "./surfaceMap";
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

const HOST = process.env.RAPIDAPI_HOST ?? "tennis-api-atp-wta-itf.p.rapidapi.com";
const BASE_URL = `https://${HOST}`;

// TTLs
// Fixtures: 30 minutes. The RapidAPI plan allows only a few hundred calls/day;
// 3-minute TTL produced ~480 fixture calls/day (2 tours × 240 refreshes) and
// exhausted the quota by midday. 30 minutes → ~48 calls/day, well within limits.
// The Refresh button bypasses the cache for on-demand updates.
const UPCOMING_TTL_MS = 30 * 60 * 1000;  // 30 minutes
export const RANKINGS_TTL_MS = 60 * 60 * 1000;  // 1 hour

// 429 handling — fail immediately and let the composite provider fall back to
// API-Tennis.  Retrying 429s in the primary provider delays requests by 35+
// seconds and causes browser timeouts before the fallback is reached.
const MAX_429_RETRIES = 0;
const BASE_BACKOFF_MS = 5_000; // kept for the backoff formula; unused at MAX=0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Raw response shapes (actual API) ────────────────────────────────────────

interface RawTournament {
  id?: number;
  name?: string;
  date?: string;        // ISO string "2026-07-13T00:00:00.000Z"
  rankId?: number;      // 1=GrandSlam 2=250 3=500 4=1000 (ATP)
  country?: string;
  court?: { name?: string };
}

interface RawPlayer {
  id?: number;
  name?: string;
  countryAcr?: string;
  seed?: string;
  odd?: string;
}

interface RawOdds {
  k1?: number;   // odds for player1
  k2?: number;   // odds for player2
  total?: number;
}

interface RawMatch {
  tournament?: RawTournament;
  court?: string;        // "Clay" | "Hard" | "Grass" | "Indoor Hard"
  roundId?: number;
  rank?: number;         // same as tournament.rankId
  date?: string;         // ISO string of scheduled start
  type?: string;         // "atp" | "wta"
  odds?: RawOdds;
  player1?: RawPlayer;
  player2?: RawPlayer;
  h2h?: string;          // "W1-W2" e.g. "0-1"
}

interface RawUpcomingResponse {
  total?: number;
  matches?: RawMatch[];
}

interface RawRankingEntry {
  rank?: number;
  player?: {
    id?: number;
    name?: string;
    country?: string;
    points?: number;
  };
}

interface RawRankingResponse {
  rankings?: RawRankingEntry[];
  error?: string;
  [key: string]: unknown;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function str(v: number | string | undefined | null): string {
  return v === undefined || v === null ? "" : String(v);
}

function mapSurface(court: string | undefined | null): Surface | null {
  if (!court) return null;
  return normalizeProviderSurface(court);
}

/**
 * Maps the API's numeric `rankId` / `rank` to our TournamentLevel enum.
 * ATP: 1=GrandSlam 2=ATP250 3=ATP500 4=Masters1000 5=Challenger
 * WTA: same scale but WTA tier names
 */
function mapLevel(rankId: number | undefined, tour: string | undefined): TournamentLevel | null {
  if (rankId === undefined) return null;
  const isWta = (tour ?? "").toLowerCase() === "wta";
  switch (rankId) {
    case 1: return "GrandSlam";
    case 2: return isWta ? "WTA250" : "ATP250";
    case 3: return isWta ? "WTA500" : "ATP500";
    case 4: return isWta ? "WTA1000" : "Masters1000";
    case 5: return "Challenger";
    default: return "Other";
  }
}

/**
 * Maps a numeric roundId to a human-readable round name.
 * Based on observed values; falls back to "Round {n}" for unknowns.
 */
function mapRound(roundId: number | undefined): string | null {
  if (roundId === undefined) return null;
  switch (roundId) {
    case 1: return "Final";
    case 2: return "Semifinal";
    case 4: return "Quarterfinal";
    case 8: return "Round of 16";
    case 10: return "Quarterfinal";  // observed at ATP250
    case 16: return "Round of 32";
    case 32: return "Round of 64";
    case 64: return "Round of 128";
    case 96: return "Qualifying";
    default: return `Round ${roundId}`;
  }
}

/** Returns true when a player-name slot looks like a doubles pair ("A. Smith/B. Jones"). */
function isDoublesName(name: string | undefined | null): boolean {
  return typeof name === "string" && name.includes("/");
}

function mapMatchToFixture(m: RawMatch): Fixture | null {
  const p1 = m.player1;
  const p2 = m.player2;
  if (!p1?.id || !p2?.id) return null;

  // Drop doubles fixtures — the prediction engine is singles-only and the
  // rankId scale used for doubles events doesn't match the singles mapping.
  if (isDoublesName(p1.name) || isDoublesName(p2.name)) return null;
  const tournamentName = m.tournament?.name ?? "";
  if (/doubles/i.test(tournamentName)) return null;

  // Match-level `date` is null in some API responses (e.g. qualifying rounds before scheduling
  // is confirmed). Fall back to the tournament start date so the fixture is still surfaced.
  // scheduledStart stays null (timeConfirmed=false) when only the tournament date is available.
  const rawDate = m.date ?? m.tournament?.date ?? null;
  const dateStr = rawDate ? rawDate.slice(0, 10) : null;
  if (!dateStr) return null;

  const courtStr = m.court ?? m.tournament?.court?.name;
  const surface = mapSurface(courtStr);
  let level = mapLevel(m.rank ?? m.tournament?.rankId, m.type);

  // Sanity-check: if the tournament name mentions "Challenger" but the level
  // mapped to GrandSlam (rankId collision in doubles/ITF events), correct it.
  if (level === "GrandSlam" && /challenger/i.test(tournamentName)) {
    level = "Challenger";
  }

  const id = `${str(m.tournament?.id)}:${str(p1.id)}:${str(p2.id)}`;

  // Use the real match time if available; if only the tournament date is known, mark time as
  // unconfirmed so the UI shows "Time TBD" rather than a fabricated start time.
  const scheduledStart = m.date ?? null;

  return {
    id,
    date: dateStr,
    scheduledStart,
    timeConfirmed: !!m.date,
    isLive: false,   // upcoming/matches only returns scheduled (not live)
    tournamentName: m.tournament?.name ?? null,
    tournamentLevel: level,
    round: mapRound(m.roundId),
    surface,
    indoor: surface === "IndoorHard" ? true : null,
    matchFormat: null,
    player1Id: str(p1.id),
    player1Name: p1.name ?? str(p1.id),
    player2Id: str(p2.id),
    player2Name: p2.name ?? str(p2.id),
  };
}

// ─── Provider class ───────────────────────────────────────────────────────────

export class MatchStatProvider implements TennisDataProvider {
  readonly name = "MatchStat";

  private apiKey: string;
  private cache = new TtlCache();
  private lastSuccessfulCallAt: string | null = null;
  private lastError: string | null = null;
  /**
   * Circuit breaker for outbound MatchStat/RapidAPI calls.
   * MatchStat outages tend to last hours; 60 s open duration reduces
   * probe-timeout waste while still recovering quickly when it comes back.
   */
  private breaker = new CircuitBreaker("matchstat", {
    failureThreshold: 5,
    openDurationMs: 60_000,
  });

  /**
   * Fast player-by-ID lookup built as a side-effect of the rankings fetch.
   *
   * Eviction contract: both `playerById` and `playerByIdExpiresAt` are set
   * exclusively inside the TtlCache fetcher callback that populates
   * `rankings:all:*`.  `getPlayer()` rejects (clears the Map and throws) when
   * `Date.now() > playerByIdExpiresAt`, so callers never receive data older
   * than RANKINGS_TTL_MS even if no `searchPlayers()` call has triggered a
   * refresh yet.  A process restart resets both structures together.
   */
  private playerById = new Map<string, PlayerSummary>();
  /** Absolute timestamp (ms) after which playerById must be treated as expired. */
  private playerByIdExpiresAt = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getStatus(): ProviderStatusInfo {
    return {
      provider: this.name,
      connected: this.lastSuccessfulCallAt !== null,
      lastSuccessfulCallAt: this.lastSuccessfulCallAt,
      lastError: this.lastError,
    };
  }

  private async call<T>(path: string): Promise<T> {
    try {
      return await this.breaker.execute(async () => {
        const url = `${BASE_URL}${path}`;

        for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
          try {
            const response = await fetch(url, {
              headers: {
                "x-rapidapi-key": this.apiKey,
                "x-rapidapi-host": HOST,
              },
              signal: AbortSignal.timeout(12_000),
            });

            if (response.status === 429) {
              const retryAfterSec = Number(response.headers.get("retry-after") ?? "0");
              const waitMs = retryAfterSec > 0
                ? retryAfterSec * 1_000
                : BASE_BACKOFF_MS * Math.pow(2, attempt);

              if (attempt < MAX_429_RETRIES) {
                logger.warn({ path, attempt, waitMs }, "RapidAPI 429 — backing off before retry");
                await sleep(waitMs);
                continue;
              }
              throw new ProviderUnavailableError(
                `RapidAPI rate limit exceeded after ${MAX_429_RETRIES} retries: ${path}`,
              );
            }

            if (!response.ok) {
              const body = await response.text().catch(() => "");
              throw new ProviderUnavailableError(
                `MatchStat API HTTP ${response.status}: ${body.slice(0, 200)}`,
              );
            }

            const body = (await response.json()) as Record<string, unknown>;
            // Some errors come as HTTP 200 with {message: "..."} or {error: "..."}
            if (typeof body.message === "string") {
              throw new ProviderUnavailableError(`MatchStat API: ${body.message}`);
            }

            this.lastSuccessfulCallAt = new Date().toISOString();
            this.lastError = null;
            return body as T;

          } catch (err) {
            if (err instanceof ProviderUnavailableError) {
              this.lastError = err.message;
              throw err;
            }
            const message = err instanceof Error ? err.message : "Unknown error calling MatchStat";
            this.lastError = message;
            logger.error({ err, path }, "MatchStat API call failed");
            throw new ProviderUnavailableError(message);
          }
        }

        throw new ProviderUnavailableError(`MatchStat call failed: ${path}`);
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Fast-fail: circuit is OPEN, no HTTP round-trip needed.
        // Re-throw as ProviderUnavailableError so compositeProvider.withFallback
        // routes the call to API-Tennis immediately.
        this.lastError = `circuit breaker OPEN (matchstat)`;
        throw new ProviderUnavailableError(
          `MatchStat unavailable — circuit breaker OPEN (matchstat)`,
        );
      }
      throw err;
    }
  }

  // ── Upcoming fixtures (confirmed working) ────────────────────────────────────

  private async fetchUpcomingForTour(tour: "atp" | "wta"): Promise<Fixture[]> {
    const key = `upcoming:${tour}`;
    return this.cache.getOrFetch(key, UPCOMING_TTL_MS, async () => {
      const data = await this.call<RawUpcomingResponse>(
        `/tennis/v2/ms-api/upcoming/matches/${tour}`,
      );
      const matches = data.matches ?? [];
      const fixtures: Fixture[] = [];
      for (const m of matches) {
        const f = mapMatchToFixture(m);
        if (f) fixtures.push(f);
      }
      return fixtures;
    });
  }

  async getUpcomingFixtures(date: string): Promise<Fixture[]> {
    return this.getUpcomingFixturesRange(date, date);
  }

  async getUpcomingFixturesRange(
    dateStart: string,
    dateStop: string,
    opts?: { bypassCache?: boolean },
  ): Promise<Fixture[]> {
    // Fetch both tours; the API returns all upcoming, we filter to the requested window.
    const cacheKey = `upcoming:all`;
    const all = await this.cache.getOrFetch(
      cacheKey,
      UPCOMING_TTL_MS,
      async () => {
        const [atp, wta] = await Promise.all([
          this.fetchUpcomingForTour("atp"),
          this.fetchUpcomingForTour("wta"),
        ]);
        return [...atp, ...wta];
      },
      { bypass: opts?.bypassCache },
    );

    if (!dateStart && !dateStop) return all;
    return all.filter((f) => {
      if (!f.date) return false;
      return f.date >= dateStart && f.date <= dateStop;
    });
  }

  // ── Rankings ─────────────────────────────────────────────────────────────────
  // Endpoint: GET /tennis/v2/ms-api/ranking/{tour}?date=YYYY-MM-DD&group=race
  // Returns an array of ranking entries (Race to Turin / Race to Singapore).
  // "race" is the confirmed working group value; live-ranking group TBD.

  async searchPlayers(query: string): Promise<PlayerSummary[]> {
    const today = new Date().toISOString().slice(0, 10);

    // Cache the FULL rankings list (not query-filtered) so all searches on the same day share
    // one network call. The previous bug used a query-agnostic key but filtered inside the
    // cache callback, so searching "Mi" would cache only Mi-results and break every other query.
    //
    // If BOTH tours fail (rate limited), throw ProviderUnavailableError so the composite
    // provider falls back to API-Tennis. A single-tour failure is tolerated (partial results
    // beat nothing). Throwing means TtlCache does NOT persist the failure, so the next request
    // retries the network rather than serving a stale empty list all day.
    const allEntries = await this.cache.getOrFetch(
      `rankings:all:${today}`,
      RANKINGS_TTL_MS,
      async () => {
        const [atpRaw, wtaRaw] = await Promise.all([
          this.call<RawRankingEntry[]>(`/tennis/v2/ms-api/ranking/atp?date=${today}&group=race`).catch(() => null),
          this.call<RawRankingEntry[]>(`/tennis/v2/ms-api/ranking/wta?date=${today}&group=race`).catch(() => null),
        ]);
        if (atpRaw === null && wtaRaw === null) {
          throw new ProviderUnavailableError("MatchStat: both ATP and WTA ranking calls failed -- rate limited or unavailable");
        }
        const combined: Array<{ entry: RawRankingEntry; tour: "ATP" | "WTA" }> = [];
        for (const e of (Array.isArray(atpRaw) ? atpRaw : [])) combined.push({ entry: e, tour: "ATP" });
        for (const e of (Array.isArray(wtaRaw) ? wtaRaw : [])) combined.push({ entry: e, tour: "WTA" });

        // Rebuild playerById in lockstep with the fresh rankings so it is never
        // older than the TtlCache entry.  Set the expiry first, then clear and
        // repopulate so getPlayer() rejects stale lookups even when this fetcher
        // hasn't been called yet after TTL expiry.
        this.playerByIdExpiresAt = Date.now() + RANKINGS_TTL_MS;
        this.playerById.clear();
        for (const { entry: e, tour } of combined) {
          const p = e.player;
          if (!p?.id) continue;
          const id = String(p.id);
          this.playerById.set(id, {
            id,
            name: p.name ?? "",
            countryCode: p.country ?? null,
            currentRank: typeof e.rank === "number" ? e.rank : null,
            tour,
          });
        }

        return combined;
      },
    );

    // Filter in memory -- instant, no additional network calls
    const lowerQuery = query.toLowerCase().trim();
    const results: PlayerSummary[] = [];
    const seen = new Set<string>();

    for (const { entry: e, tour } of allEntries) {
      const p = e.player;
      if (!p?.id) continue;
      const id = String(p.id);
      if (seen.has(id)) continue;
      const name = p.name ?? "";
      if (!name.toLowerCase().includes(lowerQuery)) continue;
      seen.add(id);
      results.push({
        id,
        name,
        countryCode: p.country ?? null,
        currentRank: typeof e.rank === "number" ? e.rank : null,
        tour,
      });
    }

    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerQuery;
      const bExact = b.name.toLowerCase() === lowerQuery;
      if (aExact !== bExact) return aExact ? -1 : 1;
      if (a.currentRank === null && b.currentRank === null) return 0;
      if (a.currentRank === null) return 1;
      if (b.currentRank === null) return -1;
      return a.currentRank - b.currentRank;
    });

    return results.slice(0, 25);
  }

  // ── Not available on this API — throw immediately to avoid wasted HTTP calls ──

  async getPlayer(playerId: string): Promise<PlayerProfile | null> {
    // playerById is populated as a side-effect of the rankings fetch inside
    // searchPlayers(). If the rankings have already been fetched this TTL window
    // the map is populated; otherwise it is empty and we fall through to the
    // throw so the composite provider routes the call to API-Tennis.
    //
    // Important: MatchStat/RapidAPI player IDs are a different namespace from
    // API-Tennis IDs. Never attempt to look up MatchStat IDs against API-Tennis
    // or vice versa — they collide with unrelated players (often doubles teams).
    // The compositeProvider's name cache is seeded via seedPlayerName() by callers
    // that have the player name from fixture data, so the Sofascore tier-3 in
    // getPlayerMatches can activate even when both primary and fallback fail here.
    // Reject lookups whose underlying rankings data has aged past RANKINGS_TTL_MS,
    // even if no subsequent searchPlayers() call has triggered a fresh fetch yet.
    // Clear the Map on expiry so memory isn't held past its useful life.
    if (Date.now() > this.playerByIdExpiresAt) {
      this.playerById.clear();
      throw new ProviderUnavailableError(
        "MatchStat: player profile endpoint not available — routing to API-Tennis",
      );
    }
    const summary = this.playerById.get(playerId);
    if (summary) {
      return {
        ...summary,
        age: null,
        plays: null,
        fullName: null,
        source: "live-standings",
      };
    }
    throw new ProviderUnavailableError(
      "MatchStat: player profile endpoint not available — routing to API-Tennis",
    );
  }

  async getPlayerMatches(_playerId: string): Promise<MatchRecord[]> {
    // Individual match records are not available from this API.  Throwing here
    // causes the composite provider to route to API-Tennis (tier-2), and if that
    // also fails, Sofascore (tier-3) is attempted via the compositeProvider's own
    // getPlayerMatches fallback logic using the name seeded via seedPlayerName().
    throw new ProviderUnavailableError(
      "MatchStat: player match history endpoint not available — routing to API-Tennis",
    );
  }

  async getHeadToHead(_player1Id: string, _player2Id: string): Promise<HeadToHeadRecord> {
    // H2H is embedded as a summary string in upcoming match data ("0-1"), not a
    // detailed endpoint.  Throw so API-Tennis provides the full meeting history.
    throw new ProviderUnavailableError(
      "MatchStat: H2H detail endpoint not available — routing to API-Tennis",
    );
  }

  async getCompletedMatchesByDateRange(): Promise<HistoricalFixture[]> {
    // Completed/historical results not provided by this API.
    return [];
  }

  async getLiveScores(_fixtureIds: string[]): Promise<Map<string, LiveScore>> {
    return new Map();
  }
}
