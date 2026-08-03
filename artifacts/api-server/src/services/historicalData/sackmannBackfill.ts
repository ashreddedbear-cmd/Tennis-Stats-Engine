/**
 * Sackmann historical backfill.
 *
 * Downloads Jeff Sackmann's tennis_atp / tennis_wta GitHub CSVs and inserts their match records
 * into historical_matches via the existing backfill infrastructure (so feature snapshots, Elo
 * state, and idempotency all work exactly as they do for API-Tennis data).
 *
 * Sources (main-draw):
 *  ATP: https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_YYYY.csv
 *  WTA: https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_YYYY.csv
 *
 * Sources (Challenger / qualifying / ITF — enabled by default via includeChallengerItf option):
 *  ATP: https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_qual_chall_YYYY.csv
 *  WTA: https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_qual_itf_YYYY.csv
 *
 * These supplementary files share the same schema as the main-draw files so the same parser
 * applies. The ATP file contains ATP Challenger events AND qualifying-round matches at main-tour
 * events (tagged by the parent tournament's level code). The WTA file contains WTA ITF events
 * AND qualifying rounds.
 *
 * External calls made per run: one HTTP GET per CSV file (year × tour × file variant). No auth
 * required. All CSV data is fetched up-front and cached in memory for the duration of the run;
 * the provider's `getCompletedMatchesByDateRange` simply filters the in-memory array, so the
 * existing 5-day-chunk pattern in runHistoricalBackfill stays fully intact.
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

// ── Constants ─────────────────────────────────────────────────────────────────

export const SACKMANN_PROVIDER = "sackmann";

// Public mirror: farhadGithub/tennis-atp-data (ATP main-draw 1968–2024, exact Sackmann schema).
// Confirmed reachable from Replit via both raw.githubusercontent.com and api.github.com/contents/.
const FARHAD_ATP_MIRROR_BASE = "https://raw.githubusercontent.com/farhadGithub/tennis-atp-data/master/data/raw";

// Original Sackmann repos (private — require a PAT that has collaborator access on JeffSackmann's repos).
// Used for ATP Challenger/qualifying files (no public mirror exists for those) and all WTA files.
// Gracefully returns [] on 404 so missing years are silently skipped.
const ATP_BASE_URL = "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master";
const WTA_BASE_URL = "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master";

// Kaggle mirror sources (public datasets, exact Sackmann column format).
// Requires KAGGLE_API_TOKEN env var with download permission.
//   ATP main-draw: 2000-2017  (gmadevs/atp-matches-dataset)
//   WTA main-draw: 2000-2016  (gmadevs/wta-matches)
// Qual/Challenger files are not mirrored on Kaggle — those still require GITHUB_PAT.
const KAGGLE_ATP_DATASET = "gmadevs/atp-matches-dataset";
const KAGGLE_WTA_DATASET = "gmadevs/wta-matches";

const FETCH_TIMEOUT_MS = 30_000;

// ── CSV parsing ───────────────────────────────────────────────────────────────

/** Minimal RFC-4180-compatible CSV row parser. */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvRow(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = values[j]?.trim() ?? "";
    }
    rows.push(row);
  }
  return rows;
}

// ── Type mappings ─────────────────────────────────────────────────────────────

function mapSurface(raw: string): Surface | null {
  const s = raw.toLowerCase();
  if (s === "hard") return "Hard";
  if (s === "clay") return "Clay";
  if (s === "grass") return "Grass";
  if (s === "carpet") return "IndoorHard"; // Carpet was indoor hard equivalent
  return null;
}

function mapAtpLevel(level: string, drawSize: number): TournamentLevel | null {
  switch (level) {
    case "G": return "GrandSlam";
    case "M": return "Masters1000";
    case "F": return "Masters1000"; // ATP Finals — closest bucket
    case "A": return drawSize >= 56 ? "ATP500" : "ATP250";
    case "C": return "Challenger";
    case "S": return "ITF";
    default:  return null; // Davis Cup "D", Laver Cup, etc.
  }
}

function mapWtaLevel(level: string): TournamentLevel | null {
  switch (level) {
    case "G":  return "GrandSlam";
    case "P":
    case "PM": return "WTA1000";    // Premier / Premier Mandatory
    case "I":  return "WTA500";     // International (main-draw file usage)
    case "F":  return "WTA1000";    // WTA Finals
    case "C":  return "Challenger";
    case "S":  return "ITF";
    // Codes that appear in the wta_matches_qual_itf files:
    // "ITF" prefix levels (e.g. "ITF", "Q") — stored as the tournament type in those files.
    // Map them to ITF; any unrecognised code returns null but the match is still imported.
    case "Q":  return "ITF";        // Qualifying events / ITF circuits in WTA qual file
    case "2":  return "ITF";        // ITF W15/W25 level codes used in older qual files
    case "3":  return "ITF";        // ITF W40/W60
    default:   return null;
  }
}

/** Parse set-by-set game margins from a Sackmann score string (winner is always player1). */
function parseSetMargins(score: string): Array<{ player1Games: number; player2Games: number }> {
  if (!score || /^(W\/O|DEF\.?|BYE|UNK)$/i.test(score.trim())) return [];
  const result: Array<{ player1Games: number; player2Games: number }> = [];
  for (const token of score.trim().split(/\s+/)) {
    const m = token.match(/^(\d+)-(\d+)/);
    if (m) {
      result.push({ player1Games: parseInt(m[1]), player2Games: parseInt(m[2]) });
    }
  }
  return result;
}

/** Convert Sackmann tourney_date (YYYYMMDD string) to YYYY-MM-DD. */
function sackmannDateToIso(raw: string): string | null {
  if (!raw || raw.length < 8) return null;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const candidate = `${y}-${m}-${d}`;
  return Number.isNaN(Date.parse(candidate)) ? null : candidate;
}

function intOrNull(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Row → HistoricalFixture ───────────────────────────────────────────────────

function rowToFixture(
  row: Record<string, string>,
  tour: "ATP" | "WTA",
): HistoricalFixture | null {
  const tourneyDate = sackmannDateToIso(row.tourney_date);
  if (!tourneyDate) return null;

  const winnerId = row.winner_id?.trim();
  const loserId  = row.loser_id?.trim();
  if (!winnerId || !loserId || !row.match_num?.trim()) return null;

  const externalId = `${row.tourney_id?.trim() ?? "?"}-${row.match_num.trim()}`;
  const score = row.score?.trim() ?? null;
  const isRetired   = !!score && /ret/i.test(score);
  const isWalkover  = !!score && /w\/o|walkover/i.test(score);
  const drawSize    = parseInt(row.draw_size ?? "0", 10) || 0;
  const level       = tour === "ATP"
    ? mapAtpLevel(row.tourney_level ?? "", drawSize)
    : mapWtaLevel(row.tourney_level ?? "");
  const bestOf      = row.best_of?.trim() === "5" ? "BestOf5" : "BestOf3" as MatchFormat;
  // In Sackmann: winner is always "player1" (id / name comes from winner_* columns)
  const p1Id   = `${SACKMANN_PROVIDER}-${winnerId}`;
  const p2Id   = `${SACKMANN_PROVIDER}-${loserId}`;
  const p1Name = row.winner_name?.trim() ?? "";
  const p2Name = row.loser_name?.trim() ?? "";

  return {
    id: externalId,
    provider: SACKMANN_PROVIDER,
    date: tourneyDate,
    time: null,
    tour,
    tournamentName: row.tourney_name?.trim() || null,
    tournamentLevel: level,
    round: row.round?.trim() || null,
    surface: mapSurface(row.surface ?? ""),
    matchFormat: bestOf,
    player1Id: p1Id,
    player1Name: p1Name,
    player2Id: p2Id,
    player2Name: p2Name,
    winnerId: p1Id, // winner is always player1 in Sackmann
    score,
    retired: isRetired,
    walkover: isWalkover,
    cancelled: false,
    setGameMargins: parseSetMargins(score ?? ""),
    indoor: null,
    player1Rank: intOrNull(row.winner_rank ?? ""),
    player2Rank: intOrNull(row.loser_rank ?? ""),
    raw: row,
  };
}

// ── CSV fetching ──────────────────────────────────────────────────────────────

/**
 * Convert a raw.githubusercontent.com URL to its api.github.com/repos/.../contents/ equivalent.
 * Returns null if the URL doesn't match the expected pattern.
 *
 * raw:  https://raw.githubusercontent.com/OWNER/REPO/BRANCH/path/file.csv
 * api:  https://api.github.com/repos/OWNER/REPO/contents/path/file.csv
 *
 * api.github.com is confirmed reachable from Replit's sandbox (returns HTTP 200 for public
 * endpoints), while raw.githubusercontent.com consistently 404s for private repos — even with
 * an Authorization header that would otherwise be valid.  The api.github.com contents endpoint
 * with `Accept: application/vnd.github.v3.raw` streams raw file content (no base64 encoding).
 */
function rawUrlToContentsUrl(rawUrl: string): string | null {
  const m = rawUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!m) return null;
  const [, owner, repo, , filepath] = m;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${filepath}`;
}

/**
 * Download a single CSV from GitHub.
 *
 * Strategy (in order):
 *   1. When GITHUB_PAT is set: use api.github.com/repos/.../contents/ with
 *      `Accept: application/vnd.github.v3.raw` — confirmed reachable from Replit even when
 *      raw.githubusercontent.com returns 404 for private repos.
 *   2. Fallback: raw.githubusercontent.com — works for truly public repos with no auth,
 *      or when the PAT URL transform above is not applicable.
 *
 * Returns [] on 404 so callers silently skip unavailable years.
 */
async function fetchCsvFromGitHub(url: string): Promise<Record<string, string>[]> {
  const pat = process.env.GITHUB_PAT;

  // ── Attempt 1: api.github.com/repos/.../contents/ (preferred when PAT is available) ──
  if (pat) {
    const contentsUrl = rawUrlToContentsUrl(url);
    if (contentsUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(contentsUrl, {
          signal: controller.signal,
          headers: {
            Authorization: `token ${pat}`,
            Accept: "application/vnd.github.v3.raw",
            "User-Agent": "TennisMatrix-Backfill/1.0",
          },
        });
        if (res.status === 404) return []; // Year not in repo
        if (res.ok) {
          const text = await res.text();
          return parseCsv(text);
        }
        logger.warn(
          { status: res.status, contentsUrl },
          "sackmannBackfill: api.github.com/contents fetch failed — falling back to raw URL",
        );
      } catch (err) {
        logger.warn({ err, contentsUrl }, "sackmannBackfill: api.github.com/contents error — falling back");
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // ── Attempt 2: raw.githubusercontent.com (works for public repos; PAT auth added if set) ──
  const headers: Record<string, string> = { "User-Agent": "TennisMatrix-Backfill/1.0" };
  if (pat) headers["Authorization"] = `token ${pat}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 404) return []; // Year not yet available or repo private
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return parseCsv(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a single CSV from Kaggle.
 * Requires `KAGGLE_API_TOKEN` env var with download permissions.
 * Known public mirrors:
 *   - gmadevs/atp-matches-dataset  → atp_matches_YYYY.csv  (2000–2017)
 *   - gmadevs/wta-matches           → wta_matches_YYYY.csv  (2000–2016)
 * Returns [] if the token is absent, if the file isn't in the dataset, or
 * if the download is rejected (e.g. read-only token).
 */
async function fetchCsvFromKaggle(kaggleDataset: string, filename: string): Promise<Record<string, string>[]> {
  const token = process.env.KAGGLE_API_TOKEN;
  if (!token) return [];

  const url = `https://www.kaggle.com/api/v1/datasets/${kaggleDataset}/download/${encodeURIComponent(filename)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    if (res.status === 404) return []; // File not in this dataset (e.g. post-2017 year)
    if (!res.ok) {
      logger.warn(
        { status: res.status, dataset: kaggleDataset, file: filename },
        "sackmannBackfill: Kaggle download failed (token may lack download permission)",
      );
      return [];
    }
    const text = await res.text();
    return parseCsv(text);
  } catch (err) {
    logger.warn({ err, dataset: kaggleDataset, file: filename }, "sackmannBackfill: Kaggle fetch error");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one year's CSV, trying Kaggle first then GitHub as a fallback.
 *
 * Source precedence:
 *   1. Kaggle (if KAGGLE_API_TOKEN is set and file exists in the mirror dataset)
 *   2. GitHub raw content (if GITHUB_PAT is set, or the repo happens to be public)
 *
 * Qual/Challenger files are not mirrored on Kaggle; those use GitHub only.
 */
async function fetchCsvYear(
  githubUrl: string,
  kaggleDataset?: string,
  kaggleFilename?: string,
): Promise<Record<string, string>[]> {
  // Try Kaggle first when we have a dataset + filename mapping
  if (kaggleDataset && kaggleFilename) {
    const rows = await fetchCsvFromKaggle(kaggleDataset, kaggleFilename);
    if (rows.length > 0) return rows;
  }
  // Fall back to GitHub (works if GITHUB_PAT is set or repo is public)
  return fetchCsvFromGitHub(githubUrl);
}

// ── Minimal TennisDataProvider wrapper ────────────────────────────────────────

/**
 * Wraps a pre-loaded array of HistoricalFixtures so that the existing runHistoricalBackfill
 * infrastructure can consume it. Only getCompletedMatchesByDateRange is meaningful; all other
 * methods throw ProviderUnavailableError because runHistoricalBackfill never calls them.
 */
class SackmannProvider implements TennisDataProvider {
  readonly name = "SackmannProvider";
  private readonly fixtures: HistoricalFixture[];

  constructor(fixtures: HistoricalFixture[]) {
    this.fixtures = fixtures;
  }

  async getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]> {
    return this.fixtures.filter((f) => f.date >= dateStart && f.date <= dateStop);
  }

  // ── Stubs for unused methods ────────────────────────────────────────────────
  private _unavailable(method: string): never {
    throw new ProviderUnavailableError(`SackmannProvider does not implement ${method}`);
  }
  getStatus(): import("../tennisData/types").ProviderStatusInfo {
    return { provider: SACKMANN_PROVIDER, connected: true, lastSuccessfulCallAt: null, lastError: null };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async searchPlayers(_query: string): Promise<PlayerSummary[]>           { return this._unavailable("searchPlayers"); }
  async getPlayer(_id: string): Promise<PlayerProfile | null>             { return this._unavailable("getPlayer"); }
  async getPlayerMatches(_id: string): Promise<MatchRecord[]>             { return this._unavailable("getPlayerMatches"); }
  async getUpcomingFixtures(_date: string): Promise<Fixture[]>            { return this._unavailable("getUpcomingFixtures"); }
  async getUpcomingFixturesRange(_s: string, _e: string): Promise<Fixture[]> { return this._unavailable("getUpcomingFixturesRange"); }
  async getHeadToHead(_p1: string, _p2: string): Promise<HeadToHeadRecord> { return this._unavailable("getHeadToHead"); }
  async getLiveScores(_ids: string[]): Promise<Map<string, LiveScore>>    { return this._unavailable("getLiveScores"); }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SackmannBackfillOptions {
  /** First year to backfill. Defaults to 2010. */
  startYear?: number;
  /** Last year to backfill (inclusive). Defaults to the current calendar year. */
  endYear?: number;
  /** Which tours to include. Defaults to both. */
  tours?: Array<"atp" | "wta">;
  /**
   * Also fetch Challenger/qualifying (ATP: atp_matches_qual_chall_YYYY.csv) and
   * ITF/qualifying (WTA: wta_matches_qual_itf_YYYY.csv) files from the same repos.
   *
   * These files contain match history for Challenger-level and ITF players who rarely appear
   * in the main-draw file — the exact population that drives "Limited/Poor Data Quality" and
   * "Extreme Upset Risk" flags. Defaults to `true`.
   */
  includeChallengerItf?: boolean;
}

export interface SackmannBackfillSummary {
  atpYearsLoaded: number;
  wtaYearsLoaded: number;
  /** Years successfully loaded from atp_matches_qual_chall_YYYY.csv (0 if includeChallengerItf was false). */
  atpChallengerYearsLoaded: number;
  /** Years successfully loaded from wta_matches_qual_itf_YYYY.csv (0 if includeChallengerItf was false). */
  wtaItfYearsLoaded: number;
  fixturesLoaded: number;
  backfill: BackfillSummary;
}

/**
 * Downloads Sackmann CSVs for the requested year range, maps them to HistoricalFixture[], then
 * calls the standard runHistoricalBackfill so all feature snapshots, Elo state, and
 * idempotency guarantees are identical to the live-provider path.
 */
export async function runSackmannBackfill(
  options: SackmannBackfillOptions = {},
): Promise<SackmannBackfillSummary> {
  const currentYear       = new Date().getFullYear();
  const startYear         = options.startYear          ?? 2010;
  const endYear           = options.endYear            ?? currentYear;
  const tours             = options.tours              ?? ["atp", "wta"];
  const includeChallengerItf = options.includeChallengerItf ?? true;

  if (startYear > endYear) throw new Error(`startYear (${startYear}) > endYear (${endYear})`);

  const allFixtures: HistoricalFixture[] = [];
  let atpYearsLoaded          = 0;
  let wtaYearsLoaded          = 0;
  let atpChallengerYearsLoaded = 0;
  let wtaItfYearsLoaded        = 0;

  const years = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i);

  /**
   * Fetches one CSV (trying Kaggle then GitHub), maps rows to HistoricalFixture[], and
   * appends to allFixtures. Returns the number of valid fixtures loaded (0 on failure).
   */
  async function fetchAndAppend(
    url: string,
    tourLabel: "ATP" | "WTA",
    context: string,
    kaggleDataset?: string,
    kaggleFilename?: string,
  ): Promise<number> {
    try {
      const rows = await fetchCsvYear(url, kaggleDataset, kaggleFilename);
      if (rows.length === 0) return 0;
      const fixtures = rows
        .map((r) => rowToFixture(r, tourLabel))
        .filter((f): f is HistoricalFixture => f !== null);
      allFixtures.push(...fixtures);
      logger.info({ url: context, rows: rows.length, fixtures: fixtures.length }, "sackmannBackfill: file loaded");
      return fixtures.length;
    } catch (err) {
      logger.warn({ err, url: context }, "sackmannBackfill: failed to load file (non-fatal)");
      return 0;
    }
  }

  // Fetch all CSV files in parallel (capped to avoid hammering external APIs).
  // For each (year, tour) pair we fetch:
  //   1. The main-draw file: atp_matches_YYYY.csv / wta_matches_YYYY.csv
  //      Source: Kaggle mirror first (2000-2017 ATP / 2000-2016 WTA), then GitHub fallback
  //   2. (if includeChallengerItf) The supplementary file:
  //        ATP: atp_matches_qual_chall_YYYY.csv — ATP Challengers + qualifying rounds
  //        WTA: wta_matches_qual_itf_YYYY.csv   — WTA ITF events + qualifying rounds
  //        Source: GitHub only (no Kaggle mirror for qual/chall files)
  const concurrency = 4;
  for (let i = 0; i < years.length; i += concurrency) {
    const batch = years.slice(i, i + concurrency);
    await Promise.all(
      batch.flatMap((year) =>
        tours.flatMap((tour) => {
          const base        = tour === "atp" ? ATP_BASE_URL : WTA_BASE_URL;
          const prefix      = tour === "atp" ? "atp" : "wta";
          const tourLabel: "ATP" | "WTA" = tour === "atp" ? "ATP" : "WTA";
          const kaggleDset  = tour === "atp" ? KAGGLE_ATP_DATASET : KAGGLE_WTA_DATASET;

          const tasks: Promise<void>[] = [];

          // ── Main-draw file ────────────────────────────────────────────────
          // ATP: use the farhadGithub public mirror (1968–2024, exact Sackmann schema, confirmed
          //      reachable from Replit). Falls back to the original Sackmann repo (private, 404s)
          //      for years beyond 2024 or if the mirror is unavailable.
          // WTA: no public mirror found; uses the original Sackmann repo (private, graceful 404).
          const mainFilename = `${prefix}_matches_${year}.csv`;
          const mirrorBase = tour === "atp" ? FARHAD_ATP_MIRROR_BASE : null;
          const mainUrl = mirrorBase
            ? `${mirrorBase}/${mainFilename}`
            : `${base}/${mainFilename}`;
          // Kaggle fallback still attempted for WTA (gmadevs/wta-matches covers 2000–2016)
          const useKaggle = tour === "wta";
          tasks.push(
            fetchAndAppend(
              mainUrl,
              tourLabel,
              `${prefix}_matches_${year}`,
              useKaggle ? kaggleDset : undefined,
              useKaggle ? mainFilename : undefined,
            ).then((count) => {
              if (count > 0) {
                if (tour === "atp") atpYearsLoaded++;
                else wtaYearsLoaded++;
              }
            }),
          );

          // ── Challenger / ITF supplementary file (GitHub only) ───────────
          if (includeChallengerItf) {
            const chalFilename = tour === "atp"
              ? `${prefix}_matches_qual_chall_${year}.csv`
              : `${prefix}_matches_qual_itf_${year}.csv`;
            const chalUrl = `${base}/${chalFilename}`;
            const chalLabel = tour === "atp"
              ? `${prefix}_matches_qual_chall_${year}`
              : `${prefix}_matches_qual_itf_${year}`;
            // No Kaggle mirror for qual/chall files — GitHub only
            tasks.push(
              fetchAndAppend(chalUrl, tourLabel, chalLabel).then((count) => {
                if (count > 0) {
                  if (tour === "atp") atpChallengerYearsLoaded++;
                  else wtaItfYearsLoaded++;
                }
              }),
            );
          }

          return tasks;
        }),
      ),
    );
  }

  if (allFixtures.length === 0) {
    logger.warn({ startYear, endYear, tours, includeChallengerItf }, "sackmannBackfill: no fixtures loaded");
    const emptyDate = `${startYear}-01-01`;
    return {
      atpYearsLoaded: 0,
      wtaYearsLoaded: 0,
      atpChallengerYearsLoaded: 0,
      wtaItfYearsLoaded: 0,
      fixturesLoaded: 0,
      backfill: {
        dateStart: emptyDate,
        dateStop: `${endYear}-12-31`,
        cutoff: "30min",
        cutoffMinutes: 30,
        fixturesFetched: 0,
        matchesInserted: 0,
        matchesSkippedDuplicate: 0,
        matchesSkippedNoTerminalResult: 0,
        matchesRecomputed: 0,
        featureRowsInserted: 0,
        byTour: {},
        bySurface: {},
        byYear: {},
        earliestImportedMatchDate: null,
        latestImportedMatchDate: null,
        dateGapsOver30Days: [],
        durationMs: 0,
      } satisfies BackfillSummary,
    };
  }

  // Sort so the provider can be queried by date range correctly
  allFixtures.sort((a, b) => a.date.localeCompare(b.date));
  const dateStart = allFixtures[0].date;
  const dateStop  = allFixtures[allFixtures.length - 1].date;

  logger.info(
    {
      fixturesLoaded: allFixtures.length,
      atpYearsLoaded, wtaYearsLoaded,
      atpChallengerYearsLoaded, wtaItfYearsLoaded,
      includeChallengerItf,
      dateStart, dateStop,
    },
    "sackmannBackfill: all CSVs loaded, starting historical backfill",
  );

  const provider = new SackmannProvider(allFixtures);
  const backfill = await runHistoricalBackfill(
    provider as unknown as Parameters<typeof runHistoricalBackfill>[0],
    {
      dateStart,
      dateStop,
      // Use "1h" so the cutoff window is wide enough for same-day scheduling uncertainty.
      // Sackmann data has no match times (only dates), so the recorded start is midnight UTC;
      // a 30-min cutoff would be fine numerically but 1h gives a comfortable margin.
      cutoff: "1h",
      chunkDays: 30, // Larger chunks are fine since we're serving from memory, not a live API
    },
  );

  return { atpYearsLoaded, wtaYearsLoaded, atpChallengerYearsLoaded, wtaItfYearsLoaded, fixturesLoaded: allFixtures.length, backfill };
}

// ── Test-only named exports ───────────────────────────────────────────────────
// Not part of the public API. Exported with underscore prefix so call-sites are
// visibly out-of-module-contract. Used by sackmannBackfillChallengerItf.test.ts
// to white-box-test the CSV parsing logic without re-implementing it locally.
export {
  rowToFixture    as _rowToFixture,
  mapWtaLevel     as _mapWtaLevel,
  mapAtpLevel     as _mapAtpLevel,
  intOrNull       as _intOrNull,
};
