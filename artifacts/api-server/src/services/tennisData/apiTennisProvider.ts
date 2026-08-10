import { logger } from "../../lib/logger";
import { withRetry, isTransientError } from "../../lib/retry";
import { CircuitBreaker } from "../../lib/circuitBreaker";
import { PriorityCallQueue, type CallPriority } from "../../lib/priorityCallQueue";
import { TtlCache } from "./cache";
import { inferLevelFromEventType, normalizeProviderSurface, resolveSurfaceAndLevel } from "./surfaceMap";
import { resolveTournamentTimezone } from "./timezoneMap";
import type { Surface, TournamentLevel } from "./types";
import {
  ProviderUnavailableError,
  type Fixture,
  type HeadToHeadRecord,
  type HistoricalFixture,
  type LiveScore,
  type MatchFormat,
  type MatchRecord,
  type MatchStatLine,
  type PlayerProfile,
  type PlayerSummary,
  type ProviderStatusInfo,
  type TennisDataProvider,
} from "./types";

function normalizeTournamentNameForSearch(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derives a tier-filter RegExp from an OCR event name so that surface lookup can narrow
 * to only rows matching that tier. Returns null when no recognisable tier marker is present
 * (caller should leave candidates unfiltered in that case).
 *
 * Examples:
 *   "ATP CHALLENGER HAMBURG"  → /challenger/i
 *   "ITF W25 BOGOTÁ"          → /itf/i
 *   "ATP500 HAMBURG"          → null  (no filter; unmodified behaviour)
 */
function deriveTierFilter(ocrName: string): RegExp | null {
  const lower = ocrName.toLowerCase();
  if (lower.includes("challenger")) return /challenger/i;
  if (lower.includes("itf")) return /itf/i;
  return null;
}

const BASE_URL = "https://api.api-tennis.com/tennis/";
const STANDINGS_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FIXTURES_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Task #164: dedicated short-lived cache lane for live scores, kept separate from FIXTURES_TTL_MS
// so a frontend polling for real-time scores every 5-10s never forces the whole (heavier,
// 5-minute) fixtures list to re-fetch, and vice versa.
const LIVE_SCORE_TTL_MS = 8 * 1000; // 8 seconds
// Tournament surface/venue assignments change extremely rarely (a tournament switching surface
// is a multi-year event, if it ever happens) -- a long TTL avoids re-pulling ~10k rows on every
// prediction while still refreshing periodically rather than caching for the process lifetime.
const TOURNAMENTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ApiTennisEnvelope<T> {
  success: 0 | 1;
  result: T;
}

/** API-Tennis is inconsistent about whether keys come back as strings or numbers -- always normalize with str(). */
function str(value: string | number): string {
  return String(value);
}

/**
 * Returns this IANA timezone's real UTC offset (in ms) at the given UTC instant, via
 * `Intl.DateTimeFormat` -- there is no simpler standard-library way to ask "what is timezone X's
 * offset at instant Y" in Node without a database dependency, and this needs to be genuinely
 * DST-aware (a fixed year-round offset would misplace matches near a DST transition).
 */
function timezoneOffsetMs(timezone: string, atUtcMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(atUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Treat the timezone's local wall-clock reading at `atUtcMs` as if it were itself a UTC
  // instant. The gap between that value and the real UTC instant IS the timezone's offset.
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallClockAsUtc - atUtcMs;
}

/**
 * Converts a real local wall-clock date+time in a given IANA timezone into the correct UTC
 * instant, DST-aware. Two-pass: the offset can itself depend on the (still-unknown) UTC instant
 * near a DST transition, so the first-pass offset (computed as if the naive wall-clock reading
 * were already UTC) is used to get a close UTC estimate, then the offset is re-checked at that
 * estimate and applied again -- the standard technique for zoned-to-UTC conversion.
 */
function zonedWallTimeToUtcMs(naiveUtcMs: number, timezone: string): number {
  const firstPassOffset = timezoneOffsetMs(timezone, naiveUtcMs);
  const estimate = naiveUtcMs - firstPassOffset;
  const secondPassOffset = timezoneOffsetMs(timezone, estimate);
  return naiveUtcMs - secondPassOffset;
}

/**
 * Combines the provider's per-fixture `event_date` ("YYYY-MM-DD") and `event_time` ("HH:MM") into
 * a real UTC instant. Confirmed live (2026-07-12): fixtures on the same date routinely carry
 * different `event_time` values (e.g. "14:10", "16:10", "13:10", "17:10" all on one day) -- this
 * is a genuine per-match field, not a shared/derived value, so it must never be dropped or
 * defaulted to a placeholder.
 *
 * `event_time` is the tournament venue's real LOCAL wall-clock time, not UTC (confirmed live
 * 2026-07-13 -- see `timezoneMap.ts`'s header for the exact evidence: several matches already
 * live/mid-set had raw `event_time` values that, read as literal UTC, would place their start in
 * the future). `timezone` -- resolved by the caller via `resolveTournamentTimezone` -- is
 * required to convert correctly; when it's null (venue not confidently identified), this returns
 * null rather than guessing, and callers must show "Time TBD".
 */
export function combineDateTimeUtc(eventDate: string | undefined, eventTime: string | undefined, timezone: string | null): string | null {
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  if (!eventTime || !/^\d{2}:\d{2}$/.test(eventTime)) return null;
  if (!timezone) return null;
  const [year, month, day] = eventDate.split("-").map(Number);
  const [hour, minute] = eventTime.split(":").map(Number);
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (Number.isNaN(naiveUtcMs)) return null;
  const realUtcMs = zonedWallTimeToUtcMs(naiveUtcMs, timezone);
  if (Number.isNaN(realUtcMs)) return null;
  return new Date(realUtcMs).toISOString();
}

interface RawStandingRow {
  place: string;
  player: string;
  player_key: string | number;
  league: string;
  country: string;
  points: string;
}

interface RawPlayer {
  player_key: string | number;
  player_name: string;
  player_full_name?: string | null;
  player_country: string | null;
  player_bday: string | null;
}

interface RawScoreEntry {
  score_first: string;
  score_second: string;
  score_set: string;
}

/**
 * Confirmed live (2026-07-11): `get_tournaments` returns one row per (tournament, event-type)
 * combination -- e.g. a single physical tournament has separate rows for "... Men Singles" and
 * "... Men Doubles" -- each with its own `tournament_key`, matching the `tournament_key` field
 * every `get_fixtures` row also carries. `tournament_sourface` (sic, provider's own typo) is
 * present for the large majority of the ~10,100 rows checked live, including Challenger/ITF
 * events the name-based regex table never covered.
 */
interface RawTournamentRow {
  tournament_key: string | number;
  tournament_name: string;
  event_type_key: string | number;
  event_type_type?: string;
  tournament_sourface?: string | null;
}

/**
 * Confirmed live (2026-07-11): `get_fixtures` returns a `statistics` array for a subset of
 * finished matches (mostly tour-level, ~23% of finished matches in a sample window) with
 * match- and set-level per-player stat rows. This directly contradicts the provider's docs,
 * which don't mention this field at all -- always verify live, per prior provider quirks.
 */
export interface RawStatEntry {
  player_key: string | number;
  stat_period: string; // "match", "set1", "set2", ...
  stat_type: string; // "Service" | "Return" | "Points"
  stat_name: string;
  stat_value: string; // often a percentage string like "65%", sometimes a plain count like "3"
  stat_won: number | null;
  stat_total: number | null;
}

/**
 * API-Tennis's raw `get_fixtures`/`get_H2H` match shape. Exported so the historical backtest
 * reconstruction (`historicalData/matchRecordReconstruction.ts`) can parse the exact same
 * `rawSource` JSON the backfill pipeline froze per match, using this SAME mapper -- never a
 * second, independently-maintained parser that could silently drift from this one.
 */
export interface RawMatch {
  event_key: string | number;
  event_date: string;
  event_time?: string;
  event_first_player: string;
  first_player_key: string | number;
  event_second_player: string;
  second_player_key: string | number;
  event_final_result: string;
  event_winner: "First Player" | "Second Player" | null;
  event_status: string;
  event_type_type?: string;
  tournament_name: string;
  tournament_key?: string;
  tournament_round?: string;
  scores?: RawScoreEntry[];
  statistics?: RawStatEntry[];
  /**
   * Per-match player ranks when the provider includes them in the fixture payload. API-Tennis
   * doesn't document these fields and doesn't supply them in most responses, so they are typed
   * as optional -- callers must treat absence as "not available", never as rank 0.
   */
  first_player_rank?: string | number | null;
  second_player_rank?: string | number | null;
  /**
   * Indoor venue flag when the provider includes it. API-Tennis rarely surfaces this; when
   * absent callers fall back to the "IndoorHard" surface inference as a secondary signal.
   */
  indoor?: 0 | 1 | boolean | null;
}

/** Parses "65%" -> 65, "3" -> 3; returns null on anything unparseable, never a fabricated default. */
export function parseStatNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const parsed = parseFloat(value.replace("%", "").trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Builds a real, provider-reported point-level stat line for one player from a match's
 * `statistics` array, using only `stat_period === "match"` rows (whole-match totals, not
 * per-set breakdowns). Returns null when the provider didn't include statistics for this
 * match/player at all -- callers must treat that as "unavailable", never interpolate.
 */
export function mapStatistics(raw: RawMatch, playerKey: string): MatchStatLine | null {
  if (!raw.statistics || raw.statistics.length === 0) return null;
  const rows = raw.statistics.filter((s) => str(s.player_key) === playerKey && s.stat_period === "match");
  if (rows.length === 0) return null;

  const find = (statType: string, statName: string) => rows.find((r) => r.stat_type === statType && r.stat_name === statName);

  const breakPointsSavedRow = find("Service", "Break Points Saved");

  const line: MatchStatLine = {
    firstServePct: parseStatNumber(find("Service", "1st serve percentage")?.stat_value),
    firstServeWon: parseStatNumber(find("Service", "1st serve points won")?.stat_value),
    secondServeWon: parseStatNumber(find("Service", "2nd serve points won")?.stat_value),
    aces: parseStatNumber(find("Service", "Aces")?.stat_value),
    doubleFaults: parseStatNumber(find("Service", "Double Faults")?.stat_value),
    breakPointsSaved: breakPointsSavedRow?.stat_won ?? parseStatNumber(breakPointsSavedRow?.stat_value),
    breakPointsFaced: breakPointsSavedRow?.stat_total ?? null,
    returnPointsWon: parseStatNumber(find("Points", "Return Points Won")?.stat_value),
    servicePointsWonPct: parseStatNumber(find("Points", "Service Points Won")?.stat_value),
  };

  // If every field came back null, the provider didn't actually have usable data for this
  // player/match despite the array being non-empty -- report "unavailable", not a hollow object.
  const hasAnyValue = Object.values(line).some((v) => v !== null);
  return hasAnyValue ? line : null;
}

function determineMatchFormat(eventTypeType: string | undefined, level: string | null): MatchFormat {
  const type = eventTypeType ?? "";
  const isDoubles = /doubles/i.test(type);
  const isMen = /atp|men/i.test(type);
  // Best-of-5 only applies to men's singles at Grand Slams -- doubles (at any level, including
  // slams) and all WTA/junior/challenger matches are best-of-3.
  if (isMen && !isDoubles && level === "GrandSlam") return "BestOf5";
  return "BestOf3";
}

function parseAgeFromBday(bday: string | null): number | null {
  if (!bday) return null;
  const parts = bday.split(".");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts.map((p) => parseInt(p, 10));
  if (!dd || !mm || !yyyy) return null;
  const born = new Date(yyyy, mm - 1, dd);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const hasHadBirthdayThisYear =
    now.getMonth() > born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() >= born.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

function mapMatchStatus(status: string): { retired: boolean; walkover: boolean; finished: boolean } {
  const lower = status.toLowerCase();
  return {
    retired: lower.includes("retired"),
    walkover: lower.includes("walkover") || lower.includes("w.o"),
    finished: lower === "finished" || lower.includes("retired") || lower.includes("walkover"),
  };
}

/**
 * API-Tennis reports tiebreak sets as decimals (e.g. "7.7"-"6.5" for a 7-6(5) set) instead of
 * documenting the tiebreak points separately. We don't have a reliable way to tell which side of
 * the decimal is the tiebreak-loser's points without more provider documentation, so we round to
 * the game count only -- an honest "7-6" beats a confusing "7.7-6.5". Deferred: reconstruct full
 * tiebreak scores (e.g. "7-6(5)") once the provider's exact encoding is confirmed.
 */
function mapScoreString(raw: RawMatch): string | null {
  if (raw.scores && raw.scores.length > 0) {
    return raw.scores
      .map((s) => {
        // Truncate (not round) to the whole-games part: "7.7" is 7 games (plus a tiebreak
        // point count we discard), and Math.round would wrongly bump it to 8.
        const first = Math.trunc(parseFloat(s.score_first));
        const second = Math.trunc(parseFloat(s.score_second));
        if (Number.isNaN(first) || Number.isNaN(second)) return `${s.score_first}-${s.score_second}`;
        return `${first}-${second}`;
      })
      .join(" ");
  }
  return raw.event_final_result ?? null;
}

/**
 * Real per-set game counts from `raw.scores`, aligned to player1/player2 the same way
 * `mapUpcomingFixture` assigns `first_player_key` -> player1 and `second_player_key` -> player2 --
 * `score_first`/`score_second` on each `RawScoreEntry` are already reported in that same
 * first/second order, so no separate identity lookup is needed here. Same tiebreak-decimal
 * truncation caveat as `mapScoreString` above (7.7 games -> 7, tiebreak point count discarded).
 */
function mapLiveScoreSets(raw: RawMatch): Array<{ player1Games: number; player2Games: number }> {
  if (!raw.scores) return [];
  return raw.scores.map((s) => {
    const player1Games = Math.trunc(parseFloat(s.score_first));
    const player2Games = Math.trunc(parseFloat(s.score_second));
    return {
      player1Games: Number.isNaN(player1Games) ? 0 : player1Games,
      player2Games: Number.isNaN(player2Games) ? 0 : player2Games,
    };
  });
}

/** Normalizes API-Tennis's free-text `event_type_type` into a coarse, stable tour label. */
function deriveTour(eventTypeType: string | undefined): string | null {
  const type = eventTypeType ?? "";
  if (!type) return null;
  if (/challenger/i.test(type)) return "Challenger";
  if (/itf/i.test(type)) return "ITF";
  if (/exhibition/i.test(type)) return "Exhibition";
  if (/boys|girls|junior/i.test(type)) return "Junior";
  if (/atp/i.test(type)) return "ATP";
  if (/wta/i.test(type)) return "WTA";
  return type;
}

function mapHistoricalFixtureGameMargins(raw: RawMatch): Array<{ player1Games: number; player2Games: number }> {
  if (!raw.scores) return [];
  return raw.scores
    .map((s) => {
      const first = Math.trunc(parseFloat(s.score_first));
      const second = Math.trunc(parseFloat(s.score_second));
      if (Number.isNaN(first) || Number.isNaN(second)) return null;
      return { player1Games: first, player2Games: second };
    })
    .filter((v): v is { player1Games: number; player2Games: number } => v !== null);
}

function mapSetGameMargins(raw: RawMatch, isFirstPlayer: boolean): Array<{ playerGames: number; opponentGames: number }> {
  if (!raw.scores) return [];
  return raw.scores
    .map((s) => {
      const first = parseInt(s.score_first, 10);
      const second = parseInt(s.score_second, 10);
      if (Number.isNaN(first) || Number.isNaN(second)) return null;
      return isFirstPlayer ? { playerGames: first, opponentGames: second } : { playerGames: second, opponentGames: first };
    })
    .filter((v): v is { playerGames: number; opponentGames: number } => v !== null);
}

export class ApiTennisProvider implements TennisDataProvider {
  readonly name = "API-Tennis";

  private apiKey: string;
  private cache = new TtlCache();
  private lastSuccessfulCallAt: string | null = null;
  private lastError: string | null = null;
  // ── Part 1: Separate circuit breakers per call purpose ─────────────────────
  // A timeout storm in the bulk-call breaker (walk-forward, historical backfill)
  // no longer opens the live-call breaker (fixture fetches, player lookups).
  // Both breakers still appear in getAllBreakerStatuses() so outages stay visible.
  private readonly liveBreaker = new CircuitBreaker("api-tennis-live", {
    failureThreshold: 5,
    openDurationMs: 30_000,
    windowMs: 60_000,
  });
  private readonly bulkBreaker = new CircuitBreaker("api-tennis-bulk", {
    failureThreshold: 5,
    openDurationMs: 60_000, // bulk jobs tolerate a longer cooldown
    windowMs: 60_000,
  });
  // ── Part 2: Priority queue ────────────────────────────────────────────────
  // Live calls always win concurrency slots ahead of bulk calls.
  // maxConcurrent=4 also caps total parallel API-Tennis requests, which limits
  // the number of simultaneous timeouts that can accumulate during a heavy
  // walk-forward run and trip the bulk breaker unnecessarily fast.
  private readonly queue = new PriorityCallQueue(4);

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

  /**
   * Execute one API-Tennis HTTP call.
   *
   * priority="live"  → goes through liveBreaker; gets priority access to the
   *                    shared concurrency queue. Use for all paths that paper
   *                    trading or active predictions depend on.
   * priority="bulk"  → goes through bulkBreaker; waits behind pending live work.
   *                    Use for walk-forward / historical-backfill player history
   *                    fetches. A bulk timeout storm never trips the live breaker.
   */
  private async call<T>(priority: CallPriority, method: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(BASE_URL);
    url.searchParams.set("method", method);
    url.searchParams.set("APIkey", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const breaker = priority === "live" ? this.liveBreaker : this.bulkBreaker;
    try {
      const result = await this.queue.enqueue(priority, () =>
        breaker.execute(() =>
          withRetry(
            async () => {
              const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
              if (!response.ok) {
                const statusErr = Object.assign(
                  new Error(`API-Tennis responded with HTTP ${response.status}`),
                  { status: response.status },
                );
                throw statusErr;
              }
              const body = (await response.json()) as ApiTennisEnvelope<T> & { error?: string; message?: string };
              if (body.success !== 1) {
                const detail = body.error ?? body.message ?? JSON.stringify(body);
                logger.warn({ method, detail }, "API-Tennis success=0 response");
                throw new Error(`API-Tennis reported an unsuccessful response: ${detail}`);
              }
              return body.result;
            },
            {
              attempts: 3,
              baseDelayMs: 500,
              maxDelayMs: 5_000,
              retryOn: (err) => isTransientError(err),
              onRetry: (err, attempt) =>
                logger.warn({ err, method, attempt }, "API-Tennis call retrying"),
            },
          ),
        ),
      );
      this.lastSuccessfulCallAt = new Date().toISOString();
      this.lastError = null;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error calling API-Tennis";
      this.lastError = message;
      logger.error({ err, method }, "API-Tennis call failed");
      throw new ProviderUnavailableError(message);
    }
  }

  private async getStandingsCache(): Promise<RawStandingRow[]> {
    return this.cache.getOrFetch("standings", STANDINGS_TTL_MS, async () => {
      const [atp, wta] = await Promise.all([
        this.call<RawStandingRow[]>("live", "get_standings", { event_type: "ATP" }),
        this.call<RawStandingRow[]>("live", "get_standings", { event_type: "WTA" }),
      ]);
      return [...(atp ?? []), ...(wta ?? [])];
    });
  }

  /**
   * Real tournament_key -> surface lookup built from `get_tournaments`, covering nearly every
   * tournament the provider knows about (including Challenger/ITF). Rows whose `tournament_sourface`
   * doesn't normalize to a real surface (junk values, team-event rows, missing) map to `null` --
   * an explicit "not available" for that tournament_key, not a fabricated guess.
   */
  private async getTournamentSurfaceMap(): Promise<Map<string, Surface | null>> {
    const rows = await this.getTournamentRows();
    const map = new Map<string, Surface | null>();
    for (const row of rows) {
      map.set(str(row.tournament_key), normalizeProviderSurface(row.tournament_sourface));
    }
    return map;
  }

  /** Shared cached fetch of every `get_tournaments` row -- backs both the tournament_key -> surface
   * map above and the name-based lookup below, so a name search never issues a second real API call. */
  private async getTournamentRows(): Promise<RawTournamentRow[]> {
    return this.cache.getOrFetch("tournamentRows", TOURNAMENTS_TTL_MS, async () => {
      const rows = await this.call<RawTournamentRow[]>("live", "get_tournaments");
      return rows ?? [];
    });
  }

  /**
   * Name-based fallback for callers with no `tournament_key` to work with -- currently just the
   * screenshot-import flow, which only ever has OCR'd event text, never a real fixture object.
   * Confirmed live (2026-07-13): `tournament_name` here is just the bare city/event name (e.g.
   * "Pozoblanco"), NOT the full "ATP Challenger Pozoblanco" label a screenshot shows -- that
   * tour/tier prefix comes from `event_type_type` instead. So matching runs the other way from a
   * first guess: every word of the (short) candidate `tournament_name` must appear in the
   * (longer) recognized text, not the reverse. Genuinely ambiguous (multiple candidates
   * disagreeing on surface) or absent matches return null rather than guessing.
   */
  async findTournamentSurfaceByName(name: string): Promise<{ surface: Surface | null; level: TournamentLevel | null } | null> {
    const rows = await this.getTournamentRows();
    const recognizedWords = new Set(normalizeTournamentNameForSearch(name).split(" ").filter(Boolean));
    if (recognizedWords.size === 0) return null;

    // Derive a tier filter from the OCR event name so that "ATP CHALLENGER HAMBURG" only
    // considers Hamburg Challenger rows, not historical ATP500 Hamburg rows that carry a
    // different surface and would otherwise force a null return due to surface ambiguity.
    const tierFilter = deriveTierFilter(name);

    let candidates = rows.filter((row) => {
      const rowWords = normalizeTournamentNameForSearch(row.tournament_name ?? "").split(" ").filter(Boolean);
      return rowWords.length > 0 && rowWords.every((w) => recognizedWords.has(w));
    });
    if (candidates.length === 0) return null;

    // Apply tier filter when OCR name contains a recognisable tier marker. Only narrow
    // when the filter actually matches at least one row; otherwise fall through to the
    // full candidate set (graceful degradation for unrecognised tier markers).
    if (tierFilter !== null) {
      const tiered = candidates.filter((row) => tierFilter.test(row.event_type_type ?? ""));
      if (tiered.length > 0) candidates = tiered;
    }

    const surfaces = new Set(candidates.map((row) => normalizeProviderSurface(row.tournament_sourface)).filter((s) => s !== null));
    if (surfaces.size > 1) return null; // genuinely ambiguous across matching rows -- never guess which one

    const surface = surfaces.size === 1 ? [...surfaces][0] : null;
    const level = inferLevelFromEventType(candidates[0]?.event_type_type ?? null);
    return { surface, level };
  }

  /**
   * Returns the current ATP + WTA standings in a flat, provider-neutral shape. Used by the
   * ranking-verification job to diff stored `master_players.currentRank` values against the
   * live official standings without the caller needing to know anything about the raw provider
   * format. Players whose `place` field doesn't parse to a valid integer are excluded (they
   * represent provisional/unranked rows that have no real rank to compare against).
   */
  async getCurrentStandings(): Promise<Array<{ playerKey: string; rank: number; name: string; tour: "ATP" | "WTA" }>> {
    const [atp, wta] = await Promise.all([
      this.call<RawStandingRow[]>("live", "get_standings", { event_type: "ATP" }),
      this.call<RawStandingRow[]>("live", "get_standings", { event_type: "WTA" }),
    ]);
    const result: Array<{ playerKey: string; rank: number; name: string; tour: "ATP" | "WTA" }> = [];
    for (const row of atp ?? []) {
      const rank = parseInt(row.place, 10);
      if (!Number.isNaN(rank) && rank > 0) result.push({ playerKey: str(row.player_key), rank, name: row.player, tour: "ATP" });
    }
    for (const row of wta ?? []) {
      const rank = parseInt(row.place, 10);
      if (!Number.isNaN(rank) && rank > 0) result.push({ playerKey: str(row.player_key), rank, name: row.player, tour: "WTA" });
    }
    return result;
  }

  /**
   * Player search is scoped to players who currently appear in the ATP/WTA standings feed.
   * API-Tennis has no name-search endpoint (`get_players` requires an exact `player_key`,
   * confirmed live: passing `player_name` returns a "Required parameter missing: player_key"
   * error, not a search). That means retired players, players outside the current
   * ATP/WTA rankings (e.g. Challenger/ITF-only players), and very recently-retired top
   * players are genuinely unsearchable with this provider -- not a bug in this function,
   * a hard provider limitation. Callers must not interpret an empty result as "player
   * doesn't exist"; it means "not in the current ATP/WTA standings snapshot".
   *
   * Within that scope we still make ranking honest and deterministic:
   * - de-duplicate by player_key (defensive: a player briefly overlapping both tour lists,
   *   or any future provider quirk, should not produce duplicate rows)
   * - rank exact (case-insensitive) full-name matches above partial/substring matches
   * - break ties by current rank ascending (unranked/parse failures sort last)
   * so the most relevant, most recognizable player for a query is never buried by
   * whichever tour's list happened to come first in the combined standings array.
   */
  async searchPlayers(query: string): Promise<PlayerSummary[]> {
    const standings = await this.getStandingsCache();
    const lowerQuery = query.toLowerCase().trim();

    const seen = new Set<string>();
    const matches: Array<{ row: RawStandingRow; rank: number | null; exact: boolean }> = [];
    for (const row of standings) {
      const key = str(row.player_key);
      if (seen.has(key)) continue;
      const lowerName = row.player.toLowerCase();
      if (!lowerName.includes(lowerQuery)) continue;
      seen.add(key);
      const rank = parseInt(row.place, 10);
      matches.push({ row, rank: Number.isNaN(rank) ? null : rank, exact: lowerName === lowerQuery });
    }

    matches.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.rank === null && b.rank === null) return 0;
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    });

    return matches.slice(0, 25).map(({ row }) => ({
      id: str(row.player_key),
      name: row.player,
      countryCode: row.country ?? null,
      currentRank: parseInt(row.place, 10) || null,
      tour: row.league ?? null,
    }));
  }

  async getPlayer(playerId: string): Promise<PlayerProfile | null> {
    const [players, standings] = await Promise.all([
      this.call<RawPlayer[]>("live", "get_players", { player_key: playerId }),
      this.getStandingsCache(),
    ]);
    const raw = players?.[0];
    if (!raw) return null;
    const standingRow = standings.find((row) => str(row.player_key) === playerId);
    return {
      id: str(raw.player_key),
      name: raw.player_name,
      fullName: raw.player_full_name ?? null,
      countryCode: raw.player_country ?? standingRow?.country ?? null,
      currentRank: standingRow ? parseInt(standingRow.place, 10) || null : null,
      tour: standingRow?.league ?? null,
      age: parseAgeFromBday(raw.player_bday),
      plays: null,
      // Historical-match fallback (for players outside the current standings) is applied by
      // `resolvePlayerProfile` in `playerIdentity.ts`, not here -- this provider stays a thin,
      // DB-free wrapper around the raw API (see predictionEngine calibration architecture memory).
      source: standingRow ? "live-standings" : undefined,
    };
  }

  async getPlayerMatches(playerId: string): Promise<MatchRecord[]> {
    const dateStop = new Date();
    // Extended from the original 365 days: with real tournament_key-based surface resolution now
    // covering nearly every tournament (see getTournamentSurfaceMap), same-surface sample sizes
    // for Challenger/ITF-heavy players are the real constraint on surface Elo confidence, not
    // stale data -- a wider window (~18 months) captures a full year-round surface rotation
    // (clay/grass/hard swings) plus a partial second cycle without reaching back so far that
    // matches meaningfully misrepresent current form (which recentForm/fatigue don't use this
    // full window for anyway -- they only look at the most-recent handful of matches/days).
    const dateStart = new Date(dateStop.getTime() - 548 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const [raw, surfaceByTournamentKey] = await Promise.all([
      this.cache.getOrFetch(`matches:${playerId}`, FIXTURES_TTL_MS, () =>
        // bulk: walk-forward / parlay-builder player-history fetches; uses the
        // bulk circuit breaker so timeouts here never trip the live-trading circuit.
        this.call<RawMatch[]>("bulk", "get_fixtures", {
          player_key: playerId,
          date_start: fmt(dateStart),
          date_stop: fmt(dateStop),
        }),
      ),
      this.getTournamentSurfaceMap(),
    ]);

    return (raw ?? [])
      .filter((m) => mapMatchStatus(m.event_status).finished && m.event_winner !== null)
      .map((m) => this.mapMatchRecord(m, playerId, surfaceByTournamentKey))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  private mapMatchRecord(raw: RawMatch, playerId: string, surfaceByTournamentKey: ReadonlyMap<string, Surface | null>): MatchRecord {
    const isFirstPlayer = str(raw.first_player_key) === playerId;
    const opponentId = isFirstPlayer ? str(raw.second_player_key) : str(raw.first_player_key);
    const { surface, level } = resolveSurfaceAndLevel({
      tournamentName: raw.tournament_name,
      tournamentKey: raw.tournament_key ? str(raw.tournament_key) : null,
      eventTypeType: raw.event_type_type,
      surfaceByTournamentKey,
    });
    const status = mapMatchStatus(raw.event_status);
    const won = (isFirstPlayer && raw.event_winner === "First Player") || (!isFirstPlayer && raw.event_winner === "Second Player");

    return {
      id: str(raw.event_key),
      date: raw.event_date,
      tournamentName: raw.tournament_name ?? null,
      tournamentLevel: level,
      round: raw.tournament_round ?? null,
      matchFormat: determineMatchFormat(raw.event_type_type, level),
      surface,
      indoor: surface === "IndoorHard" ? true : null,
      opponentId,
      opponentName: isFirstPlayer ? raw.event_second_player : raw.event_first_player,
      opponentRank: null,
      result: won ? "W" : "L",
      score: mapScoreString(raw),
      retired: status.retired,
      walkover: status.walkover,
      stats: mapStatistics(raw, playerId),
      opponentStats: mapStatistics(raw, opponentId),
      setGameMargins: mapSetGameMargins(raw, isFirstPlayer),
    };
  }

  private mapUpcomingFixture(m: RawMatch, surfaceByTournamentKey: Map<string, Surface | null>): Fixture {
    const { surface, level } = resolveSurfaceAndLevel({
      tournamentName: m.tournament_name,
      tournamentKey: m.tournament_key ? str(m.tournament_key) : null,
      eventTypeType: m.event_type_type,
      surfaceByTournamentKey,
    });
    const timezone = resolveTournamentTimezone(m.tournament_name);
    const scheduledStart = combineDateTimeUtc(m.event_date, m.event_time, timezone);
    // `m.event_winner === null` is already guaranteed by the caller's filter -- this fixture
    // hasn't finished. If its confirmed start time is in the past, it's in progress right now.
    const isLive = scheduledStart !== null && new Date(scheduledStart).getTime() < Date.now();
    return {
      id: str(m.event_key),
      date: m.event_date,
      scheduledStart,
      timeConfirmed: scheduledStart !== null,
      isLive,
      tournamentName: m.tournament_name ?? null,
      tournamentLevel: level,
      round: m.tournament_round ?? null,
      surface,
      indoor: surface === "IndoorHard" ? true : null,
      matchFormat: determineMatchFormat(m.event_type_type, level),
      player1Id: str(m.first_player_key),
      player1Name: m.event_first_player,
      player2Id: str(m.second_player_key),
      player2Name: m.event_second_player,
    };
  }

  async getUpcomingFixtures(date: string): Promise<Fixture[]> {
    return this.getUpcomingFixturesRange(date, date);
  }

  /**
   * Same as `getUpcomingFixtures`, but for a whole date range in one provider round trip.
   * Confirmed live (2026-07-11, see `getCompletedMatchesByDateRange` below): `get_fixtures`
   * accepts a plain `date_start`/`date_stop` window and returns every match across that whole
   * span, so a caller that needs several days (e.g. the upcoming-matches window widening through
   * a sparse/off-season stretch) can fetch them in a single call instead of one call per day.
   * Cached by the exact `dateStart:dateStop` key -- callers should request the same aligned
   * batches repeatedly (rather than arbitrary ad hoc ranges) to get real cache reuse.
   */
  async getUpcomingFixturesRange(dateStart: string, dateStop: string, opts?: { bypassCache?: boolean }): Promise<Fixture[]> {
    const [raw, surfaceByTournamentKey] = await Promise.all([
      this.cache.getOrFetch(
        `fixtures:${dateStart}:${dateStop}`,
        FIXTURES_TTL_MS,
        () => this.call<RawMatch[]>("live", "get_fixtures", { date_start: dateStart, date_stop: dateStop }),
        { bypass: opts?.bypassCache },
      ),
      this.getTournamentSurfaceMap(),
    ]);

    return (raw ?? [])
      .filter((m) => m.event_winner === null)
      // Drop doubles fixtures — tournament names include "Doubles" and the
      // prediction engine is singles-only.
      .filter((m) => !/doubles/i.test(m.tournament_name ?? ""))
      .filter((m) => !m.event_first_player?.includes("/") && !m.event_second_player?.includes("/"))
      .map((m) => this.mapUpcomingFixture(m, surfaceByTournamentKey));
  }

  /**
   * Real-time set/game scores for a specific set of already-live fixture ids (see
   * `TennisDataProvider.getLiveScores`). API-Tennis has no "fetch by event_key list" call, so
   * this re-uses `get_fixtures` over a generous yesterday-to-tomorrow window (any fixture that is
   * genuinely still live per `Fixture.isLive`'s own definition -- confirmed-started, no winner
   * yet -- must fall in this window, since matches don't span more than ~2 calendar days), then
   * filters down to just the requested ids. Cached under its own short `LIVE_SCORE_TTL_MS` key so
   * frequent polling here never touches (or is throttled by) the 5-minute general fixtures cache.
   */
  async getLiveScores(fixtureIds: string[]): Promise<Map<string, LiveScore>> {
    const result = new Map<string, LiveScore>();
    if (fixtureIds.length === 0) return result;

    const wantedIds = new Set(fixtureIds);
    const now = new Date();
    const dateStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateStop = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const raw = await this.cache.getOrFetch(`live-scores:${dateStart}:${dateStop}`, LIVE_SCORE_TTL_MS, () =>
      this.call<RawMatch[]>("live", "get_fixtures", { date_start: dateStart, date_stop: dateStop }),
    );

    for (const m of raw ?? []) {
      const id = str(m.event_key);
      if (!wantedIds.has(id)) continue;
      result.set(id, { sets: mapLiveScoreSets(m), statusText: m.event_status || null });
    }
    return result;
  }

  /**
   * Bulk date-range pull for the historical backfill pipeline. Confirmed live (2026-07-11):
   * `get_fixtures` accepts a plain `date_start`/`date_stop` window with no `player_key`, and
   * returns every match across all tours/levels in that window (real data verified back to at
   * least 2010; ranges of ~3 weeks return successfully, but very large ranges (~1 month+) have
   * been observed to fail/time out, so callers should chunk into short windows).
   */
  async getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]> {
    const [raw, surfaceByTournamentKey] = await Promise.all([
      // bulk: historical backfill date-range pull; isolated from live-trading circuit.
      this.call<RawMatch[]>("bulk", "get_fixtures", { date_start: dateStart, date_stop: dateStop }),
      this.getTournamentSurfaceMap(),
    ]);

    return (raw ?? [])
      .map((m) => {
        const status = mapMatchStatus(m.event_status);
        const isCancelled = /cancel|postpone/i.test(m.event_status);
        // Only keep matches with a definitive terminal outcome -- exclude anything still
        // scheduled/live, which should not appear in a past date range but is guarded anyway.
        if (!status.finished && !isCancelled) return null;

        const { surface, level } = resolveSurfaceAndLevel({
          tournamentName: m.tournament_name,
          tournamentKey: m.tournament_key ? str(m.tournament_key) : null,
          eventTypeType: m.event_type_type,
          surfaceByTournamentKey,
        });
        const winnerId =
          m.event_winner === "First Player"
            ? str(m.first_player_key)
            : m.event_winner === "Second Player"
              ? str(m.second_player_key)
              : null;

        // Extract indoor flag: use provider's field when present (truthy 1/true = indoor),
        // fall back to the "IndoorHard" surface inference only when the flag is absent.
        const rawIndoor = m.indoor;
        const indoor: boolean | null =
          rawIndoor != null
            ? rawIndoor === 1 || rawIndoor === true
            : surface === "IndoorHard"
              ? true
              : null;

        // Extract player ranks when the provider includes them; parse defensively (API-Tennis
        // is known to return numeric keys as strings or numbers interchangeably).
        const rawP1Rank = m.first_player_rank;
        const player1Rank: number | null =
          rawP1Rank != null ? (parseInt(String(rawP1Rank), 10) || null) : null;
        const rawP2Rank = m.second_player_rank;
        const player2Rank: number | null =
          rawP2Rank != null ? (parseInt(String(rawP2Rank), 10) || null) : null;

        const fixture: HistoricalFixture = {
          id: str(m.event_key),
          provider: this.name,
          date: m.event_date,
          time: m.event_time ?? null,
          tour: deriveTour(m.event_type_type),
          tournamentName: m.tournament_name ?? null,
          tournamentLevel: level,
          round: m.tournament_round ?? null,
          surface,
          matchFormat: determineMatchFormat(m.event_type_type, level),
          player1Id: str(m.first_player_key),
          player1Name: m.event_first_player,
          player2Id: str(m.second_player_key),
          player2Name: m.event_second_player,
          winnerId,
          score: mapScoreString(m),
          retired: status.retired,
          walkover: status.walkover,
          cancelled: isCancelled,
          setGameMargins: mapHistoricalFixtureGameMargins(m),
          indoor,
          player1Rank,
          player2Rank,
          raw: m,
        };
        return fixture;
      })
      .filter((f): f is HistoricalFixture => f !== null);
  }

  async getHeadToHead(player1Id: string, player2Id: string): Promise<HeadToHeadRecord> {
    const [raw, surfaceByTournamentKey] = await Promise.all([
      this.cache.getOrFetch(`h2h:${player1Id}:${player2Id}`, FIXTURES_TTL_MS, () =>
        this.call<{ H2H: RawMatch[] }>("live", "get_H2H", {
          first_player_key: player1Id,
          second_player_key: player2Id,
        }),
      ),
      this.getTournamentSurfaceMap(),
    ]);

    const meetings = (raw?.H2H ?? [])
      .filter((m) => mapMatchStatus(m.event_status).finished && m.event_winner !== null)
      .map((m) => {
        const { surface } = resolveSurfaceAndLevel({
          tournamentName: m.tournament_name,
          tournamentKey: m.tournament_key ? str(m.tournament_key) : null,
          eventTypeType: m.event_type_type,
          surfaceByTournamentKey,
        });
        const winnerId = m.event_winner === "First Player" ? str(m.first_player_key) : str(m.second_player_key);
        return {
          date: m.event_date,
          tournamentName: m.tournament_name ?? null,
          surface,
          score: mapScoreString(m),
          winnerId,
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return { player1Id, player2Id, meetings };
  }
}
