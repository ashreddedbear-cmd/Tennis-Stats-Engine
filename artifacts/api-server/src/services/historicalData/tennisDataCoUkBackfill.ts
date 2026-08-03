/**
 * tennis-data.co.uk historical backfill.
 *
 * Downloads tennis-data.co.uk XLSX files (ATP + WTA) and inserts their match records
 * into historical_matches via the existing backfill infrastructure, so feature snapshots,
 * Elo state, and idempotency work identically to the API-Tennis and Sackmann paths.
 *
 * URL patterns (both follow HTTP 301 redirects automatically — no auth required):
 *   ATP: http://www.tennis-data.co.uk/{year}/{year}.xlsx
 *   WTA: http://www.tennis-data.co.uk/{year}w/{year}.xlsx → redirects to /{year}w/{year}.xlsx
 *
 * Primary value over Sackmann: each row includes embedded market odds from multiple
 * bookmakers (B365, Pinnacle, market average/max). These are stored in the raw_source JSONB
 * column under the _marketOdds key and are the main input for calibration refit and
 * market-verification backtesting (Phase 5 item 2).
 *
 * Query market odds in SQL:
 *   WHERE provider = 'tennis-data-co-uk'
 *   AND (raw_source->'_marketOdds'->>'avgWinner')::float IS NOT NULL
 *
 * Column layout confirmed from live files (2023):
 *   ATP: ATP | Location | Tournament | Date | Series | Court | Surface | Round |
 *        Best of | Winner | Loser | WRank | LRank | WPts | LPts |
 *        W1..W5 | L1..L5 | Wsets | Lsets | Comment |
 *        B365W | B365L | PSW | PSL | MaxW | MaxL | AvgW | AvgL
 *   WTA: same but first col = WTA, Series column = Tier, max 3 sets (W1..W3 / L1..L3)
 *
 * Date column: Excel serial integer (e.g. 44927 = 2023-01-09).
 * Comment column: "Completed" | "Retired" | "" (walkover).
 * Winner is always player1 (same convention as Sackmann).
 *
 * Rules per Phase 5 plan:
 *   - Runs as a triggered backfill job, not a live call during a prediction.
 *   - Writes into existing tables (historical_matches + match_feature_snapshots).
 *   - Returns null for any field the source doesn't supply — no fabrication.
 */

import { runHistoricalBackfill } from "./backfill";
import type { BackfillSummary } from "./types";
import { ProviderUnavailableError } from "../tennisData/types";
import type {
  TennisDataProvider,
  HistoricalFixture,
  Surface,
  TournamentLevel,
  MatchFormat,
  PlayerSummary,
  PlayerProfile,
  MatchRecord,
  Fixture,
  HeadToHeadRecord,
  LiveScore,
} from "../tennisData/types";
import { logger } from "../../lib/logger";
import * as XLSX from "xlsx";

export const TENNIS_DATA_CO_UK_PROVIDER = "tennis-data-co-uk";

const FETCH_TIMEOUT_MS = 30_000;

// ── Date parsing ──────────────────────────────────────────────────────────────

/**
 * Convert an Excel serial date to YYYY-MM-DD.
 * tennis-data.co.uk stores dates as Excel integers (e.g. 44927 = 2023-01-09).
 * Formula: (serial − 25569) days from Unix epoch (1970-01-01).
 * The 25569 offset bridges Excel's epoch (1900-01-01 with leap-year bug) to Unix.
 */
function excelSerialToIso(serial: number): string {
  const ms  = (serial - 25569) * 86_400_000;
  const d   = new Date(ms);
  const y   = d.getUTCFullYear();
  const m   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseTdDate(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (Number.isFinite(n) && n > 1000) return excelSerialToIso(n);
  const s = String(val).trim();
  // DD/MM/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ── Type mappings ─────────────────────────────────────────────────────────────

function mapSurface(raw: unknown): Surface | null {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "hard" || s === "hardcourt") return "Hard";
  if (s === "clay")                       return "Clay";
  if (s === "grass")                      return "Grass";
  if (s === "carpet" || s.includes("indoor hard")) return "IndoorHard";
  return null;
}

/** ATP: Series column — e.g. "ATP250", "Masters 1000", "Grand Slam". */
function mapAtpSeries(raw: unknown): TournamentLevel | null {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s.includes("grand slam"))                                 return "GrandSlam";
  if (s.includes("masters 1000") || s === "atp finals")        return "Masters1000";
  if (s.includes("500") || s === "atp500")                     return "ATP500";
  if (s.includes("250") || s === "atp250")                     return "ATP250";
  if (s.includes("challenger"))                                 return "Challenger";
  if (s.includes("itf"))                                        return "ITF";
  return null;
}

/** WTA: Tier column — e.g. "WTA500", "WTA1000", "Grand Slam". */
function mapWtaTier(raw: unknown): TournamentLevel | null {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s.includes("grand slam"))                                          return "GrandSlam";
  if (s.includes("1000") || s.includes("premier mandatory") || s.includes("wta finals")) return "WTA1000";
  if (s.includes("500"))                                                 return "WTA500";
  if (s.includes("250") || s.includes("international"))                 return "WTA250";
  if (s.includes("125") || s.includes("challenger"))                    return "Challenger";
  if (s.includes("itf"))                                                 return "ITF";
  return null;
}

function mapRound(raw: unknown): string | null {
  const r = String(raw ?? "").trim();
  if (!r) return null;
  if (/1st/i.test(r))                          return "R128";
  if (/2nd/i.test(r))                          return "R64";
  if (/3rd/i.test(r))                          return "R32";
  if (/4th/i.test(r))                          return "R16";
  if (/quarter/i.test(r))                      return "QF";
  if (/semi/i.test(r))                         return "SF";
  if (/\bfinal\b/i.test(r) && !/semi/i.test(r)) return "F";
  if (/round.?robin/i.test(r))                 return "RR";
  return r;
}

function numOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Decimal odds must be > 1.0 to be valid. */
function oddsOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 1.0 ? Math.round(n * 10000) / 10000 : null;
}

// ── Score / set-margin helpers ────────────────────────────────────────────────

/**
 * Reconstruct a score string from W1/L1…W5/L5 columns.
 * tennis-data.co.uk stores sets individually, not as a combined string.
 * Winner's games are always first (player1 = winner convention).
 */
function buildScoreString(
  row: Record<string, unknown>,
  retired: boolean,
  walkover: boolean,
): string | null {
  if (walkover) return "W/O";
  const sets: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const w = row[`W${i}`];
    const l = row[`L${i}`];
    if (w === null || w === "" || w === undefined) break;
    if (l === null || l === "" || l === undefined) break;
    const wn = Number(w);
    const ln = Number(l);
    if (!Number.isFinite(wn) || !Number.isFinite(ln)) break;
    sets.push(`${Math.round(wn)}-${Math.round(ln)}`);
  }
  if (sets.length === 0) return null;
  return sets.join(" ") + (retired ? " RET" : "");
}

function parseSetMarginsFromRow(
  row: Record<string, unknown>,
): Array<{ player1Games: number; player2Games: number }> {
  const margins: Array<{ player1Games: number; player2Games: number }> = [];
  for (let i = 1; i <= 5; i++) {
    const w = row[`W${i}`];
    const l = row[`L${i}`];
    if (w === null || w === "" || w === undefined) break;
    if (l === null || l === "" || l === undefined) break;
    const wn = Math.round(Number(w));
    const ln = Math.round(Number(l));
    if (!Number.isFinite(wn) || !Number.isFinite(ln)) break;
    margins.push({ player1Games: wn, player2Games: ln });
  }
  return margins;
}

// ── Row normalisation ─────────────────────────────────────────────────────────

function normalizeKey(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function rowToFixture(
  row: Record<string, unknown>,
  tour: "ATP" | "WTA",
): HistoricalFixture | null {
  const winner = String(row.Winner ?? "").trim();
  const loser  = String(row.Loser  ?? "").trim();
  if (!winner || !loser || winner === loser) return null;

  const dateStr = parseTdDate(row.Date);
  if (!dateStr) return null;

  const tournament = String(row.Tournament ?? "").trim();
  const roundRaw   = String(row.Round ?? "").trim();
  if (!tournament || !roundRaw) return null;

  // Stable external ID — scoped to provider, survives repeated runs
  const winnerKey     = normalizeKey(winner);
  const loserKey      = normalizeKey(loser);
  const tournamentKey = normalizeKey(tournament);
  const roundKey      = normalizeKey(roundRaw);
  // Include YYYY-MM to handle same-name tournaments in different months (e.g. dual clay events)
  const externalId    = `${dateStr.slice(0, 7)}_${tournamentKey}_${roundKey}_${winnerKey}_${loserKey}`;

  // ATP file has "Series" column; WTA file has "Tier" column
  const seriesOrTier = String(tour === "ATP" ? (row.Series ?? "") : (row.Tier ?? "")).trim();
  const level        = tour === "ATP" ? mapAtpSeries(seriesOrTier) : mapWtaTier(seriesOrTier);
  const surface      = mapSurface(row.Surface);
  const bestOf: MatchFormat = String(row["Best of"] ?? "3") === "5" ? "BestOf5" : "BestOf3";
  const round        = mapRound(roundRaw);

  // Winner is always player1 (same convention as Sackmann)
  const p1Id = `${TENNIS_DATA_CO_UK_PROVIDER}-${winnerKey}`;
  const p2Id = `${TENNIS_DATA_CO_UK_PROVIDER}-${loserKey}`;

  const comment    = String(row.Comment ?? "").toLowerCase();
  const isRetired  = comment.includes("retired");
  const isWalkover = comment.includes("walkover") || comment.includes("w/o") || comment === "w/o";
  const retired    = isRetired && !isWalkover;
  const walkover   = isWalkover;

  const score          = buildScoreString(row, retired, walkover);
  const setGameMargins = parseSetMarginsFromRow(row);

  // Market odds — stored in raw_source JSONB under _marketOdds.
  // AvgW/AvgL are the consensus market prices; most reliable for calibration.
  // Query: (raw_source->'_marketOdds'->>'avgWinner')::float
  const marketOdds = {
    b365Winner:     oddsOrNull(row.B365W),
    b365Loser:      oddsOrNull(row.B365L),
    pinnacleWinner: oddsOrNull(row.PSW),
    pinnacleLooser: oddsOrNull(row.PSL),
    maxWinner:      oddsOrNull(row.MaxW),
    maxLoser:       oddsOrNull(row.MaxL),
    avgWinner:      oddsOrNull(row.AvgW),
    avgLoser:       oddsOrNull(row.AvgL),
  };

  const isIndoor = String(row.Court ?? "").toLowerCase().includes("indoor");

  return {
    id:              externalId,
    provider:        TENNIS_DATA_CO_UK_PROVIDER,
    date:            dateStr,
    time:            null,
    tour,
    tournamentName:  tournament,
    tournamentLevel: level,
    round,
    surface,
    matchFormat:     bestOf,
    player1Id:       p1Id,
    player1Name:     winner,
    player2Id:       p2Id,
    player2Name:     loser,
    winnerId:        p1Id,
    score,
    retired,
    walkover,
    cancelled:       false,
    setGameMargins,
    indoor:          isIndoor || null,
    player1Rank:     numOrNull(row.WRank),
    player2Rank:     numOrNull(row.LRank),
    raw:             { ...row, _marketOdds: marketOdds },
  };
}

// ── XLSX fetching ─────────────────────────────────────────────────────────────

async function fetchXlsx(url: string): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:   controller.signal,
      redirect: "follow", // handles the 301 tennis-data.co.uk uses for some years
      headers:  { "User-Agent": "TennisMatrix-Backfill/1.0" },
    });
    if (res.status === 404 || res.status === 410) return [];
    if (!res.ok) {
      logger.warn({ status: res.status, url }, "tennisDataCoUkBackfill: fetch failed (non-fatal)");
      return [];
    }
    const buffer   = Buffer.from(await res.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    // raw: true (default) keeps numeric types intact — important for date serials and odds.
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  } catch (err) {
    logger.warn({ err, url }, "tennisDataCoUkBackfill: error fetching xlsx (non-fatal)");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── TennisDataProvider wrapper ────────────────────────────────────────────────

/**
 * Wraps a pre-loaded array of HistoricalFixtures so that the existing
 * runHistoricalBackfill infrastructure can consume tennis-data.co.uk data.
 * Only getCompletedMatchesByDateRange is meaningful; all other methods
 * throw ProviderUnavailableError because runHistoricalBackfill never calls them.
 */
class TennisDataCoUkProvider implements TennisDataProvider {
  readonly name = "TennisDataCoUkProvider";
  private readonly fixtures: HistoricalFixture[];

  constructor(fixtures: HistoricalFixture[]) { this.fixtures = fixtures; }

  async getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]> {
    return this.fixtures.filter((f) => f.date >= dateStart && f.date <= dateStop);
  }

  private _unavailable(method: string): never {
    throw new ProviderUnavailableError(`TennisDataCoUkProvider does not implement ${method}`);
  }
  getStatus() {
    return { provider: TENNIS_DATA_CO_UK_PROVIDER, connected: true, lastSuccessfulCallAt: null, lastError: null };
  }
  async searchPlayers():            Promise<PlayerSummary[]>            { return this._unavailable("searchPlayers"); }
  async getPlayer():                Promise<PlayerProfile | null>        { return this._unavailable("getPlayer"); }
  async getPlayerMatches():         Promise<MatchRecord[]>               { return this._unavailable("getPlayerMatches"); }
  async getUpcomingFixtures():      Promise<Fixture[]>                   { return this._unavailable("getUpcomingFixtures"); }
  async getUpcomingFixturesRange(): Promise<Fixture[]>                   { return this._unavailable("getUpcomingFixturesRange"); }
  async getHeadToHead():            Promise<HeadToHeadRecord>            { return this._unavailable("getHeadToHead"); }
  async getLiveScores():            Promise<Map<string, LiveScore>>      { return this._unavailable("getLiveScores"); }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TennisDataCoUkBackfillOptions {
  /**
   * First year to import. Defaults to 2015.
   * Confirmed available as .xlsx from 2015; earlier years may use .xls and return 301
   * redirects to a different file — they are skipped silently on fetch failure.
   */
  startYear?: number;
  /** Last year (inclusive). Defaults to current calendar year. */
  endYear?: number;
  /** Which tours to include. Defaults to both. */
  tours?: Array<"atp" | "wta">;
}

export interface TennisDataCoUkBackfillSummary {
  atpYearsLoaded: number;
  wtaYearsLoaded: number;
  fixturesLoaded: number;
  /** Fixtures with at least AvgW/AvgL consensus odds — primary calibration signal. */
  fixturesWithOdds: number;
  backfill: BackfillSummary;
}

/**
 * Downloads tennis-data.co.uk XLSX files for the requested year range, maps each row to
 * a HistoricalFixture, then calls runHistoricalBackfill so all feature snapshots, Elo
 * state, and idempotency guarantees are identical to the live-provider path.
 *
 * Market odds from every bookmaker column are stored in raw_source JSONB under _marketOdds.
 * No new DB columns are needed — use JSONB extraction to query them.
 */
export async function runTennisDataCoUkBackfill(
  options: TennisDataCoUkBackfillOptions = {},
): Promise<TennisDataCoUkBackfillSummary> {
  const currentYear = new Date().getFullYear();
  const startYear   = options.startYear ?? 2015;
  const endYear     = options.endYear   ?? currentYear;
  const tours       = options.tours     ?? ["atp", "wta"];

  if (startYear > endYear) throw new Error(`startYear (${startYear}) > endYear (${endYear})`);

  const allFixtures:   HistoricalFixture[] = [];
  let atpYearsLoaded   = 0;
  let wtaYearsLoaded   = 0;
  let fixturesWithOdds = 0;

  const years      = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i);
  const concurrency = 4;

  for (let i = 0; i < years.length; i += concurrency) {
    const batch = years.slice(i, i + concurrency);
    await Promise.all(
      batch.flatMap((year) =>
        tours.map(async (tour) => {
          // ATP: /{year}/{year}.xlsx — WTA: /{year}w/{year}.xlsx (server issues 301 for some years)
          const url = tour === "atp"
            ? `http://www.tennis-data.co.uk/${year}/${year}.xlsx`
            : `http://www.tennis-data.co.uk/${year}w/${year}.xlsx`;
          const tourLabel: "ATP" | "WTA" = tour === "atp" ? "ATP" : "WTA";

          const rows = await fetchXlsx(url);
          if (rows.length === 0) {
            logger.debug({ url, year, tour }, "tennisDataCoUkBackfill: no rows (year may not be available)");
            return;
          }

          let loaded   = 0;
          let withOdds = 0;
          for (const row of rows) {
            const fixture = rowToFixture(row, tourLabel);
            if (!fixture) continue;
            allFixtures.push(fixture);
            loaded++;
            const mo = (fixture.raw as Record<string, unknown>)?._marketOdds as
              { avgWinner: number | null } | undefined;
            if (mo?.avgWinner !== null && mo?.avgWinner !== undefined) withOdds++;
          }
          fixturesWithOdds += withOdds;
          logger.info(
            { url, year, tour, rows: rows.length, fixtures: loaded, withOdds },
            "tennisDataCoUkBackfill: year loaded",
          );
          if (tour === "atp") atpYearsLoaded++;
          else                wtaYearsLoaded++;
        }),
      ),
    );
  }

  if (allFixtures.length === 0) {
    logger.warn({ startYear, endYear, tours }, "tennisDataCoUkBackfill: no fixtures loaded");
    const emptyDate = `${startYear}-01-01`;
    return {
      atpYearsLoaded: 0, wtaYearsLoaded: 0, fixturesLoaded: 0, fixturesWithOdds: 0,
      backfill: {
        dateStart: emptyDate, dateStop: `${endYear}-12-31`,
        cutoff: "1h", cutoffMinutes: 60,
        fixturesFetched: 0, matchesInserted: 0, matchesSkippedDuplicate: 0,
        matchesSkippedNoTerminalResult: 0, matchesRecomputed: 0, featureRowsInserted: 0,
        byTour: {}, bySurface: {}, byYear: {},
        earliestImportedMatchDate: null, latestImportedMatchDate: null,
        dateGapsOver30Days: [], durationMs: 0,
      } satisfies BackfillSummary,
    };
  }

  allFixtures.sort((a, b) => a.date.localeCompare(b.date));
  const dateStart = allFixtures[0].date;
  const dateStop  = allFixtures[allFixtures.length - 1].date;

  logger.info(
    { fixturesLoaded: allFixtures.length, fixturesWithOdds, atpYearsLoaded, wtaYearsLoaded, dateStart, dateStop },
    "tennisDataCoUkBackfill: all xlsx files loaded, starting historical backfill",
  );

  const provider = new TennisDataCoUkProvider(allFixtures);
  const backfill = await runHistoricalBackfill(
    provider as unknown as Parameters<typeof runHistoricalBackfill>[0],
    { dateStart, dateStop, cutoff: "1h", chunkDays: 30 },
  );

  return { atpYearsLoaded, wtaYearsLoaded, fixturesLoaded: allFixtures.length, fixturesWithOdds, backfill };
}
