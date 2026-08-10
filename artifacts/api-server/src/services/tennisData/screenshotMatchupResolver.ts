import type { Fixture, PlayerSummary, TennisDataProvider } from "./types";
import { searchKnownPlayers } from "./playerIdentity";
import { inferSurfaceAndLevel } from "./surfaceMap";
import type { RawScreenshotRecognition, RawMatchupEntry } from "./screenshotRecognition";

/**
 * Resolves raw names/event read off a screenshot against real trusted sources --
 * the same player search the manual "Search Players" flow uses.
 *
 * Supports images containing multiple matchups (long screenshots, bracket pages):
 * each entry is resolved independently so a single unresolvable matchup never
 * blocks the rest.
 *
 * Never fabricates a match: a recognized name only resolves to a player when
 * exactly one confident candidate exists; ambiguous or absent matches come back
 * null with an explanatory warning instead of guessing.
 */

export interface ScreenshotPlayerMatch {
  recognizedName: string | null;
  player: PlayerSummary | null;
  /** "resolved" | "best-guess" | "ambiguous" | "not-found" | "unreadable". Included in API response for UI disambiguation. */
  status?: string;
  /** Populated when status === "ambiguous". The confident candidates the resolver couldn't narrow to one. */
  candidates?: PlayerSummary[];
}

export interface ScreenshotEventMatch {
  recognizedName: string | null;
  surface: import("./types").Surface | null;
  level: import("./types").TournamentLevel | null;
}

export interface ScreenshotMatchupEntry {
  player1: ScreenshotPlayerMatch;
  player2: ScreenshotPlayerMatch;
  event: ScreenshotEventMatch;
  /** True when both players were confidently resolved to real players. */
  resolved: boolean;
  /** Per-matchup warnings for anything not confidently resolved in this entry. */
  warnings: string[];
}

export interface ScreenshotMatchupResult {
  /** Primary matchup (first recognized entry). Kept for backward compatibility. */
  player1: ScreenshotPlayerMatch;
  player2: ScreenshotPlayerMatch;
  event: ScreenshotEventMatch;
  warnings: string[];
  /**
   * All matchups extracted from the screenshot. Includes the primary as matchups[0].
   */
  matchups?: ScreenshotMatchupEntry[];
}

interface PlayerResolveOutcome {
  match: ScreenshotPlayerMatch;
  /**
   * - resolved    — exactly one confident match.
   * - best-guess  — zero confident matches, but OCR fuzzy fallback found exactly one surname
   *                 within edit-distance ≤1. Player is set but a disclaimer warning is emitted.
   * - ambiguous   — multiple distinct confident matches.
   * - not-found   — no match at all (no fuzzy candidate either).
   * - unreadable  — the name field was null/empty in the OCR result.
   */
  status: "resolved" | "best-guess" | "unreadable" | "ambiguous" | "not-found";
  /**
   * Populated when status === "ambiguous".
   * The confident candidates that caused the tie — used by the caller to attempt
   * opponent-fixture cross-disambiguation before giving up.
   */
  candidates?: PlayerSummary[];
}

interface FixtureCandidate {
  fixture: Fixture;
  score: number;
  nameScore: number;
  orientation: "direct" | "swapped";
}

interface SingleSideInference {
  fixture: Fixture;
  orientation: "direct" | "swapped";
  rule: "fixture-opponent-inference-from-player1" | "fixture-opponent-inference-from-player2";
}

// ── OCR metadata stripping ────────────────────────────────────────────────
//
// Draw sheets attach tokens to player names that are NOT part of the name:
//   - Draw status:   (WC) (Q) (LL) (ALT) (SE) (PR)  — wild card, qualifier, etc.
//   - Seed:          #3   [12]
//   - Birth year:    2004  (for juniors)
//   - Name suffixes: Jr.  Sr.  II  III  IV
//   - Trailing initial: "Tom Miyoshi B."
//   - OCR noise:     zero-width spaces, emoji, control chars
//
// stripOcrMetadata removes these before any matching attempt, while
// resolvePlayerMatch preserves the ORIGINAL OCR text for display and debugging.

const DRAW_STATUS_TOKENS = ["WC", "Q", "LL", "ALT", "SE", "PR", "ITR", "PTR", "IDP"];
const DRAW_STATUS_SET = new Set(DRAW_STATUS_TOKENS.map((t) => t.toLowerCase()));

function stripOcrMetadata(raw: string): string {
  // 1. Remove invisible / control / zero-width characters
  let s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\ufeff]/g, " ")
    // Emoji and misc BMP symbols (keep letters, digits, spaces, and common name punctuation).
    // NOTE: \uXXXX notation only supports 4-digit code points; supplementary-plane emoji
    // (U+1F000+) are not listed here because \u1F000 without braces would create a
    // broken character range covering ASCII. normalizeName() strips any remaining
    // non-ASCII noise after this step.
    .replace(/[\u2600-\u27FF\u2B00-\u2BFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 2. Parenthesized/bracketed draw-status tokens: (WC) [Q] (LL) (ALT) (SE) (PR)
  s = s.replace(/\s*[\[(]\s*([A-Za-z]{1,5})\s*[\])]\s*/g, (match, token) => {
    return DRAW_STATUS_SET.has(token.toLowerCase()) ? " " : match;
  });

  // 3. Trailing birth year (realistic range for tennis players: 1960–2015)
  s = s.replace(/\s+\b(19[6-9]\d|200\d|201[0-5])\b\s*$/, "");

  // 4. Trailing seed/draw-position: #3  #12
  s = s.replace(/\s+#\d{1,3}\s*$/, "");

  // 5. Trailing standalone draw-status tokens (not in parens)
  const statusPattern = new RegExp(`\\s+\\b(${DRAW_STATUS_TOKENS.join("|")})\\b\\s*$`, "i");
  s = s.replace(statusPattern, "");

  // 6. Trailing name suffixes: Jr Jr. Sr Sr. II III IV V VI VII VIII IX
  //    Roman numerals are almost never part of a player's competition name.
  s = s.replace(/\s+\b(jr\.?|sr\.?|ii|iii|iv|ix|vi{0,3}|v)\b\.?\s*$/i, "");

  // 7. Trailing single uppercase initial + optional period, when ≥3 name words remain.
  //    "Tom Miyoshi B."  →  "Tom Miyoshi"
  //    "Tom Miyoshi B. 2004" has already lost "2004" above, so this catches "B."
  const words = s.trim().split(/\s+/);
  if (words.length >= 3 && /^[A-Z]\.?$/.test(words[words.length - 1])) {
    s = words.slice(0, -1).join(" ");
  }

  return s.replace(/\s+/g, " ").trim();
}

// ── Name normalization ─────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (accents, etc.)
    .toLowerCase()
    // Expand dot-separated multi-initial patterns ("j.j." → "j j ") so each initial
    // becomes a separate token. Without this, "J.J. Wolf" collapses to "jj wolf" and
    // the bijective initial-expansion in wordsMatch (which only handles 1-char tokens)
    // can't match it against "jeffrey john wolf".
    .replace(/\b([a-z])\.([a-z])\./g, "$1 $2 ")
    .replace(/[^a-z0-9\s]/g, "")    // keep only ASCII letters, digits, spaces
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLooseText(text: string | null | undefined): string {
  if (!text) return "";
  return normalizeName(text).replace(/\s+/g, " ").trim();
}

function isWeakOcrIdentityKey(normalizedName: string): boolean {
  const words = normalizedName.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  // "G. Castro"-style inputs are identity-weak for singles disambiguation.
  return words[0]!.length === 1;
}

function editDistanceWithin(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    let minInRow = next[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (next[j] < minInRow) minInRow = next[j];
    }
    if (minInRow > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }

  return prev[b.length];
}

function fuzzyWordMatch(a: string, b: string): boolean {
  if (wordsMatch(a, b)) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const distance = editDistanceWithin(a, b, 1);
  return distance <= 1;
}

function tokenOverlapScore(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = right.split(" ").filter(Boolean);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const used = new Set<number>();
  let matched = 0;
  for (const token of leftTokens) {
    for (let i = 0; i < rightTokens.length; i++) {
      if (!used.has(i) && fuzzyWordMatch(token, rightTokens[i])) {
        used.add(i);
        matched++;
        break;
      }
    }
  }

  return matched / Math.max(leftTokens.length, rightTokens.length);
}

function stringSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 0;
  const threshold = Math.min(3, Math.ceil(maxLen * 0.3));
  const distance = editDistanceWithin(left, right, threshold);
  if (distance > threshold) return 0;
  return Math.max(0, 1 - distance / maxLen);
}

function scoreNamePair(recognizedName: string | null, fixtureName: string): number {
  if (!recognizedName) return 0;

  const recognizedNorm = normalizeName(stripOcrMetadata(recognizedName));
  const fixtureNorm = normalizeName(fixtureName);
  if (!recognizedNorm || !fixtureNorm) return 0;
  if (isConfidentMatch(recognizedNorm, fixtureNorm)) return 1;

  const tokenScore = tokenOverlapScore(recognizedNorm, fixtureNorm);
  const charScore = stringSimilarity(recognizedNorm, fixtureNorm);
  return Math.max(tokenScore, charScore * 0.9);
}

function inferRoundLabel(text: string | null | undefined): string | null {
  const norm = normalizeLooseText(text);
  if (!norm) return null;
  if (/\bqf\b|quarter\s*final/.test(norm)) return "QF";
  if (/\bsf\b|semi\s*final/.test(norm)) return "SF";
  if (/\bfinal\b/.test(norm) && !/semi/.test(norm)) return "F";
  if (/\br16\b|round\s*of\s*16/.test(norm)) return "R16";
  if (/\br32\b|round\s*of\s*32/.test(norm)) return "R32";
  if (/\br64\b|round\s*of\s*64/.test(norm)) return "R64";
  return null;
}

function eventSimilarity(recognizedEvent: string | null, fixtureEvent: string | null): number {
  const left = normalizeLooseText(recognizedEvent);
  const right = normalizeLooseText(fixtureEvent);
  if (!left || !right) return 0;
  const tokenScore = tokenOverlapScore(left, right);
  const charScore = stringSimilarity(left, right);
  return Math.max(tokenScore, charScore);
}

function prunePlayerWarningsForLabel(warnings: string[], label: "Player 1" | "Player 2"): string[] {
  return warnings.filter((w) => !w.includes(`for ${label}`) && !w.startsWith(`${label} could not be read`));
}

function fixturePlayerSummary(fixture: Fixture, slot: "player1" | "player2"): PlayerSummary {
  return slot === "player1"
    ? {
        id: fixture.player1Id,
        name: fixture.player1Name,
        countryCode: null,
        currentRank: null,
        tour: null,
      }
    : {
        id: fixture.player2Id,
        name: fixture.player2Name,
        countryCode: null,
        currentRank: null,
        tour: null,
      };
}

function resolvedPlayerFitsFixtureSlot(
  resolved: PlayerSummary,
  fixtureId: string,
  fixtureName: string,
): boolean {
  if (resolved.id === fixtureId) return true;

  const resolvedNorm = normalizeName(stripOcrMetadata(resolved.name));
  const fixtureNorm = normalizeName(fixtureName);
  if (!resolvedNorm || !fixtureNorm) return false;

  return isConfidentMatch(resolvedNorm, fixtureNorm) || isConfidentMatch(fixtureNorm, resolvedNorm);
}

function scoreFixtureCandidate(params: {
  fixture: Fixture;
  entry: RawMatchupEntry;
  event: ScreenshotEventMatch;
  resolvedPlayer1: PlayerSummary | null;
  resolvedPlayer2: PlayerSummary | null;
}): FixtureCandidate | null {
  const directA = scoreNamePair(params.entry.player1Name, params.fixture.player1Name);
  const directB = scoreNamePair(params.entry.player2Name, params.fixture.player2Name);
  const swapA = scoreNamePair(params.entry.player1Name, params.fixture.player2Name);
  const swapB = scoreNamePair(params.entry.player2Name, params.fixture.player1Name);

  const directScores = [
    params.entry.player1Name ? directA : null,
    params.entry.player2Name ? directB : null,
  ].filter((v): v is number => v !== null);
  const swappedScores = [
    params.entry.player1Name ? swapA : null,
    params.entry.player2Name ? swapB : null,
  ].filter((v): v is number => v !== null);
  const directNameScore = directScores.length > 0 ? directScores.reduce((sum, s) => sum + s, 0) / directScores.length : 0;
  const swappedNameScore = swappedScores.length > 0 ? swappedScores.reduce((sum, s) => sum + s, 0) / swappedScores.length : 0;
  const orientation = swappedNameScore > directNameScore ? "swapped" : "direct";
  const nameScore = orientation === "direct" ? directNameScore : swappedNameScore;

  // Reject very weak pair matches when both OCR names exist.
  const bothNamesPresent = !!params.entry.player1Name && !!params.entry.player2Name;
  if (bothNamesPresent && nameScore < 0.62) return null;

  const fixtureFirstId = orientation === "direct" ? params.fixture.player1Id : params.fixture.player2Id;
  const fixtureSecondId = orientation === "direct" ? params.fixture.player2Id : params.fixture.player1Id;

  if (
    params.resolvedPlayer1
    && !resolvedPlayerFitsFixtureSlot(params.resolvedPlayer1, fixtureFirstId, orientation === "direct" ? params.fixture.player1Name : params.fixture.player2Name)
  ) return null;
  if (
    params.resolvedPlayer2
    && !resolvedPlayerFitsFixtureSlot(params.resolvedPlayer2, fixtureSecondId, orientation === "direct" ? params.fixture.player2Name : params.fixture.player1Name)
  ) return null;

  let score = nameScore;
  const eventScore = eventSimilarity(params.entry.eventName, params.fixture.tournamentName);
  score += eventScore * 0.2;

  if (params.event.level && params.fixture.tournamentLevel) {
    score += params.event.level === params.fixture.tournamentLevel ? 0.12 : -0.08;
  }

  if (params.event.surface && params.fixture.surface) {
    score += params.event.surface === params.fixture.surface ? 0.1 : -0.06;
  }

  const recognizedRound = inferRoundLabel(params.entry.eventName);
  const fixtureRound = inferRoundLabel(params.fixture.round);
  if (recognizedRound && fixtureRound) {
    score += recognizedRound === fixtureRound ? 0.08 : -0.05;
  }

  return { fixture: params.fixture, score, nameScore, orientation };
}

function resolveFromFixtureCandidate(
  candidate: FixtureCandidate,
  existingPlayer1: ScreenshotPlayerMatch,
  existingPlayer2: ScreenshotPlayerMatch,
): { player1: ScreenshotPlayerMatch; player2: ScreenshotPlayerMatch } {
  const firstSlot = candidate.orientation === "direct" ? "player1" : "player2";
  const secondSlot = candidate.orientation === "direct" ? "player2" : "player1";

  return {
    player1: existingPlayer1.player
      ? existingPlayer1
      : { recognizedName: existingPlayer1.recognizedName, player: fixturePlayerSummary(candidate.fixture, firstSlot) },
    player2: existingPlayer2.player
      ? existingPlayer2
      : { recognizedName: existingPlayer2.recognizedName, player: fixturePlayerSummary(candidate.fixture, secondSlot) },
  };
}

function pickUniqueFixtureCandidate(candidates: FixtureCandidate[]): FixtureCandidate | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  if (ranked[0].nameScore < 0.68) return null;
  if (ranked.length === 1) return ranked[0];
  if (ranked[0].score - ranked[1].score < 0.06) return null;
  return ranked[0];
}

function inferUniqueOpponentFromSingleResolvedSide(params: {
  entry: RawMatchupEntry;
  event: ScreenshotEventMatch;
  resolvedPlayer1: PlayerSummary | null;
  resolvedPlayer2: PlayerSummary | null;
  fixtures: Fixture[];
}): SingleSideInference | null {
  // This rule only applies when exactly one side is already resolved by player search.
  if (!!params.resolvedPlayer1 === !!params.resolvedPlayer2) return null;

  const unresolvedName = params.resolvedPlayer1 ? params.entry.player2Name : params.entry.player1Name;
  if (!unresolvedName) return null;

  type OpponentHit = { fixture: Fixture; orientation: "direct" | "swapped"; key: string; score: number };
  const hits: OpponentHit[] = [];

  for (const fixture of params.fixtures) {
    const directFirstFits = params.resolvedPlayer1
      ? resolvedPlayerFitsFixtureSlot(params.resolvedPlayer1, fixture.player1Id, fixture.player1Name)
      : resolvedPlayerFitsFixtureSlot(params.resolvedPlayer2!, fixture.player2Id, fixture.player2Name);
    const swappedFirstFits = params.resolvedPlayer1
      ? resolvedPlayerFitsFixtureSlot(params.resolvedPlayer1, fixture.player2Id, fixture.player2Name)
      : resolvedPlayerFitsFixtureSlot(params.resolvedPlayer2!, fixture.player1Id, fixture.player1Name);

    if (!directFirstFits && !swappedFirstFits) continue;

    if (directFirstFits) {
      const opponentScore = params.resolvedPlayer1
        ? scoreNamePair(unresolvedName, fixture.player2Name)
        : scoreNamePair(unresolvedName, fixture.player1Name);
      if (opponentScore >= 0.74) {
        const opponentName = params.resolvedPlayer1 ? fixture.player2Name : fixture.player1Name;
        hits.push({
          fixture,
          orientation: "direct",
          key: `${normalizeName(opponentName)}|${params.resolvedPlayer1 ? fixture.player2Id : fixture.player1Id}`,
          score: opponentScore + eventSimilarity(params.entry.eventName, fixture.tournamentName) * 0.15,
        });
      }
    }

    if (swappedFirstFits) {
      const opponentScore = params.resolvedPlayer1
        ? scoreNamePair(unresolvedName, fixture.player1Name)
        : scoreNamePair(unresolvedName, fixture.player2Name);
      if (opponentScore >= 0.74) {
        const opponentName = params.resolvedPlayer1 ? fixture.player1Name : fixture.player2Name;
        hits.push({
          fixture,
          orientation: "swapped",
          key: `${normalizeName(opponentName)}|${params.resolvedPlayer1 ? fixture.player1Id : fixture.player2Id}`,
          score: opponentScore + eventSimilarity(params.entry.eventName, fixture.tournamentName) * 0.15,
        });
      }
    }
  }

  if (hits.length === 0) return null;

  // Collapse duplicate rows of the same inferred opponent identity.
  const byOpponent = new Map<string, OpponentHit[]>();
  for (const hit of hits) {
    const list = byOpponent.get(hit.key) ?? [];
    list.push(hit);
    byOpponent.set(hit.key, list);
  }

  if (byOpponent.size !== 1) return null;

  const best = [...byOpponent.values()][0].sort((a, b) => b.score - a.score)[0];
  return {
    fixture: best.fixture,
    orientation: best.orientation,
    rule: params.resolvedPlayer1
      ? "fixture-opponent-inference-from-player1"
      : "fixture-opponent-inference-from-player2",
  };
}

async function getTodayFixtures(provider: TennisDataProvider): Promise<Fixture[]> {
  const todayDate = new Date();
  const today = todayDate.toISOString().slice(0, 10);
  try {
    const sameDay = await provider.getUpcomingFixtures(today);

    // Always include a small adjacent-day range when available: some providers split fixtures
    // across nearby calendar days relative to server UTC even when they belong to the same local
    // tournament day. Limiting to ±1/+2 keeps this tight while preventing false "unresolved"
    // skips caused by date-boundary drift.
    if (!provider.getUpcomingFixturesRange) return sameDay;

    const startDate = new Date(todayDate);
    startDate.setUTCDate(startDate.getUTCDate() - 1);
    const stopDate = new Date(todayDate);
    stopDate.setUTCDate(stopDate.getUTCDate() + 2);
    const start = startDate.toISOString().slice(0, 10);
    const stop = stopDate.toISOString().slice(0, 10);
    const range = await provider.getUpcomingFixturesRange(start, stop);
    const deduped = new Map<string, Fixture>();
    for (const fixture of [...sameDay, ...range]) deduped.set(fixture.id, fixture);
    return Array.from(deduped.values());
  } catch {
    return [];
  }
}

// ── Word-level matching ────────────────────────────────────────────────────

/**
 * Returns true when two normalized name tokens should be treated as the same word.
 *
 * Three match strategies:
 *   1. Exact equality
 *   2. Initial expansion — a single letter is an initial of any word starting with it
 *      ("p" matches "paula", "g" matches "goncalo")
 *   3. Transliteration tolerance — for words of 4+ chars, allow 1-char substitution.
 *      Covers common romanization variants ("maiar" ↔ "mayar", Arabic ai/ay),
 *      Eastern European transliterations, and single OCR misreads.
 */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Initial expansion (bidirectional)
  if (a.length === 1 && b.length > 1 && b[0] === a) return true;
  if (b.length === 1 && a.length > 1 && a[0] === b) return true;
  // Transliteration/OCR tolerance: 1-char substitution for words of ≥4 chars
  if (a.length >= 4 && a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diffs > 1) return false;
    }
    if (diffs === 1) return true;
  }
  return false;
}

/**
 * Checks whether a set of normalized player name word arrays forms an unambiguous
 * initial-equivalent group that can safely be collapsed to a single resolved player.
 *
 * The group collapses when ALL of the following hold:
 *   1. Every candidate has the same full surname part (every word after the first word).
 *      "G. Castro" (→ surname "castro") and "Goncalo Da Rosa Castro"
 *      (→ surname "da rosa castro") have DIFFERENT surname parts and must NOT collapse.
 *   2. At least one candidate has a single-character first name (an initial).
 *      Two full-name candidates like "Gonzalo Castro" + "Geraldo Castro" are genuinely
 *      different players; they have no initial to act as a shared abbreviation.
 *   3. There is exactly ONE distinct full first name (length > 1) in the group.
 *      "G. Kravchenko" + "Georgii Kravchenko" + "Goncalo Kravchenko" has TWO distinct
 *      full first names, so the initial is still ambiguous; must remain "ambiguous".
 *   4. Every single-character first name equals the first character of that full first
 *      name. This is a strict string equality check — NOT the OCR/transliteration
 *      tolerance in wordsMatch — to prevent false collapses from OCR misreads.
 *
 * Exported for unit testing; not part of the public API surface.
 */
export function isInitialEquivalentGroup(normWordArrays: readonly string[][]): boolean {
  if (normWordArrays.length < 2) return false;
  // Every candidate must have at least a first word and a surname part
  if (normWordArrays.some((w) => w.length < 2)) return false;

  // Rule 1: all must share the same full surname part (every word after the first)
  const surnamePart = normWordArrays[0]!.slice(1).join(" ");
  if (!normWordArrays.every((w) => w.slice(1).join(" ") === surnamePart)) return false;

  const firstWords = normWordArrays.map((w) => w[0]!);

  // Rule 2: at least one single-char initial present
  if (firstWords.every((f) => f.length > 1)) return false;

  // Rule 3: exactly one distinct full first name
  const distinctFullFirstNames = new Set(firstWords.filter((f) => f.length > 1));
  if (distinctFullFirstNames.size === 0) return false; // only initials — nothing to expand to
  if (distinctFullFirstNames.size > 1) return false;   // multiple expansions — genuinely ambiguous

  // Rule 4: every initial must equal the first character of the single full first name
  // (strict equality — no OCR/transliteration tolerance)
  const fullFirstName = [...distinctFullFirstNames][0]!;
  return firstWords.every(
    (f) => f === fullFirstName || (f.length === 1 && f === fullFirstName[0]),
  );
}

/**
 * Greedy bijective match: every needle consumes exactly one distinct haystack slot.
 *
 * This prevents the "C. Castro" false positive against "Goncalo Da Rosa Castro":
 * the initial "c" would consume "castro", leaving no slot for the explicit "castro"
 * token in the candidate, so the match correctly fails.
 *
 * Without bijection, both "c" and "castro" would independently match "castro" via
 * some(), making "C. Castro" look like a confident match for any "... da Rosa Castro".
 */
function bijectiveMatch(needles: string[], haystack: string[]): boolean {
  const used = new Set<number>();
  for (const needle of needles) {
    let found = false;
    for (let i = 0; i < haystack.length; i++) {
      if (!used.has(i) && wordsMatch(needle, haystack[i])) {
        used.add(i);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * A candidate is a confident match in one of two complementary directions:
 *
 * Forward (recognized ⊆ candidate, bijective):
 *   Every recognized word consumes a distinct candidate word.
 *   Handles a screenshot showing only a surname ("Alcaraz" → "Carlos Alcaraz").
 *
 * Reverse (candidate ⊆ recognized, bijective):
 *   Every candidate word consumes a distinct recognized word.
 *   Handles OCR reading the full formal name while the DB stores an abbreviated
 *   version ("P. Badosa" ← "Paula Badosa", "M. Sherif" ← "Maiar Sherif Ahmed Abdelaziz").
 *   Only applied when the recognized name is at least as long as the candidate, so
 *   we never loosen a shorter OCR read.
 *
 * Bijection in the reverse direction prevents "C. Castro" from matching
 * "Goncalo Da Rosa Castro" — the initial "c" and "castro" would both need to
 * consume "castro", which bijection disallows.
 */
function isConfidentMatch(recognizedNorm: string, candidateNorm: string): boolean {
  if (!recognizedNorm) return false;
  if (recognizedNorm === candidateNorm) return true;

  const rWords = recognizedNorm.split(" ").filter(Boolean);
  const cWords = candidateNorm.split(" ").filter(Boolean);
  if (rWords.length === 0 || cWords.length === 0) return false;

  // Forward: every recognized word bijectively matches some candidate word
  if (bijectiveMatch(rWords, cWords)) return true;

  // Reverse: every candidate word bijectively matches some recognized word
  if (rWords.length >= cWords.length && bijectiveMatch(cWords, rWords)) return true;

  return false;
}

// ── OCR fuzzy fallback ─────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings.
 * Used only on short surname tokens (≤30 chars each) so the O(m·n) allocation is fine.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  const curr: number[] = new Array(n + 1) as number[];
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]!
        : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

/**
 * Extract the surname token from an OCR name.
 * Skips leading initials ("P. Badosa" → "Badosa") and returns the last substantive word.
 */
function extractOcrSurname(searchName: string): string | null {
  const words = searchName.trim().split(/\s+/).filter(Boolean);
  // Filter out single-letter initials with optional dot
  const nonInitials = words.filter((w) => w.replace(/\.$/, "").length > 1);
  const surname = nonInitials[nonInitials.length - 1] ?? null;
  return surname && surname.length >= 3 ? surname : null;
}

/**
 * Common OCR misread substitutions applied to a surname to widen the search pool.
 * Each entry generates one alternative search term (not all combinations — targeted swaps only).
 */
function ocrVariants(surname: string): string[] {
  const variants = new Set<string>();
  variants.add(surname.replace(/l/g, "I"));      // lowercase-l → capital-I
  variants.add(surname.replace(/I/g, "l"));      // capital-I → lowercase-l
  variants.add(surname.replace(/0/g, "O"));      // digit-zero → letter-O
  variants.add(surname.replace(/O/g, "0"));      // letter-O → digit-zero
  variants.add(surname.replace(/rn/g, "m"));     // OCR "rn" fused as "m"
  variants.add(surname.replace(/m/g, "rn"));     // OCR "m" split as "rn"
  variants.add(surname.replace(/VV/g, "W"));     // double-V → W
  variants.delete(surname);                       // already searched — no-op if unchanged
  return Array.from(variants).filter((v) => v !== surname && v.length >= 3);
}

/**
 * When the primary resolution finds zero confident matches, attempt a lenient OCR-error
 * recovery by:
 *   1. Extracting the surname token from the OCR name.
 *   2. Generating common misread variants (l↔I, 0↔O, rn↔m, VV→W).
 *   3. Searching for each variant via searchKnownPlayers.
 *   4. Keeping candidates whose normalized surname is within edit-distance ≤1 of the OCR surname.
 *   5. Returning the single match if unambiguous; null otherwise.
 *
 * Only triggers on surnames ≥3 characters to avoid false positives on very short names.
 */
async function ocrFuzzyFallback(
  provider: TennisDataProvider,
  searchName: string,
): Promise<PlayerSummary | null> {
  const surname = extractOcrSurname(searchName);
  if (!surname) return null;

  const surnameNorm = normalizeName(surname);

  const variantResults = await Promise.all(
    ocrVariants(surname).map((v) => searchKnownPlayers(provider, v)),
  );

  // Deduplicate across all variant searches
  const pool = new Map<string, PlayerSummary>();
  for (const results of variantResults) {
    for (const p of results) {
      if (!pool.has(p.id)) pool.set(p.id, p);
    }
  }

  if (pool.size === 0) return null;

  // Filter to candidates whose surname is within edit-distance ≤1
  const fuzzyMatches = Array.from(pool.values()).filter((p) => {
    const pWords = normalizeName(p.name).split(/\s+/).filter(Boolean);
    const pSurname = pWords[pWords.length - 1] ?? "";
    return pSurname.length >= 3 && levenshtein(surnameNorm, pSurname) <= 1;
  });

  // Exactly one unambiguous best-guess — multiple still means "don't guess"
  return fuzzyMatches.length === 1 ? fuzzyMatches[0]! : null;
}

// ── Candidate gathering ────────────────────────────────────────────────────

/**
 * Gathers player candidates for a recognized name.
 *
 * Primary: search by the full name (handles exact DB entries and live standings).
 * Fallback: when the primary returns no confident matches, retry searching by each
 *   word of the name in reverse order (surname first). This handles abbreviated DB
 *   entries like "P. Badosa" when the OCR read "Paula Badosa": searching "Badosa"
 *   finds "P. Badosa", then isConfidentMatch verifies it via the reverse path.
 */
async function gatherCandidates(provider: TennisDataProvider, searchName: string): Promise<PlayerSummary[]> {
  const norm = normalizeName(searchName);

  // Primary search
  const primary = await searchKnownPlayers(provider, searchName);
  const primaryConfident = primary.filter((c) => isConfidentMatch(norm, normalizeName(c.name)));
  if (primaryConfident.length > 0) return primary;

  // Word-by-word fallback (surname first — most distinctive, fewest false positives)
  // Min length of 2 catches very short surnames (e.g. "Lea Ma" → "Ma" is 2 chars).
  const words = searchName.trim().split(/\s+/).filter((w) => w.length >= 2).reverse();
  const accumulated = new Map<string, PlayerSummary>();
  for (const p of primary) accumulated.set(p.id, p);

  for (const word of words) {
    const wordResults = await searchKnownPlayers(provider, word);
    for (const c of wordResults) {
      if (!accumulated.has(c.id)) accumulated.set(c.id, c);
    }
    // Stop as soon as at least one confident match exists in the accumulated set
    const hasConfident = Array.from(accumulated.values()).some((c) => isConfidentMatch(norm, normalizeName(c.name)));
    if (hasConfident) break;
  }

  return Array.from(accumulated.values());
}

// ── Player resolution ──────────────────────────────────────────────────────

/**
 * Strict OCR resolution: requires exactly one confident match or returns null.
 * Never substitutes a different player due to specificity/ranking heuristics.
 * All ambiguity is reported to the user for manual disambiguation.
 *
 * @param eventName  Raw OCR event/tournament name from the screenshot. When provided alongside
 *   todayFixtures, used to break ties when multiple distinct players share the matched name —
 *   only the candidate scheduled in that tournament's fixtures is accepted.
 * @param todayFixtures  Today's live fixture list for fixture-context tie-breaking.
 */
async function resolvePlayerMatch(
  provider: TennisDataProvider,
  recognizedName: string | null,
  eventName?: string | null,
  todayFixtures?: Fixture[],
): Promise<PlayerResolveOutcome> {
  if (!recognizedName) {
    return {
      match: { recognizedName: null, player: null },
      status: "unreadable",
    };
  }

  // Strip OCR draw-sheet metadata (seeds, status tokens, birth years, etc.) before
  // matching. The original recognizedName is preserved for display and debugging.
  const searchName = stripOcrMetadata(recognizedName);
  const norm = normalizeName(searchName);

  const candidates = await gatherCandidates(provider, searchName);
  const confident = candidates.filter((c) => isConfidentMatch(norm, normalizeName(c.name)));

  // A single confident candidate is unambiguous by definition — resolve it even when the OCR
  // name is in an abbreviated "X. Surname" or "X. Y. Surname" form.  The weak-key guard below
  // is only meaningful when multiple candidates match (genuine ambiguity), so checking for a
  // unique hit first prevents ITF/lower-tier players whose canonical DB names are abbreviated
  // (e.g. "S. Kopp", "E. Meri", "T. Pereira") from being permanently stuck as "not-found"
  // when the live provider is unavailable and the historical DB is the only source.
  if (confident.length === 1) {
    return { match: { recognizedName, player: confident[0] }, status: "resolved" };
  }

  if (isWeakOcrIdentityKey(norm)) {
    return {
      match: { recognizedName, player: null },
      status: confident.length > 0 ? "ambiguous" : "not-found",
    };
  }

  if (confident.length > 1) {
    // When every confident match shares the same normalized name they are the same player
    // recorded under different MatchStat season IDs (e.g. "J. Monday" id=10071 and id=28099).
    // Collapse to the single best candidate rather than surfacing a spurious "ambiguous" error.
    // Only truly different names (different country codes / different players) remain ambiguous.
    const firstNorm = normalizeName(confident[0]!.name);
    const allSameName = confident.every((c) => normalizeName(c.name) === firstNorm);
    if (allSameName) {
      const best = confident.slice().sort((a, b) => {
        // Prefer live standings over historical-match records
        const aLive = a.source !== "historical-match" ? 0 : 1;
        const bLive = b.source !== "historical-match" ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        // Prefer ranked players
        const aR = a.currentRank != null ? 0 : 1;
        const bR = b.currentRank != null ? 0 : 1;
        if (aR !== bR) return aR - bR;
        // Prefer lower rank number (higher-ranked player)
        if (a.currentRank != null && b.currentRank != null) return a.currentRank - b.currentRank;
        return 0;
      })[0]!;
      return { match: { recognizedName, player: best }, status: "resolved" };
    }

    // Initial-equivalent collapse: "G. Kravchenko" (abbreviated, historical DB) and
    // "Georgii Kravchenko" (full name, backfill row) are the same player.
    // See isInitialEquivalentGroup for the precise predicate and its safety guards.
    const normWordArrays = confident.map((c) => normalizeName(c.name).split(" ").filter(Boolean));
    if (isInitialEquivalentGroup(normWordArrays)) {
      const best = confident.slice().sort((a, b) => {
        // Prefer full names over abbreviated (longer normalized name = more detail)
        const aLen = normalizeName(a.name).length;
        const bLen = normalizeName(b.name).length;
        if (aLen !== bLen) return bLen - aLen;
        // Prefer live standings over historical-match records
        const aLive = a.source !== "historical-match" ? 0 : 1;
        const bLive = b.source !== "historical-match" ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        // Prefer ranked players
        const aR = a.currentRank != null ? 0 : 1;
        const bR = b.currentRank != null ? 0 : 1;
        if (aR !== bR) return aR - bR;
        if (a.currentRank != null && b.currentRank != null) return a.currentRank - b.currentRank;
        return 0;
      })[0]!;
      return { match: { recognizedName, player: best }, status: "resolved" };
    }

    // Fixture-context tie-break: when multiple genuinely distinct players share the
    // matched name (e.g. two different "Jordan Lee"s), check whether exactly one of
    // them is scheduled in today's fixtures for the screenshot's tournament. This
    // resolves common-name ambiguity without guessing when the context is unambiguous.
    if (eventName && todayFixtures && todayFixtures.length > 0) {
      const eventNorm = normalizeName(eventName);
      if (eventNorm.length > 0) {
        const tournamentFixtures = todayFixtures.filter((f) => {
          const tNorm = normalizeName(f.tournamentName ?? "");
          return tNorm.length > 0 && (tNorm.includes(eventNorm) || eventNorm.includes(tNorm));
        });
        if (tournamentFixtures.length > 0) {
          const inFixture = confident.filter((c) =>
            tournamentFixtures.some(
              (f) =>
                resolvedPlayerFitsFixtureSlot(c, f.player1Id, f.player1Name) ||
                resolvedPlayerFitsFixtureSlot(c, f.player2Id, f.player2Name),
            ),
          );
          if (inFixture.length === 1) {
            return { match: { recognizedName, player: inFixture[0]! }, status: "resolved" };
          }
        }
      }
    }

    // Tour-based tie-break: "ATP Washington" → only ATP candidates; "WTA Memphis" → WTA only.
    // The tour prefix in the event name is an unambiguous signal that narrows common-name
    // ambiguity (e.g. "Jordan Lee" ATP vs. WTA, "A. Sharma" ATP vs. WTA) without guessing.
    if (eventName) {
      const eventUpper = eventName.toUpperCase();
      const inferredTour: "ATP" | "WTA" | null =
        /\batp\b/.test(eventUpper) ? "ATP" :
        /\bwta\b/.test(eventUpper) ? "WTA" :
        null;
      if (inferredTour) {
        const tourFiltered = confident.filter((c) => c.tour === inferredTour);
        if (tourFiltered.length === 1) {
          return { match: { recognizedName, player: tourFiltered[0]! }, status: "resolved" };
        }
      }
    }

    // Auto-pick the best candidate rather than surfacing an ambiguous error.
    // Prefer: live-standings > historical-match; ranked > unranked; lower rank number (higher-ranked).
    const autoPick = confident.slice().sort((a, b) => {
      const aLive = a.source !== "historical-match" ? 0 : 1;
      const bLive = b.source !== "historical-match" ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      const aR = a.currentRank != null ? 0 : 1;
      const bR = b.currentRank != null ? 0 : 1;
      if (aR !== bR) return aR - bR;
      if (a.currentRank != null && b.currentRank != null) return a.currentRank - b.currentRank;
      return 0;
    })[0]!;
    return { match: { recognizedName, player: autoPick }, status: "best-guess", candidates: confident };
  } else {
    // OCR misread recovery: try edit-distance ≤1 on the surname before giving up entirely.
    const fuzzyMatch = await ocrFuzzyFallback(provider, searchName);
    if (fuzzyMatch) {
      return { match: { recognizedName, player: fuzzyMatch }, status: "best-guess" };
    }
    return { match: { recognizedName, player: null }, status: "not-found" };
  }
}

// ── Event resolution ───────────────────────────────────────────────────────

async function resolveEventMatch(
  provider: TennisDataProvider,
  eventName: string | null,
  warnings: string[],
): Promise<ScreenshotEventMatch> {
  let { surface, level } = inferSurfaceAndLevel(eventName);

  // The named table never resolves Challenger/ITF events by name (see surfaceMap.ts)
  // because live fixtures get a tournament_key → surface lookup instead.
  // A screenshot import has no tournament_key, so fall back to a real name search.
  if (eventName && surface === null && provider.findTournamentSurfaceByName) {
    let found: Awaited<ReturnType<NonNullable<typeof provider.findTournamentSurfaceByName>>> | null = null;
    try {
      found = await provider.findTournamentSurfaceByName(eventName);
    } catch {
      // Provider unavailable (e.g. circuit breaker open) — surface stays null, not an error.
    }
    if (found) {
      surface = found.surface;
      // Suppress a provider-returned level that contradicts the event's known tour.
      // The provider's tournament DB sometimes returns a stale ATP-era label (e.g. "ATP250")
      // for a city that now hosts a WTA event (Memphis, Vancouver). The event name prefix is
      // a stronger signal than the provider's coarse category label.
      let providerLevel = found.level ?? level;
      if (providerLevel && eventName) {
        const eUpper = eventName.toUpperCase();
        const isWtaEvent = /\bwta\b/.test(eUpper);
        const isAtpEvent = /\batp\b/.test(eUpper);
        const isAtpLevel = providerLevel === "ATP250" || providerLevel === "ATP500" || providerLevel === "Masters1000";
        const isWtaLevel = providerLevel === "WTA250" || providerLevel === "WTA500" || providerLevel === "WTA1000";
        if ((isWtaEvent && isAtpLevel) || (isAtpEvent && isWtaLevel)) {
          providerLevel = null; // tour mismatch — drop the stale label
        }
      }
      level = providerLevel;
    }
  }

  if (eventName && surface === null) {
    warnings.push(`Read event "${eventName}", but couldn't determine its surface -- please set surface/level manually.`);
  } else if (!eventName) {
    warnings.push(`No event/tournament name could be read from the screenshot -- surface was not auto-detected.`);
  }

  return { recognizedName: eventName, surface, level };
}

// ── Top-level resolution ───────────────────────────────────────────────────

/** Resolves one raw matchup entry to real players and event info. */
async function resolveOneMatchup(
  provider: TennisDataProvider,
  entry: RawMatchupEntry,
  todayFixtures: Fixture[],
): Promise<ScreenshotMatchupEntry> {
  const warnings: string[] = [];

  const [player1Outcome, player2Outcome, event] = await Promise.all([
    resolvePlayerMatch(provider, entry.player1Name, entry.eventName, todayFixtures),
    resolvePlayerMatch(provider, entry.player2Name, entry.eventName, todayFixtures),
    resolveEventMatch(provider, entry.eventName, warnings),
  ]);

  let player1 = player1Outcome.match;
  let player2 = player2Outcome.match;
  let hasAmbiguousSide = player1Outcome.status === "ambiguous" || player2Outcome.status === "ambiguous";

  // ── Opponent-context disambiguation ──────────────────────────────────────────
  // When one player is "ambiguous" (multiple confident candidates) but the other
  // player IS resolved, use live fixtures to pick the one candidate that actually
  // appears in a scheduled match alongside the resolved opponent. This is the only
  // reliable way to resolve compound names (Hong Yi Cody Wong, Aran Teixido Garcia)
  // and tour collisions (Astra Sharma ATP vs WTA) without guessing.
  //
  // We use resolvedPlayerFitsFixtureSlot (name+ID) rather than ID equality so that
  // MatchStat local IDs and API-Tennis fixture IDs are interchangeable.
  if (hasAmbiguousSide) {
    const p1Ambiguous = player1Outcome.status === "ambiguous" && !player1.player;
    const p2Ambiguous = player2Outcome.status === "ambiguous" && !player2.player;

    /**
     * Looks for the unique candidate from `ambiguousCandidates` that shares a live
     * fixture with `resolvedPlayer`.  Returns null if 0 or ≥2 distinct candidates match.
     */
    const tryFixtureDisambiguate = (
      resolvedPlayer: PlayerSummary,
      ambiguousCandidates: PlayerSummary[],
    ): PlayerSummary | null => {
      const byId = new Map<string, PlayerSummary>();

      for (const fixture of todayFixtures) {
        const fitsSlot1 = resolvedPlayerFitsFixtureSlot(resolvedPlayer, fixture.player1Id, fixture.player1Name);
        const fitsSlot2 = resolvedPlayerFitsFixtureSlot(resolvedPlayer, fixture.player2Id, fixture.player2Name);
        if (!fitsSlot1 && !fitsSlot2) continue;

        const opponentSlotId   = fitsSlot1 ? fixture.player2Id   : fixture.player1Id;
        const opponentSlotName = fitsSlot1 ? fixture.player2Name : fixture.player1Name;

        for (const c of ambiguousCandidates) {
          if (resolvedPlayerFitsFixtureSlot(c, opponentSlotId, opponentSlotName)) {
            byId.set(c.id, c);
          }
        }
      }

      return byId.size === 1 ? [...byId.values()][0]! : null;
    };

    if (p2Ambiguous && player1.player && player2Outcome.candidates?.length) {
      const resolved = tryFixtureDisambiguate(player1.player, player2Outcome.candidates);
      if (resolved) {
        player2 = { recognizedName: player2.recognizedName, player: resolved };
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 2"));
        warnings.push(`[resolver-debug] P2 opponent-fixture disambiguated → ${resolved.name}.`);
      }
    }

    if (p1Ambiguous && player2.player && player1Outcome.candidates?.length) {
      const resolved = tryFixtureDisambiguate(player2.player, player1Outcome.candidates);
      if (resolved) {
        player1 = { recognizedName: player1.recognizedName, player: resolved };
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 1"));
        warnings.push(`[resolver-debug] P1 opponent-fixture disambiguated → ${resolved.name}.`);
      }
    }

    // Recalculate: if disambiguation resolved the ambiguous side, lift the gate so the
    // downstream fixture inference can handle any remaining "not-found" side normally.
    hasAmbiguousSide =
      (player1Outcome.status === "ambiguous" && !player1.player) ||
      (player2Outcome.status === "ambiguous" && !player2.player);
  }

  if ((!player1.player || !player2.player) && !hasAmbiguousSide) {
    const singleSideInference = inferUniqueOpponentFromSingleResolvedSide({
      entry,
      event,
      resolvedPlayer1: player1.player,
      resolvedPlayer2: player2.player,
      fixtures: todayFixtures,
    });

    if (singleSideInference) {
      const syntheticCandidate: FixtureCandidate = {
        fixture: singleSideInference.fixture,
        score: 1,
        nameScore: 1,
        orientation: singleSideInference.orientation,
      };
      const resolved = resolveFromFixtureCandidate(syntheticCandidate, player1, player2);
      const previousPlayer1 = player1;
      const previousPlayer2 = player2;
      player1 = resolved.player1;
      player2 = resolved.player2;

      if (!previousPlayer1.player && player1.player) {
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 1"));
      }
      if (!previousPlayer2.player && player2.player) {
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 2"));
      }

      warnings.push(
        `[resolver-debug] Resolved via ${singleSideInference.rule}: ${singleSideInference.fixture.player1Name} vs ${singleSideInference.fixture.player2Name} (single-opponent unique match).`,
      );
    }
  }

  if ((!player1.player || !player2.player) && !hasAmbiguousSide) {
    const candidates = todayFixtures
      .map((fixture) => scoreFixtureCandidate({
        fixture,
        entry,
        event,
        resolvedPlayer1: player1.player,
        resolvedPlayer2: player2.player,
      }))
      .filter((c): c is FixtureCandidate => c !== null);

    const winner = pickUniqueFixtureCandidate(candidates);
    if (winner) {
      const resolved = resolveFromFixtureCandidate(winner, player1, player2);
      const previousPlayer1 = player1;
      const previousPlayer2 = player2;
      player1 = resolved.player1;
      player2 = resolved.player2;

      if (!previousPlayer1.player && player1.player) {
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 1"));
      }
      if (!previousPlayer2.player && player2.player) {
        warnings.splice(0, warnings.length, ...prunePlayerWarningsForLabel(warnings, "Player 2"));
      }

      const rule = previousPlayer1.player && !previousPlayer2.player
        ? "fixture-opponent-inference-from-player1"
        : (!previousPlayer1.player && previousPlayer2.player
            ? "fixture-opponent-inference-from-player2"
            : "fixture-pair-fuzzy-unique");
      warnings.push(
        `[resolver-debug] Resolved via ${rule}: ${winner.fixture.player1Name} vs ${winner.fixture.player2Name} (score ${winner.score.toFixed(2)}).`,
      );
    }
  }

  // Best-guess disclaimer: player IS set but may be wrong — OCR may have misread a character.
  // The warning is emitted before the prediction proceeds so the user can correct it.
  if (player1Outcome.status === "best-guess" && player1.player) {
    warnings.push(
      `Read "${entry.player1Name}" for Player 1 — OCR may have misread a character. Best guess: ${player1.player.name}. Please confirm via Search Players.`,
    );
  }
  if (player2Outcome.status === "best-guess" && player2.player) {
    warnings.push(
      `Read "${entry.player2Name}" for Player 2 — OCR may have misread a character. Best guess: ${player2.player.name}. Please confirm via Search Players.`,
    );
  }

  if (!player1.player) {
    if (player1Outcome.status === "unreadable") {
      warnings.push("Player 1 could not be read from the screenshot -- use Search Players to add them manually.");
    } else if (player1Outcome.status === "ambiguous") {
      warnings.push(
        `Read "${entry.player1Name}" for Player 1, but multiple matching players were found -- please select the right one from Search Players.`,
      );
    } else if (player1Outcome.status === "not-found") {
      warnings.push(
        `Read "${entry.player1Name}" for Player 1, but they were not found in any known player source. They may be a very low-ranked player not yet in the database.`,
      );
    } else {
      warnings.push(
        `Read "${entry.player1Name}" for Player 1, but couldn't confidently match them to a known player -- please use Search Players.`,
      );
    }
  }

  if (!player2.player) {
    if (player2Outcome.status === "unreadable") {
      warnings.push("Player 2 could not be read from the screenshot -- use Search Players to add them manually.");
    } else if (player2Outcome.status === "ambiguous") {
      warnings.push(
        `Read "${entry.player2Name}" for Player 2, but multiple matching players were found -- please select the right one from Search Players.`,
      );
    } else if (player2Outcome.status === "not-found") {
      warnings.push(
        `Read "${entry.player2Name}" for Player 2, but they were not found in any known player source. They may be a very low-ranked player not yet in the database.`,
      );
    } else {
      warnings.push(
        `Read "${entry.player2Name}" for Player 2, but couldn't confidently match them to a known player -- please use Search Players.`,
      );
    }
  }

  // Guard against the same real player resolving for both slots.
  if (player1.player && player2.player && player1.player.id === player2.player.id) {
    warnings.push(`Player 2 resolved to the same player as Player 1 -- please pick Player 2 manually from Search Players.`);
    player2 = { recognizedName: player2.recognizedName, player: null };
  }

  // Attach resolution status + candidates to each player object so the API response
  // can expose them for UI disambiguation (e.g. parlay builder candidate picker).
  if (player1Outcome.status === "ambiguous" && !player1.player) {
    player1 = { ...player1, status: "ambiguous", candidates: player1Outcome.candidates };
  } else if (!player1.player) {
    player1 = { ...player1, status: player1Outcome.status };
  }
  if (player2Outcome.status === "ambiguous" && !player2.player) {
    player2 = { ...player2, status: "ambiguous", candidates: player2Outcome.candidates };
  } else if (!player2.player) {
    player2 = { ...player2, status: player2Outcome.status };
  }

  const resolved = !!player1.player && !!player2.player;
  return { player1, player2, event, resolved, warnings };
}

export async function resolveScreenshotMatchup(
  provider: TennisDataProvider,
  raw: RawScreenshotRecognition,
): Promise<ScreenshotMatchupResult> {
  if (raw.matchups.length === 0) {
    const noData: ScreenshotPlayerMatch = { recognizedName: null, player: null };
    const noEvent: ScreenshotEventMatch = { recognizedName: null, surface: null, level: null };
    return {
      player1: noData,
      player2: noData,
      event: noEvent,
      warnings: ["No matchups could be read from this screenshot -- use Search Players to add them manually."],
      matchups: [],
    };
  }

  const todayFixtures = await getTodayFixtures(provider);

  // Resolve each matchup concurrently
  const resolvedEntries = await Promise.all(
    raw.matchups.map((entry) => resolveOneMatchup(provider, entry, todayFixtures)),
  );

  // Primary slot: first resolved entry (backward compatibility)
  const primary = resolvedEntries[0];

  const topWarnings = [...primary.warnings];
  const unresolvedCount = resolvedEntries.slice(1).filter((e) => !e.resolved).length;
  if (unresolvedCount > 0) {
    topWarnings.push(
      `${unresolvedCount} additional matchup${unresolvedCount === 1 ? "" : "s"} from this screenshot could not be fully resolved -- check the items below.`,
    );
  }

  return {
    player1: primary.player1,
    player2: primary.player2,
    event: primary.event,
    warnings: topWarnings,
    matchups: resolvedEntries,
  };
}
