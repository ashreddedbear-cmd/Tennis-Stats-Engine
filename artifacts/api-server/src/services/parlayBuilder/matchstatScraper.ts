/**
 * Matchstat.com surface-record scraper for the Parlay Builder.
 *
 * Scrapes https://matchstat.com/player/{slug}/ to extract aggregate
 * surface win/loss records and recent form. Used as enrichment data when
 * a player has insufficient match history from the primary provider chain.
 *
 * The data is aggregate (totals), not individual match records. It feeds
 * directly into surfaceAdvantage and recentForm factor fallbacks when
 * selMatches.length is below the min-sample threshold.
 *
 * Gracefully returns null on any error (404, parsing failure, timeout).
 * Never throws — callers treat null as "no enrichment available".
 */

import { logger } from "../../lib/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatchstatSurfaceRecord {
  wins: number;
  losses: number;
}

export interface MatchstatPlayerData {
  /** Win/loss totals by surface (e.g. { "Hard": { wins: 15, losses: 8 } }) */
  surfaceRecords: Partial<Record<"Hard" | "Clay" | "Grass" | "Carpet" | "Indoor", MatchstatSurfaceRecord>>;
  /** Last ~20 matches aggregate (from form table). */
  recentRecord: MatchstatSurfaceRecord | null;
  /** Overall career record from the page header. */
  overallRecord: MatchstatSurfaceRecord | null;
  /** Slug that was used to retrieve this data. */
  slug: string;
}

// ─── Slug generation ──────────────────────────────────────────────────────────

/**
 * Convert a player name to a Matchstat URL slug.
 * "Iga Świątek" → "iga-swiatek"
 * "Emma Si Yu Dong" → "emma-si-yu-dong"
 */
export function toMatchstatSlug(playerName: string): string {
  return playerName
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")    // strip combining diacritics
    .replace(/[ŁłÐðØøÆæÇç]/g, (c) =>
      ({ Ł: "L", ł: "l", Ð: "D", ð: "d", Ø: "O", ø: "o", Æ: "AE", æ: "ae", Ç: "C", ç: "c" }[c] ?? c),
    )
    .replace(/[^a-zA-Z0-9\s-]/g, "")   // drop remaining non-ASCII
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────

function parseWL(text: string): { wins: number; losses: number } | null {
  // Handles "15-8", "15 - 8", "W:15 L:8", "15W 8L", etc.
  const m =
    text.match(/(\d+)\s*[-–]\s*(\d+)/) ??
    text.match(/[Ww]:?\s*(\d+)[,\s]+[Ll]:?\s*(\d+)/) ??
    text.match(/(\d+)\s*[Ww][,\s]+(\d+)\s*[Ll]/);
  if (!m) return null;
  return { wins: parseInt(m[1], 10), losses: parseInt(m[2], 10) };
}

/**
 * Extract surface breakdown from matchstat.com HTML.
 *
 * The page has a table section with rows like:
 *   <td>Hard</td><td>15</td><td>8</td>
 * or combined "15-8" cells. We use flexible regex to handle both.
 */
function extractSurfaceRecords(
  html: string,
): Partial<Record<string, MatchstatSurfaceRecord>> {
  const records: Partial<Record<string, MatchstatSurfaceRecord>> = {};

  // Strategy 1: rows with surface name followed by two number cells
  // e.g. >Hard</td>\s*<td>15</td>\s*<td>8</td>
  const surfaces = ["Hard", "Clay", "Grass", "Carpet", "Indoor"];
  for (const surface of surfaces) {
    // Pattern: surface name in a cell, then wins, then losses in next cells
    const cellPattern = new RegExp(
      `>${surface}<\\/td>[\\s\\S]{0,200}?>(\\d{1,4})<\\/td>[\\s\\S]{0,100}?>(\\d{1,4})<\\/td>`,
      "i",
    );
    const m = html.match(cellPattern);
    if (m) {
      const wins = parseInt(m[1], 10);
      const losses = parseInt(m[2], 10);
      if (!isNaN(wins) && !isNaN(losses)) {
        records[surface as "Hard" | "Clay" | "Grass"] = { wins, losses };
        continue;
      }
    }

    // Pattern: surface name near a "W-L" formatted string in the same row
    const rowPattern = new RegExp(
      `<tr[^>]*>[\\s\\S]{0,500}?${surface}[\\s\\S]{0,500}?(\\d{1,4})[\\s-–]+(\\d{1,4})[\\s\\S]{0,100}?<\\/tr>`,
      "i",
    );
    const rm = html.match(rowPattern);
    if (rm) {
      const wins = parseInt(rm[1], 10);
      const losses = parseInt(rm[2], 10);
      if (!isNaN(wins) && !isNaN(losses)) {
        records[surface as "Hard" | "Clay" | "Grass"] = { wins, losses };
      }
    }
  }

  return records;
}

/**
 * Extract overall record from the page header area.
 * Matchstat typically shows "W-L" prominently near the player name.
 */
function extractOverallRecord(html: string): MatchstatSurfaceRecord | null {
  // Look for the main career W-L figures, e.g. "Career: 347-210" or similar
  const patterns = [
    /[Cc]areer[^<]{0,50}(\d{1,4})\s*[-–]\s*(\d{1,4})/,
    /[Oo]verall[^<]{0,50}(\d{1,4})\s*[-–]\s*(\d{1,4})/,
    /class="career[^"]*"[^>]*>[^<]*(\d{1,4})\s*[-–]\s*(\d{1,4})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const wins = parseInt(m[1], 10);
      const losses = parseInt(m[2], 10);
      if (!isNaN(wins) && !isNaN(losses) && wins + losses > 0) {
        return { wins, losses };
      }
    }
  }
  return null;
}

/**
 * Extract recent form record from the last ~20 matches section.
 * Matchstat often shows a mini W-L record for recent matches.
 */
function extractRecentRecord(html: string): MatchstatSurfaceRecord | null {
  const patterns = [
    /[Ll]ast\s+\d+[^<]{0,100}(\d{1,3})\s*[-–]\s*(\d{1,3})/,
    /[Rr]ecent[^<]{0,100}(\d{1,3})\s*[-–]\s*(\d{1,3})/,
    /[Ff]orm[^<]{0,100}(\d{1,3})\s*[-–]\s*(\d{1,3})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const wins = parseInt(m[1], 10);
      const losses = parseInt(m[2], 10);
      if (!isNaN(wins) && !isNaN(losses) && wins + losses > 0 && wins + losses <= 50) {
        return { wins, losses };
      }
    }
  }
  return null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

const SCRAPE_TIMEOUT_MS = 8_000;
const SCRAPE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; TennisBot/1.0; research purposes)",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Fetch and parse a player's Matchstat.com page.
 * Returns null if the player is not found or any error occurs.
 */
export async function scrapeMatchstatPlayer(
  playerName: string,
): Promise<MatchstatPlayerData | null> {
  const slug = toMatchstatSlug(playerName);
  if (!slug || slug.length < 2) return null;

  const url = `https://matchstat.com/player/${slug}/`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: SCRAPE_HEADERS,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (res.status === 404) {
      logger.debug({ playerName, slug }, "matchstatScraper: player page not found (404)");
      return null;
    }
    if (!res.ok) {
      logger.debug({ playerName, slug, status: res.status }, "matchstatScraper: non-OK response");
      return null;
    }

    const html = await res.text();

    // Sanity check — make sure we got a real player page, not an error/redirect
    const nameParts = playerName.toLowerCase().split(/\s+/);
    const surname = nameParts[nameParts.length - 1] ?? "";
    const hasPlayerData = surname.length >= 3 && html.toLowerCase().includes(surname);
    if (!hasPlayerData) {
      logger.debug({ playerName, slug }, "matchstatScraper: page exists but name not found in content");
      return null;
    }

    const surfaceRecords = extractSurfaceRecords(html);
    const overallRecord = extractOverallRecord(html);
    const recentRecord = extractRecentRecord(html);

    const hasSomeData =
      Object.keys(surfaceRecords).length > 0 || overallRecord !== null || recentRecord !== null;

    if (!hasSomeData) {
      logger.debug({ playerName, slug }, "matchstatScraper: page scraped but no usable data extracted");
      return null;
    }

    logger.info(
      {
        playerName,
        slug,
        surfaces: Object.keys(surfaceRecords),
        hasOverall: overallRecord !== null,
        hasRecent: recentRecord !== null,
      },
      "matchstatScraper: successfully scraped player data",
    );

    return {
      surfaceRecords: surfaceRecords as MatchstatPlayerData["surfaceRecords"],
      recentRecord,
      overallRecord,
      slug,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      logger.debug({ playerName, slug }, "matchstatScraper: request timed out");
    } else {
      logger.warn({ err, playerName, slug }, "matchstatScraper: unexpected error");
    }
    return null;
  }
}
