/**
 * Sofascore provider for the Parlay Builder Validation Engine.
 *
 * Uses the Sofascore public unofficial API (api.sofascore.com/api/v1/) to
 * resolve player identity and fetch match history. Sofascore covers all tennis
 * levels — ATP, WTA, WTA 125K, Challenger, ITF — making it the primary fix
 * for lower-tier players that the main API providers don't cover.
 *
 * This module does NOT implement the full TennisDataProvider interface.
 * It is called directly from builderProviderFetch.ts as a second-tier
 * fallback after the primary composite provider (RapidAPI + API-Tennis) fails.
 *
 * No API key required — Sofascore's public API is unauthenticated.
 * Rate limiting: 3-second timeout per request; no more than 3 pages of events.
 */

import { logger } from "../../lib/logger.js";
import type { MatchRecord, PlayerSummary, Surface, TournamentLevel } from "../tennisData/types.js";

// ─── Sofascore response shapes ────────────────────────────────────────────────

interface SofascoreSearchResult {
  type: string;
  entity: {
    id: number;
    name: string;
    shortName?: string;
    sport?: { id: number; name: string; slug: string };
    team?: { name: string };
    nationality?: { alpha2: string };
  };
}

interface SofascoreScore {
  current?: number;
  period1?: number;
  period2?: number;
  period3?: number;
  period4?: number;
  period5?: number;
  display?: string;
}

interface SofascoreEvent {
  id: number;
  tournament?: {
    name?: string;
    category?: { name?: string };
    uniqueTournament?: { name?: string; category?: { name?: string } };
  };
  homeTeam?: { id: number; name: string };
  awayTeam?: { id: number; name: string };
  homeScore?: SofascoreScore;
  awayScore?: SofascoreScore;
  winnerCode?: number; // 1 = home wins, 2 = away wins
  startTimestamp?: number;
  status?: { type?: string; description?: string };
  groundType?: string;
  roundInfo?: { name?: string; round?: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SOFASCORE_TENNIS_SPORT_ID = 5;

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.sofascore.com",
  Referer: "https://www.sofascore.com/",
  "Cache-Control": "no-cache",
};

const FETCH_TIMEOUT_MS = 8_000;

function sfFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { headers: BASE_HEADERS, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

function mapSurface(groundType: string | undefined | null): Surface | null {
  if (!groundType) return null;
  const m: Record<string, Surface> = {
    HARD: "Hard",
    CLAY: "Clay",
    GRASS: "Grass",
    ARTIFICIAL_GRASS: "Grass",
    INDOOR_HARD: "IndoorHard",
    INDOOR_CLAY: "Clay",
    CARPET: "IndoorHard",
  };
  return m[groundType.toUpperCase()] ?? null;
}

function mapTournamentLevel(event: SofascoreEvent): TournamentLevel | null {
  const catName =
    event.tournament?.uniqueTournament?.category?.name ??
    event.tournament?.category?.name ??
    event.tournament?.uniqueTournament?.name ??
    event.tournament?.name ??
    "";
  const n = catName.toLowerCase();

  if (n.includes("grand slam")) return "GrandSlam";
  if (n.includes("masters 1000") || n.includes("masters series")) return "Masters1000";
  if (n.includes("wta 1000") || n.includes("premier mandatory") || n.includes("premier 5"))
    return "WTA1000";
  if (n.includes("atp 500") || n.includes("premier ") || n.includes("wta 500")) {
    // "WTA Premier" (old name for WTA 500) vs "WTA Premier Mandatory" (WTA 1000)
    if (n.includes("mandatory") || n.includes(" 5")) return "WTA1000";
    return n.startsWith("atp") ? "ATP500" : "WTA500";
  }
  if (n.includes("atp 250")) return "ATP250";
  if (n.includes("wta 250")) return "WTA250";
  if (n.includes("challenger")) return "Challenger";
  if (n.includes("125")) return "Challenger"; // WTA 125K / WTA 125
  if (n.includes("itf")) return "ITF";
  return "Other";
}

function formatScore(
  playerScore: SofascoreScore | undefined,
  oppScore: SofascoreScore | undefined,
): string | null {
  if (!playerScore || !oppScore) return null;
  const sets: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const key = `period${i}` as keyof SofascoreScore;
    const ps = playerScore[key] as number | undefined;
    const os = oppScore[key] as number | undefined;
    if (ps === undefined || os === undefined) break;
    sets.push(`${ps}-${os}`);
  }
  return sets.length > 0 ? sets.join(" ") : null;
}

function isRetired(event: SofascoreEvent): boolean {
  const desc = (event.status?.description ?? "").toLowerCase();
  return desc.includes("retired") || desc.includes("ret.") || desc.includes("withdraw");
}

function isWalkover(event: SofascoreEvent): boolean {
  const desc = (event.status?.description ?? "").toLowerCase();
  return desc.includes("walkover") || desc.includes("w/o");
}

function eventToMatchRecord(event: SofascoreEvent, playerId: number): MatchRecord | null {
  // Only completed matches
  const statusType = event.status?.type ?? "";
  if (!["finished", "ended"].includes(statusType.toLowerCase())) return null;
  if (!event.startTimestamp) return null;

  const isHome = event.homeTeam?.id === playerId;
  const opponentTeam = isHome ? event.awayTeam : event.homeTeam;
  const playerScoreObj = isHome ? event.homeScore : event.awayScore;
  const oppScoreObj = isHome ? event.awayScore : event.homeScore;

  if (!opponentTeam) return null;

  const won = isHome ? event.winnerCode === 1 : event.winnerCode === 2;

  return {
    id: `sofascore-${event.id}`,
    date: new Date(event.startTimestamp * 1000).toISOString(),
    tournamentName: event.tournament?.name ?? null,
    tournamentLevel: mapTournamentLevel(event),
    round: event.roundInfo?.name ?? null,
    matchFormat: null,
    surface: mapSurface(event.groundType),
    indoor: null,
    opponentId: `sofascore-${opponentTeam.id}`,
    opponentName: opponentTeam.name,
    opponentRank: null,
    result: won ? "W" : "L",
    score: formatScore(playerScoreObj, oppScoreObj),
    retired: isRetired(event),
    walkover: isWalkover(event),
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

// ─── Name matching (same guard as builderProviderFetch) ───────────────────────

function extractSurname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

function extractFirstInitial(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.replace(/\./g, "").charAt(0).toUpperCase();
}

export function isConfidentSofascoreMatch(candidateName: string, queriedName: string): boolean {
  const qSurname = extractSurname(queriedName);
  const qInitial = extractFirstInitial(queriedName).toLowerCase();

  // NFD-normalize both sides so diacritics don't block matches
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[ŁłÐðØøÆæ]/g, (c) =>
        ({ Ł: "l", ł: "l", Ð: "d", ð: "d", Ø: "o", ø: "o", Æ: "ae", æ: "ae" }[c] ?? c),
      );

  const normCandidate = normalize(candidateName);
  const normSurname = normalize(qSurname);

  if (!normCandidate.includes(normSurname)) return false;
  if (qInitial) {
    const cInitial = normalize(candidateName).trimStart().charAt(0);
    const qInitialNorm = normalize(qInitial);
    if (cInitial !== qInitialNorm) return false;
  }
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SofascoreFetchResult {
  player: PlayerSummary | null;
  records: MatchRecord[];
  error: string | null;
}

/**
 * Search for a tennis player by name and return their recent match history.
 * Returns { player: null, records: [] } gracefully on any error.
 */
export async function fetchFromSofascore(playerName: string): Promise<SofascoreFetchResult> {
  // ── Step 1: search for the player ──────────────────────────────────────────
  let foundId: number | null = null;
  let foundName: string | null = null;
  let foundCountry: string | null = null;

  const namesToTry = [
    playerName.trim(),
    // surname only — broadest search, initial-filtered in result check
    playerName.trim().split(/\s+/).pop() ?? playerName.trim(),
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const query of namesToTry) {
    try {
      const url = `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(query)}`;
      const res = await sfFetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 429) {
          logger.warn({ query, status: res.status }, "sofascoreProvider: search rate-limited");
          return { player: null, records: [], error: "Sofascore rate-limited (429)" };
        }
        const error = `Sofascore search HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
        logger.warn({ query, status: res.status, bodySnippet: body.slice(0, 200) }, "sofascoreProvider: search returned non-OK");
        return { player: null, records: [], error };
      }
      const data = (await res.json()) as { results?: SofascoreSearchResult[] };
      const players = (data.results ?? []).filter(
        (r) => r.type === "player" && r.entity?.sport?.id === SOFASCORE_TENNIS_SPORT_ID,
      );

      const match = players.find((r) => isConfidentSofascoreMatch(r.entity.name, playerName));
      if (match) {
        foundId = match.entity.id;
        foundName = match.entity.name;
        foundCountry = match.entity.nationality?.alpha2 ?? null;
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timeout")) {
        return { player: null, records: [], error: "Sofascore search timed out" };
      }
      logger.warn({ err, query }, "sofascoreProvider: search error");
      return { player: null, records: [], error: `Sofascore search failed: ${msg}` };
    }
  }

  if (foundId === null || foundName === null) {
    return { player: null, records: [], error: null };
  }

  const player: PlayerSummary = {
    id: `sofascore-${foundId}`,
    name: foundName,
    countryCode: foundCountry,
    currentRank: null,
    tour: null,
  };

  // ── Step 2: fetch match history (up to 3 pages = ~30 matches) ──────────────
  const records: MatchRecord[] = [];

  for (let page = 0; page < 3; page++) {
    try {
      const url = `https://api.sofascore.com/api/v1/player/${foundId}/events/last/${page}`;
      const res = await sfFetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.warn({ page, foundId, status: res.status, bodySnippet: body.slice(0, 200) }, "sofascoreProvider: events page returned non-OK");
        return {
          player,
          records,
          error: `Sofascore events HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        };
      }
      const data = (await res.json()) as { events?: SofascoreEvent[]; hasNextPage?: boolean };
      const events = data.events ?? [];
      for (const ev of events) {
        const rec = eventToMatchRecord(ev, foundId);
        if (rec) records.push(rec);
      }
      if (!data.hasNextPage) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timeout")) {
        return { player, records, error: "Sofascore events timed out" };
      }
      logger.warn({ err, page, foundId }, "sofascoreProvider: events page error");
      return { player, records, error: `Sofascore events failed: ${msg}` };
    }
  }

  logger.info(
    { playerName, foundName, foundId, recordCount: records.length },
    "sofascoreProvider: resolved player",
  );

  return { player, records, error: null };
}
