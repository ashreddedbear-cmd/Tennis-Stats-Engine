/**
 * Tolerant parsing of pasted matchup lines like "Player A vs Player B — Tournament"
 * into a structured shape. Real pasted lists vary in separator style (em dash, hyphen, "@", "in"
 * for the tournament; "vs", "vs.", "v", "versus", "-", "—" for the players), so this never assumes
 * an exact template -- it only reports a parsed shape when it can confidently find the vs-split,
 * and always flags lines it can't split rather than guessing.
 *
 * Tournament section headers (e.g. "ATP Estoril", "WTA Prague", "Challenger Poznan") are silently
 * recognised and returned with isTournamentHeader: true so callers can carry the name forward as
 * context for subsequent matchup lines without showing a parse error.
 */

export interface ParsedMatchupLine {
  raw: string
  /** Non-null only when the line could be split into exactly two player names. */
  playerAName: string | null
  playerBName: string | null
  /** Present only when the line had a recognizable trailing tournament segment. */
  tournamentName: string | null
  /**
   * Date annotation extracted from anywhere in the raw line -- display only, never used to gate
   * predictions. Recognises ISO dates ("2026-07-04"), common month-day patterns ("July 4",
   * "Jul 4th"), and the literal word "tomorrow". Null when no recognisable date is present.
   */
  matchDate: string | null
  /** Set when the line could not be split into two player names -- never guessed. */
  parseError: string | null
  /**
   * True when the line is a tournament section header (e.g. "ATP Estoril", "WTA Prague",
   * "Challenger Poznan") rather than a matchup. Callers should skip rendering these as errors
   * and carry the header text forward as tournament context for subsequent lines until the next
   * header overrides it.
   */
  isTournamentHeader: boolean
}

// Ordered longest-separator-first so "vs." isn't left with a trailing period matched separately,
// and so multi-char separators aren't shadowed by a shorter one that happens to be a substring.
const VS_SEPARATOR_PATTERN = /\s+(?:vs\.?|versus|v\.)\s+/i

// Leading bullet/list markers from pasted rendered lists: "*", "-", "•", or a leading "1." / "1)"
// numbering. These are stripped before splitting so the marker never leaks into `playerAName`.
// A leading "-" marker is only stripped when followed by whitespace, so a genuinely hyphenated
// leading name segment is never mistaken for a marker.
const LEADING_LIST_MARKER_PATTERN = /^(?:[*•]|-(?=\s)|\d+[.)])\s*/

function stripLeadingListMarker(line: string): string {
  return line.replace(LEADING_LIST_MARKER_PATTERN, "").trim()
}

// Parenthetical tournament suffix: "A vs B (Wimbledon)" → strip "(Wimbledon)" and use as tournament.
// Must be at the very end of the line (trailing). Only strips when the paren content is non-empty.
const PAREN_TOURNAMENT_PATTERN = /\s*\(([^)]+)\)\s*$/

// A bare " v " or " - " is ambiguous with hyphenated player names, so these looser separators are
// only tried once the primary VS_SEPARATOR_PATTERN fails to match.
// Em dash and en dash are included here as last-resort player separators (see splitTournament below
// for why they are normally tried as tournament separators first, and when they fall through).
const LOOSE_VS_SEPARATOR_PATTERN = /\s+(?:v|[—–]|-)\s+/i

// Tried in order; each one splits on its LAST occurrence in the line (the tournament segment is
// always trailing), so a hyphenated player surname earlier in the line is never mistaken for the
// tournament separator itself. Em dash / en dash and "@"/"at"/"in" are unambiguous; the plain
// " - " variant is tried last since it's the one most likely to collide with a hyphenated name.
const TOURNAMENT_SEPARATOR_PATTERNS = [/[—–]/g, /\s+@\s+/gi, /\s+\bat\b\s+/gi, /\s+\bin\b\s+/gi, /\s+-\s+/g]

/**
 * Matches lines that are tour/level section headers rather than matchups.
 * Patterns covered:
 *   ATP <name> / WTA <name>
 *   Challenger <name> / ITF <name>
 *   Grade codes: M15, W25, M100, etc.
 *   Bare: "Grand Slam", "Masters", "Finals"
 * A line with any vs-separator is never treated as a header regardless of how it starts.
 */
const TOURNAMENT_HEADER_PATTERN =
  /^(?:ATP|WTA|Challenger|ITF|M\d+|W\d+|Grand\s+Slam|Masters|Finals)(?:\s+.*)?$/i

function isTournamentHeaderLine(line: string): boolean {
  // If the line contains a player separator it's a matchup, not a header.
  if (VS_SEPARATOR_PATTERN.test(line)) return false
  if (LOOSE_VS_SEPARATOR_PATTERN.test(line)) return false
  return TOURNAMENT_HEADER_PATTERN.test(line)
}

function lastMatch(pattern: RegExp, line: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    last = match
  }
  return last
}

/**
 * Handles "Last, First" reversed names by flipping at the comma.
 * Only flips when there is exactly one comma -- multiple commas are left as-is (too ambiguous).
 */
function normalizePlayerName(name: string): string {
  const commaIdx = name.indexOf(",")
  if (commaIdx === -1) return name
  if (name.indexOf(",", commaIdx + 1) !== -1) return name
  const lastName = name.slice(0, commaIdx).trim()
  const firstName = name.slice(commaIdx + 1).trim()
  if (!lastName || !firstName) return name
  return `${firstName} ${lastName}`
}

function splitPlayers(matchPart: string): [string, string] | null {
  const primary = VS_SEPARATOR_PATTERN.exec(matchPart)
  const pattern = primary ?? LOOSE_VS_SEPARATOR_PATTERN.exec(matchPart)
  if (!pattern) return null

  const playerAName = normalizePlayerName(matchPart.slice(0, pattern.index).trim())
  const playerBName = normalizePlayerName(matchPart.slice(pattern.index + pattern[0].length).trim())
  if (!playerAName || !playerBName) return null
  return [playerAName, playerBName]
}

/**
 * Splits a line into the match-describing part and an optional trailing tournament name.
 * Em dash / en dash are only used as tournament separators when the part before them already
 * contains a player-vs-player separator -- if they don't (e.g. "Alcaraz — Sinner" with no "vs"),
 * they fall through so LOOSE_VS_SEPARATOR_PATTERN can pick them up as the player separator instead.
 */
function splitTournament(line: string): { matchPart: string; tournamentName: string | null } {
  for (const pattern of TOURNAMENT_SEPARATOR_PATTERNS) {
    const match = lastMatch(pattern, line)
    if (match && match.index > 0) {
      const matchPart = line.slice(0, match.index).trim()
      const tournamentName = line.slice(match.index + match[0].length).trim()
      if (matchPart && tournamentName) {
        if (/[—–]/.test(match[0]) && !VS_SEPARATOR_PATTERN.test(matchPart) && !LOOSE_VS_SEPARATOR_PATTERN.test(matchPart)) {
          continue
        }
        return { matchPart, tournamentName }
      }
    }
  }
  return { matchPart: line.trim(), tournamentName: null }
}

// ── Date extraction ────────────────────────────────────────────────────────
// Non-binding annotation only. Patterns recognised (tried in order):
//   1. ISO date:    2026-07-04
//   2. Month-day:   July 4 / Jul 4 / July 14th
//   3. Literal:     tomorrow

const ISO_DATE_RE = /\b(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/

const MONTH_NAMES = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?"
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  "i",
)

const TOMORROW_RE = /\btomorrow\b/i

function extractDate(line: string): string | null {
  const iso = ISO_DATE_RE.exec(line)
  if (iso) return iso[1]

  const md = MONTH_DAY_RE.exec(line)
  if (md) return `${md[1]} ${md[2]}`

  if (TOMORROW_RE.test(line)) return "tomorrow"

  return null
}

export function parseMatchupLine(rawLine: string): ParsedMatchupLine {
  const raw = rawLine.trim()
  if (!raw) {
    return {
      raw, playerAName: null, playerBName: null, tournamentName: null,
      matchDate: null, parseError: "Empty line", isTournamentHeader: false,
    }
  }

  const withoutMarker = stripLeadingListMarker(raw)

  // Detect tournament section headers FIRST — before any vs-split attempt.
  // e.g. "ATP Estoril", "WTA Prague", "Challenger Poznan" with no vs-separator.
  if (isTournamentHeaderLine(withoutMarker)) {
    return {
      raw,
      playerAName: null,
      playerBName: null,
      tournamentName: withoutMarker,
      matchDate: null,
      parseError: null,
      isTournamentHeader: true,
    }
  }

  // Extract a date annotation independently of player/tournament splitting.
  const matchDate = extractDate(raw)

  // Step 1: strip a parenthetical tournament suffix — "(Wimbledon)" at end of line.
  const parenMatch = PAREN_TOURNAMENT_PATTERN.exec(withoutMarker)
  const parenTournament = parenMatch ? parenMatch[1].trim() : null
  const lineForSplit = parenTournament ? withoutMarker.slice(0, parenMatch!.index).trim() : withoutMarker

  // Step 2: split on a trailing tournament separator, then player-split the remaining match part.
  const { matchPart, tournamentName: splitTournamentName } = splitTournament(lineForSplit)
  const finalTournament = parenTournament ?? splitTournamentName

  const players = splitPlayers(matchPart)
  if (players) {
    return {
      raw, playerAName: players[0], playerBName: players[1],
      tournamentName: finalTournament, matchDate, parseError: null, isTournamentHeader: false,
    }
  }

  return {
    raw,
    playerAName: null,
    playerBName: null,
    tournamentName: finalTournament,
    matchDate,
    parseError: 'Could not find a "vs" separator between two player names',
    isTournamentHeader: false,
  }
}

/** Splits pasted text into non-empty lines and parses each one independently. */
export function parseMatchupLines(text: string): ParsedMatchupLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseMatchupLine)
}
