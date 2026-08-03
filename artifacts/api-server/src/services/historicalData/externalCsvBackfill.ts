/**
 * External CSV historical backfill.
 *
 * Reads uploaded CSV files from `attached_assets/` (or any absolute path) and inserts
 * their match records into historical_matches via the existing backfill infrastructure,
 * so feature snapshots, Elo state, and idempotency work identically to the Sackmann path.
 *
 * CSV format (same schema for all supplied files):
 *   match_id, season_year, tour_type, tour_type_human, date_timestamp, date_human,
 *   tournament, round, surface, surface_id, status, status_extra,
 *   home_name, away_name, home_id, away_id, home_rank, away_rank,
 *   home_points, away_points, winner_code,
 *   home_set_score, away_set_score, home_set_1_score … away_set_5_score,
 *   home_odds_match_winner, away_odds_match_winner, …,
 *   home_aces, away_aces, home_double_faults, away_double_faults,
 *   home_service_points_won_perc, away_service_points_won_perc,
 *   home_return_points_won_perc, away_return_points_won_perc,
 *   home_break_points_won_perc, away_break_points_won_perc,
 *   home_break_points_saved_perc, away_break_points_saved_perc
 *
 * Player ID resolution strategy:
 *   1. Build a surname → [{id, name}] index from all existing historical_matches rows.
 *   2. For each CSV player, extract the surname from the abbreviated name ("Djokovic N." → "djokovic").
 *   3. If exactly one existing player shares that surname, reuse their stored ID so Elo chains
 *      correctly through the new year without a cold-start break.
 *   4. Fall back to "ext-{csvId}" when no unique match is found (new players, name ambiguity).
 */

import * as fs from "fs";
import { runHistoricalBackfill } from "./backfill";
import { runExternalCsvBridge, type ExtCsvBridgeResult } from "./externalCsvBridge";
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
  ProviderStatusInfo,
} from "../tennisData/types";
import { inferSurfaceAndLevel } from "../tennisData/surfaceMap";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";

export const EXT_CSV_PROVIDER = "ext-csv";

// ── CSV parsing ───────────────────────────────────────────────────────────────

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
  // Strip BOM and surrounding quotes from header names
  const rawHeader = lines[0].replace(/^\uFEFF/, "");
  const headers = parseCsvRow(rawHeader).map(h => h.replace(/^"|"$/g, "").trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvRow(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j]?.trim().replace(/^"|"$/g, "") ?? "";
    }
    rows.push(row);
  }
  return rows;
}

// ── Surface mapping ───────────────────────────────────────────────────────────

function mapSurface(raw: string): Surface | null {
  switch (raw.toLowerCase()) {
    case "hard":  return "Hard";
    case "clay":  return "Clay";
    case "grass": return "Grass";
    default:      return null;
  }
}

// ── Player ID resolution ──────────────────────────────────────────────────────

/**
 * Extract surname key + first initial from a DB-stored player name (format: "First [Middle] Last").
 * "Novak Djokovic"              → { surname: "djokovic",          initial: "n" }
 * "Alejandro Davidovich Fokina" → { surname: "davidovich fokina", initial: "a" }
 * Falls back gracefully for single-word names.
 */
function dbNameParts(name: string): { surname: string; initial: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { surname: "", initial: "" };
  if (words.length === 1) {
    return { surname: words[0].toLowerCase(), initial: words[0][0]?.toLowerCase() ?? "" };
  }
  return {
    initial: words[0][0]?.toLowerCase() ?? "",
    surname: words.slice(1).join(" ").toLowerCase(),
  };
}

/**
 * Extract surname key + first initial from a CSV abbreviated name (format: "Last F." or "Compound Last F.").
 * "Djokovic N."          → { surname: "djokovic",          initial: "n" }
 * "Davidovich Fokina A." → { surname: "davidovich fokina", initial: "a" }
 * "De Minaur A."         → { surname: "de minaur",         initial: "a" }
 * "Osaka"                → { surname: "osaka",             initial: null }
 */
function csvNameParts(name: string): { surname: string; initial: string | null } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { surname: "", initial: null };
  if (words.length === 1) return { surname: words[0].toLowerCase(), initial: null };
  const lastToken = words[words.length - 1];
  if (/^[A-Za-z]\.?$/.test(lastToken)) {
    return {
      surname: words.slice(0, -1).join(" ").toLowerCase(),
      initial: lastToken.replace(".", "").toLowerCase(),
    };
  }
  return { surname: name.trim().toLowerCase(), initial: null };
}

type PlayerEntry = { id: string; name: string };

type PlayerIdMap = {
  /** "surname|initial" → players. Unique = unambiguous. */
  byInitial: Map<string, PlayerEntry[]>;
  /** surname → players. Fallback when initial absent or initial-key is ambiguous. */
  bySurname: Map<string, PlayerEntry[]>;
};

/**
 * Query historical_matches to build an enhanced surname+initial player lookup.
 * Only one DB round-trip; all subsequent lookups are in-process.
 *
 * Uses surname + first-initial keys so "Murray A." (Andy) and "Murray J." (Jamie)
 * are disambiguated instead of both falling through to ext-{id}.
 */
async function buildPlayerIdMap(): Promise<PlayerIdMap> {
  const byInitial = new Map<string, PlayerEntry[]>();
  const bySurname = new Map<string, PlayerEntry[]>();

  const result = await db.execute(sql`
    SELECT player_id, player_name FROM (
      SELECT DISTINCT player1_id AS player_id, player1_name AS player_name
        FROM historical_matches WHERE player1_name IS NOT NULL AND player1_name != ''
      UNION
      SELECT DISTINCT player2_id AS player_id, player2_name AS player_name
        FROM historical_matches WHERE player2_name IS NOT NULL AND player2_name != ''
    ) sub
  `);

  function addEntry(map: Map<string, PlayerEntry[]>, key: string, entry: PlayerEntry): void {
    if (!map.has(key)) map.set(key, []);
    const bucket = map.get(key)!;
    if (!bucket.some(e => e.id === entry.id)) bucket.push(entry);
  }

  for (const r of result.rows as Array<{ player_id: string; player_name: string }>) {
    if (!r.player_id || !r.player_name) continue;
    const entry: PlayerEntry = { id: r.player_id, name: r.player_name };
    const { surname, initial } = dbNameParts(r.player_name);
    if (!surname) continue;
    addEntry(bySurname, surname, entry);
    if (initial) addEntry(byInitial, `${surname}|${initial}`, entry);
  }

  return { byInitial, bySurname };
}

/**
 * Resolve a CSV player's name to an existing DB player ID.
 *
 * Resolution order:
 *   1. Surname + first-initial → unambiguous match (handles "Murray A." vs "Murray J.")
 *   2. Surname-only            → only when globally unique in the DB
 *   3. Fall back to "ext-{tour}-{extId}" — tour-scoped so ATP and WTA numeric player-ID
 *      namespaces never collide (both CSVs share the same numeric home_id / away_id space).
 */
function resolvePlayerId(
  csvName: string,
  extId: string,
  tour: "ATP" | "WTA",
  map: PlayerIdMap,
  tally: { matched: number; unmatched: number },
): string {
  const { surname, initial } = csvNameParts(csvName);

  // 1. Surname + initial (most specific)
  if (initial) {
    const candidates = map.byInitial.get(`${surname}|${initial}`);
    if (candidates && candidates.length === 1) {
      tally.matched++;
      return candidates[0].id;
    }
  }

  // 2. Surname-only when globally unambiguous
  const surnameCandidates = map.bySurname.get(surname);
  if (surnameCandidates && surnameCandidates.length === 1) {
    tally.matched++;
    return surnameCandidates[0].id;
  }

  tally.unmatched++;
  // Tour-prefix prevents ATP player "ext-atp-12345" from ever colliding with WTA player
  // "ext-wta-12345" when both CSVs happen to assign the same numeric home_id / away_id.
  return `ext-${tour.toLowerCase()}-${extId || csvName.replace(/\s+/g, "-")}`;
}

// ── Tournament level inference ────────────────────────────────────────────────

function inferLevel(tournamentName: string | null, tourTypeHuman: string): TournamentLevel | null {
  // Named-event table covers Grand Slams, Masters 1000/WTA 1000, ATP/WTA 500s
  const { level } = inferSurfaceAndLevel(tournamentName);
  if (level) return level;

  // Use tour_type_human for everything else
  if (/chall/i.test(tourTypeHuman)) return "Challenger";
  if (/atp/i.test(tourTypeHuman))   return "ATP250";
  if (/wta/i.test(tourTypeHuman))   return "WTA250";
  return null;
}

// ── Score & set-margin helpers ────────────────────────────────────────────────

/** Reconstruct "6-4 3-6 7-5" from per-set columns (home = player1 perspective). */
function buildScoreString(row: Record<string, string>): string | null {
  const parts: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const h = row[`home_set_${i}_score`];
    const a = row[`away_set_${i}_score`];
    if (!h && !a) break;
    if (h || a) parts.push(`${h ?? ""}-${a ?? ""}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Build set-game-margins array (player1 = home). */
function buildSetMargins(row: Record<string, string>): Array<{ player1Games: number; player2Games: number }> {
  const margins: Array<{ player1Games: number; player2Games: number }> = [];
  for (let i = 1; i <= 5; i++) {
    const h = parseInt(row[`home_set_${i}_score`] ?? "", 10);
    const a = parseInt(row[`away_set_${i}_score`] ?? "", 10);
    if (!Number.isFinite(h) || !Number.isFinite(a)) break;
    margins.push({ player1Games: h, player2Games: a });
  }
  return margins;
}

// ── Row → HistoricalFixture ───────────────────────────────────────────────────

function rowToFixture(
  row: Record<string, string>,
  playerIdMap: PlayerIdMap,
  tally: { matched: number; unmatched: number },
): HistoricalFixture | null {
  // Skip exhibitions and non-finished rows
  const tourHuman = row.tour_type_human?.trim() ?? "";
  if (/exhib/i.test(tourHuman)) return null;
  if (row.status?.trim() !== "FINISHED") return null;

  // Determine tour: ATP or WTA (Challenger rolls up under ATP/WTA by level)
  let tour: "ATP" | "WTA";
  if (/^atp/i.test(tourHuman))      tour = "ATP";
  else if (/^wta/i.test(tourHuman)) tour = "WTA";
  else return null;

  // Date from unix timestamp
  const ts = parseInt(row.date_timestamp ?? "", 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const date = new Date(ts * 1000).toISOString().slice(0, 10);

  const externalId = row.match_id?.trim();
  if (!externalId) return null;

  // winner_code: "1" = home won, "2" = away won
  const winnerCode = row.winner_code?.trim();
  if (winnerCode !== "1" && winnerCode !== "2") return null;
  const homeWon = winnerCode === "1";

  const homeId   = row.home_id?.trim() || `noid-${externalId}-h`;
  const awayId   = row.away_id?.trim() || `noid-${externalId}-a`;
  const homeName = row.home_name?.trim() ?? "";
  const awayName = row.away_name?.trim() ?? "";

  // Resolve player IDs against existing DB history.
  // tour is passed so the ext-{tour}-{id} fallback is always tour-scoped — ATP and WTA
  // CSVs share the same numeric home_id / away_id namespace, so an un-namespaced fallback
  // would create collisions that corrupt Elo chains across tours.
  const p1Id = resolvePlayerId(homeName, homeId, tour, playerIdMap, tally);
  const p2Id = resolvePlayerId(awayName, awayId, tour, playerIdMap, tally);

  const tournamentName = row.tournament?.trim() || null;
  const level     = inferLevel(tournamentName, tourHuman);
  const surface   = mapSurface(row.surface ?? "");
  const scoreStr  = buildScoreString(row);
  const setMargins = buildSetMargins(row);

  // Men's Grand Slams are best of 5; everything else best of 3
  const matchFormat: MatchFormat =
    level === "GrandSlam" && tour === "ATP" ? "BestOf5" : "BestOf3";

  const statusExtra = (row.status_extra ?? "").toLowerCase();
  const retired  = /retired|ret\.?$/.test(statusExtra);
  const walkover = /walkover|w\/o/.test(statusExtra);

  const p1Rank = parseInt(row.home_rank ?? "", 10);
  const p2Rank = parseInt(row.away_rank ?? "", 10);

  // Detect indoor from tournament name keywords (no dedicated field in this CSV format)
  const indoor: boolean | null = /\bindoor\b|\(indoor\)/i.test(tournamentName ?? "") ? true : null;

  // Prefix with tour to prevent cross-tour Sofascore ID collisions
  // (WTA and ATP share the same numeric ID namespace in this CSV format)
  const scopedId = `${tour.toLowerCase()}-${externalId}`;

  return {
    id:              scopedId,
    provider:        EXT_CSV_PROVIDER,
    date,
    time:            null,
    tour,
    tournamentName,
    tournamentLevel: level,
    round:           row.round?.trim() || null,
    surface,
    matchFormat,
    player1Id:       p1Id,
    player1Name:     homeName,
    player2Id:       p2Id,
    player2Name:     awayName,
    winnerId:        homeWon ? p1Id : p2Id,
    score:           scoreStr,
    retired,
    walkover,
    cancelled:       false,
    setGameMargins:  setMargins,
    indoor,
    player1Rank:     Number.isFinite(p1Rank) && p1Rank > 0 ? p1Rank : null,
    player2Rank:     Number.isFinite(p2Rank) && p2Rank > 0 ? p2Rank : null,
    raw:             row,
  };
}

// ── Minimal TennisDataProvider wrapper ────────────────────────────────────────

class ExternalCsvProvider implements TennisDataProvider {
  readonly name = EXT_CSV_PROVIDER;

  constructor(private readonly fixtures: HistoricalFixture[]) {}

  async getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]> {
    return this.fixtures.filter(f => f.date >= dateStart && f.date <= dateStop);
  }

  // The following methods are never called by runHistoricalBackfill.
  searchPlayers():          Promise<PlayerSummary[]>    { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: searchPlayers not available`)); }
  getPlayer():              Promise<PlayerProfile|null> { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getPlayer not available`)); }
  getPlayerMatches():       Promise<MatchRecord[]>      { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getPlayerMatches not available`)); }
  getUpcomingFixtures():    Promise<Fixture[]>          { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getUpcomingFixtures not available`)); }
  getUpcomingFixturesRange(): Promise<Fixture[]>        { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getUpcomingFixturesRange not available`)); }
  getHeadToHead():          Promise<HeadToHeadRecord>   { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getHeadToHead not available`)); }
  getLiveScores(_fixtureIds: string[]): Promise<Map<string, LiveScore>> { return Promise.reject(new ProviderUnavailableError(`${EXT_CSV_PROVIDER}: getLiveScores not available`)); }
  getStatus(): ProviderStatusInfo {
    return { provider: EXT_CSV_PROVIDER, connected: true, lastSuccessfulCallAt: null, lastError: null };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExternalCsvBackfillOptions {
  /** Absolute paths to the CSV files to import. */
  files: string[];
}

export interface ExternalCsvBackfillResult {
  filesLoaded:       number;
  fixturesParsed:    number;
  playersMatched:    number;
  playersUnmatched:  number;
  backfill:          BackfillSummary;
  /** Bridge result: ext-{…} player IDs re-resolved inline after the import. */
  bridge:            ExtCsvBridgeResult;
}

/**
 * Main entry point.  Reads each CSV from disk, maps rows to HistoricalFixture[], resolves
 * player IDs against existing historical_matches by surname, then calls runHistoricalBackfill
 * so all Elo / feature-snapshot / idempotency logic runs identically to the Sackmann path.
 */
export async function runExternalCsvBackfill(
  options: ExternalCsvBackfillOptions,
): Promise<ExternalCsvBackfillResult> {
  const { files } = options;
  if (files.length === 0) throw new Error("externalCsvBackfill: no files specified");

  // Build player ID map from existing historical_matches (one DB round-trip)
  logger.info({ fileCount: files.length }, "externalCsvBackfill: building player ID map");
  const playerIdMap = await buildPlayerIdMap();
  logger.info(
    { bySurnameKeys: playerIdMap.bySurname.size, byInitialKeys: playerIdMap.byInitial.size },
    "externalCsvBackfill: player ID map ready",
  );

  const allFixtures: HistoricalFixture[] = [];
  let filesLoaded = 0;
  const tally = { matched: 0, unmatched: 0 };

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, "externalCsvBackfill: file not found, skipping");
      continue;
    }
    const text   = fs.readFileSync(filePath, "utf8");
    const rows   = parseCsv(text);
    const before = allFixtures.length;
    for (const row of rows) {
      const f = rowToFixture(row, playerIdMap, tally);
      if (f) allFixtures.push(f);
    }
    logger.info(
      { filePath, totalRows: rows.length, fixturesExtracted: allFixtures.length - before },
      "externalCsvBackfill: file loaded",
    );
    filesLoaded++;
  }

  if (allFixtures.length === 0) {
    throw new Error("externalCsvBackfill: no valid fixtures parsed (check file paths and FINISHED status filter)");
  }

  // Sort chronologically — required by runHistoricalBackfill's chunk cursor
  allFixtures.sort((a, b) => a.date.localeCompare(b.date));

  const dateStart = allFixtures[0].date;
  const dateStop  = allFixtures[allFixtures.length - 1].date;

  logger.info({
    filesLoaded,
    fixturesParsed:   allFixtures.length,
    playersMatched:   tally.matched,
    playersUnmatched: tally.unmatched,
    matchRate:        `${Math.round((tally.matched / (tally.matched + tally.unmatched || 1)) * 100)}%`,
    dateStart,
    dateStop,
  }, "externalCsvBackfill: all CSVs loaded, starting historical backfill");

  const provider = new ExternalCsvProvider(allFixtures);
  const backfill = await runHistoricalBackfill(
    provider as unknown as Parameters<typeof runHistoricalBackfill>[0],
    { dateStart, dateStop, cutoff: "1h" },
  );

  logger.info({
    matchesInserted:         backfill.matchesInserted,
    matchesSkippedDuplicate: backfill.matchesSkippedDuplicate,
    featureRowsInserted:     backfill.featureRowsInserted,
  }, "externalCsvBackfill: historical backfill complete, running inline bridge");

  // Run the ID bridge inline so callers get corrected Elo chains without a
  // separate manual POST to /evaluation/external-csv-backfill/bridge.
  // The bridge is idempotent: re-running on already-resolved rows is a no-op.
  const bridge = await runExternalCsvBridge();

  logger.info({
    extPlayerSlotsFound: bridge.extPlayerSlotsFound,
    resolved:            bridge.resolved,
    unresolved:          bridge.unresolved,
    matchRowsUpdated:    bridge.matchRowsUpdated,
    atpMatchRate:        bridge.atpMatchRate,
    wtaMatchRate:        bridge.wtaMatchRate,
  }, "externalCsvBackfill: completed (backfill + inline bridge)");

  return {
    filesLoaded,
    fixturesParsed:   allFixtures.length,
    playersMatched:   tally.matched,
    playersUnmatched: tally.unmatched,
    backfill,
    bridge,
  };
}
