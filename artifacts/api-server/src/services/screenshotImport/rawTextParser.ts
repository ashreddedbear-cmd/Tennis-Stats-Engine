/**
 * rawTextParser — converts plain OCR text (from OCR.Space or a local Tesseract binary)
 * into RawMatchupEntry[] using heuristics.
 *
 * Vision AI providers (OpenAI, Gemini, Anthropic) do this via prompt-structured JSON.
 * Text-extraction providers give us raw strings; this module bridges that gap.
 *
 * Heuristics applied in order:
 *   1. Inline "X vs Y" / "X v Y" / "X def. Y" patterns on the same line
 *   2. Consecutive candidate-name lines (two name-like lines back-to-back)
 *
 * A "name-like" line:
 *   - Contains at least one letter
 *   - Does NOT look like a score, time, date, odds line, or decoration
 *   - Is 3–60 chars after trimming
 */

import type { RawMatchupEntry } from "../tennisData/screenshotRecognition.js";

// Patterns that indicate a line is NOT a player name
const SKIP_PATTERNS = [
  /^\d{1,2}:\d{2}/, // time "14:30"
  /^\d{1,2}\/\d{1,2}\/\d{2,4}/, // date "07/26/2024"
  /^[+\-]?\d+(\.\d+)?$/, // pure number (odds, score, rank)
  /^\d+-\d+$/, // score "6-3"
  /\d{2,}%/, // percentage "65%"
  /^(ATP|WTA|ITF|USD|EUR|GBP|\$|€|£)/, // currency / tour prefix
  /^(live|upcoming|scheduled|finished|court\s?\d|round\s?\d)/i, // status text
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, // day names
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i, // month prefixes
  /^\[|\]$/, // bracket lines
  /^[-—–_=*#•>|]+$/, // decoration-only lines
  // Sportsbook UI labels and betting market type names
  /^(moneyline|spread|total|over|under|parlay|combo|teaser|prop|futures|handicap|sgp)$/i,
  /^(today|tomorrow|continue|back|next|more|home|add|remove|confirm|submit|view|open|close)$/i,
  /^(pro baseball|nfl|nba|nhl|mlb|mls|pga|mma|ufc|soccer|football|basketball|baseball|hockey|golf)$/i,
  /\bmarket[s]?\b/i, // "5 Markets", "Combo 3 Markets"
  /\bleg\s+parlay\b/i, // "3 leg parlay"
  /@/, // anything with @ (time references like "/ @ 4:20PM EDT")
  /\b(am|pm)\b.*\b(edt|est|pst|mst|cst|pt|ct|et|mt)\b/i, // time+timezone
];

function isNameLike(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  return !SKIP_PATTERNS.some((p) => p.test(t));
}

function cleanName(raw: string): string | null {
  // Strip leading/trailing punctuation, seed numbers "(1)", bracket chars
  const cleaned = raw
    .replace(/^\(\d+\)\s*/, "")   // "(1) "
    .replace(/\s*\(\d+\)$/, "")   // " (1)"
    .replace(/^[\s\-–—:]+/, "")
    .replace(/[\s\-–—:]+$/, "")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

export function parseOcrText(text: string): RawMatchupEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const matchups: RawMatchupEntry[] = [];

  // Strategy 1 — inline "X vs Y" on the same line
  const vsRe = /^(.+?)\s+(?:vs?\.?|def\.?|–|-)\s+(.+)$/i;
  for (const line of lines) {
    const m = vsRe.exec(line);
    if (m) {
      const p1 = cleanName(m[1]);
      const p2 = cleanName(m[2]);
      if (p1 && p2 && p1 !== p2) {
        matchups.push({ player1Name: p1, player2Name: p2, eventName: null });
      }
    }
  }

  if (matchups.length > 0) return matchups;

  // Strategy 2 — consecutive name-like lines treated as a pair
  const nameLines = lines.filter(isNameLike);
  for (let i = 0; i + 1 < nameLines.length; i += 2) {
    const p1 = cleanName(nameLines[i]);
    const p2 = cleanName(nameLines[i + 1]);
    if (p1 && p2 && p1 !== p2) {
      matchups.push({ player1Name: p1, player2Name: p2, eventName: null });
    }
  }

  return matchups;
}
