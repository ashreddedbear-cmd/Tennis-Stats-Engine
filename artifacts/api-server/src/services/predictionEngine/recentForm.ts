import type { MatchRecord, Surface, TournamentLevel } from "../tennisData/types";
import { computeMatchPerformances, opponentAdjustedCoverage } from "./matchPerformance";
import type { OpponentEloLookup } from "./opponentStrength";

export interface RecentFormResult {
  player1Form: number;
  player2Form: number;
  player1Trend: "improving" | "stable" | "declining";
  player2Trend: "improving" | "stable" | "declining";
  reliability: number;
  /** Share (0-100) of each player's recent matches for which a real opponent-strength estimate was available. */
  player1OpponentAdjustedCoverage: number;
  player2OpponentAdjustedCoverage: number;
  /** Share (0-100) of each player's recent matches for which a real serve/return point-stat line was available and factored into the score. 0 means form is based on outcomes (opponent-adjusted where possible) alone -- never fabricated. */
  player1ServeReturnCoverage: number;
  player2ServeReturnCoverage: number;
  /** 0-1 share of each player's recent-form window that came from genuine tour-level competition
   * (ATP/WTA main tour or above), not Challenger/ITF/Other. Low share means the form score is
   * shrunk toward neutral (50) -- see `TOUR_CREDIBILITY_FLOOR`. */
  player1TourLevelShare: number;
  player2TourLevelShare: number;
  /** True when a player's recent-form window had no matches and its neutral value was used. */
  defaulted: boolean;
  warnings: string[];
}

const WINDOW = 10;
const MIN_SAMPLE_FOR_NO_WARNING = 4;

// Mirrors surfaceElo.ts's competition-level weighting exactly (kept as a separate local copy --
// recentForm's window pools all levels together rather than filtering by surface the way
// surfaceElo does, so it isn't worth coupling the two modules over one shared table). A hot
// streak built on Challenger/ITF results shouldn't read the same as one built on tour-level wins.
const LEVEL_WEIGHT: Partial<Record<TournamentLevel, number>> = {
  GrandSlam: 1.3,
  Masters1000: 1.25,
  WTA1000: 1.25,
  ATP500: 1.1,
  WTA500: 1.1,
  ATP250: 1.0,
  WTA250: 1.0,
  Challenger: 0.75,
  ITF: 0.6,
  Other: 0.85,
};
const DEFAULT_LEVEL_WEIGHT = 0.85;

// Same tour-level set surfaceElo.ts uses for its own tour-level-credibility shrink -- kept as a
// separate local copy for the same reason LEVEL_WEIGHT above is (recentForm pools levels rather
// than filtering by surface). A hot streak built entirely against Challenger/ITF fields shouldn't
// earn the same trust as one built against tour-level opponents, mirroring the same shrink-toward-
// neutral pattern already used for the trend label and surfaceElo's rating.
const TOUR_LEVELS = new Set<TournamentLevel>(["GrandSlam", "Masters1000", "WTA1000", "ATP500", "WTA500", "ATP250", "WTA250"]);
function isTourLevel(level: TournamentLevel | null): boolean {
  return level !== null && TOUR_LEVELS.has(level);
}
/** Floor on how much a form score's deviation from neutral (50) is trusted when NONE of a
 * player's recent-form window came from tour-level competition -- mirrors surfaceElo.ts's
 * `TOUR_CREDIBILITY_FLOOR`. */
const TOUR_CREDIBILITY_FLOOR = 0.35;

// A match played on a DIFFERENT surface than the upcoming fixture still carries real signal about
// the player (it's the same person, same underlying game) -- just less of it for THIS matchup's
// surface-specific form read, so it's de-weighted rather than dropped.
const SURFACE_MISMATCH_WEIGHT = 0.7;

// Retirements/walkovers didn't reach a clean competitive conclusion, so they're de-weighted
// rather than either counted as an ordinary result or excluded outright: a walkover win still
// means the player showed up healthy and ready, and a mid-match retirement loss doesn't cleanly
// reflect the retiring player's actual level of play that day.
const RETIRED_OR_WALKOVER_WEIGHT = 0.35;

// Same real-stats tour averages and rating scale serveReturn.ts uses for its own point-stat
// rating, reused here so a match's serve/return quality reads on a familiar 0-100 scale.
const TOUR_AVG_SERVICE_POINTS_WON_PCT = 62;
const TOUR_AVG_RETURN_POINTS_WON_PCT = 38;
const REAL_STATS_RATING_SCALE = 2.5;
// How much a single match's contribution to the form score comes from serve/return quality vs.
// the outcome (opponent-adjusted win/loss) -- a refinement layered on top of the outcome signal,
// not a replacement for it, so a very lopsided stat line still can't outvote who actually won.
const SERVE_RETURN_BLEND_WEIGHT = 0.25;

// Empirically validated 2026-07-13 via scripts/analyzeRecentFormTrendValidity.ts against
// eloOverall-adjusted subsequent outcomes across the full historical corpus (7.5k+ players): the
// PREVIOUS thresholds (plain win-rate delta > 0.15, no sample floor) showed essentially no
// separation in real future win rate between "improving" and "declining" labels (~0.1-0.2pt
// spread -- noise). Switching the delta to the SAME opponent-adjusted performance signal the form
// score itself uses, raising the threshold to 0.25, and requiring at least 6 past matches widened
// that spread to ~2.6pts (declining: 59.0% future win rate vs. improving: 61.6%, stable in
// between at 62.9%) -- a real, if modest, signal. See the script's inline comments for the full
// comparison table across candidate thresholds/signals.
// 2026-07-14 re-check (task #71): the validation above predates this file's serve/return blend
// (`SERVE_RETURN_BLEND_WEIGHT`), so re-ran the same script with a third signal that layers the
// real serve/return-quality blend on top of the opponent-adjusted delta AND replicates this
// file's full per-match weight stack (recency decay, level weight, surface-mismatch deweight,
// retired/walkover deweight) -- i.e. the exact contribution/weight `formScore` computes today,
// not just its pre-blend predecessor. Result: the richer signal WIDENED the separation further at
// these same thresholds (0.25 delta / min 6 sample: ~1.5pt -> ~2.2pt improving-vs-declining
// spread), so 0.25/6 remains the best config -- no retune needed. See the script's updated inline
// comments and `.agents/memory/recent-form-trend-validation.md` for the numbers.
const TREND_DELTA_THRESHOLD = 0.25;
const TREND_MIN_SAMPLE = 6;

/**
 * Real, provider-reported serve/return quality (0-100, 50 = tour-average) for a single match,
 * from `MatchStatLine.servicePointsWonPct`/`returnPointsWon` -- independent of win/loss, so a
 * player winning ugly and a player winning comfortably aren't scored identically. Null when the
 * provider never reported these fields for this match (never fabricated).
 */
function serveReturnQualityRating(match: MatchRecord): number | null {
  const servicePct = match.stats?.servicePointsWonPct ?? null;
  const returnPct = match.stats?.returnPointsWon ?? null;
  if (servicePct === null && returnPct === null) return null;

  const parts: number[] = [];
  if (servicePct !== null) parts.push(50 + (servicePct - TOUR_AVG_SERVICE_POINTS_WON_PCT) * REAL_STATS_RATING_SCALE);
  if (returnPct !== null) parts.push(50 + (returnPct - TOUR_AVG_RETURN_POINTS_WON_PCT) * REAL_STATS_RATING_SCALE);
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.max(5, Math.min(95, avg));
}

function levelWeight(level: TournamentLevel | null): number {
  if (!level) return DEFAULT_LEVEL_WEIGHT;
  return LEVEL_WEIGHT[level] ?? DEFAULT_LEVEL_WEIGHT;
}

function formScore(
  matches: MatchRecord[],
  surface: Surface,
  opponentElo: OpponentEloLookup,
): { form: number; trend: "improving" | "stable" | "declining"; sample: number; coverage: number; serveReturnCoverage: number; tourLevelShare: number } {
  const recent = matches.slice(0, WINDOW); // matches are already sorted most-recent-first
  if (recent.length === 0) return { form: 50, trend: "stable", sample: 0, coverage: 0, serveReturnCoverage: 0, tourLevelShare: 0 };

  const performances = computeMatchPerformances(recent, opponentElo);
  const coverage = opponentAdjustedCoverage(performances);

  const weights: number[] = [];
  const contributions: number[] = [];
  let serveReturnResolved = 0;

  performances.forEach((p, i) => {
    const m = p.match;
    let weight = Math.pow(0.85, i); // exponential recency decay
    weight *= levelWeight(m.tournamentLevel);
    if (m.surface !== null && m.surface !== surface) weight *= SURFACE_MISMATCH_WEIGHT;
    if (m.retired || m.walkover) weight *= RETIRED_OR_WALKOVER_WEIGHT;

    // Opponent-adjusted: reward beating strong opponents, penalize losing to weak ones. When the
    // opponent's real strength isn't known, fall back to a plain win/loss contribution (0 or 1)
    // instead of guessing a strength -- honest degradation to the pre-Phase-5 behavior.
    const outcomeContribution = p.performanceDelta !== null ? 0.5 + p.performanceDelta / 2 : p.actualScore;
    const srRating = serveReturnQualityRating(m);
    const contribution = srRating !== null ? outcomeContribution * (1 - SERVE_RETURN_BLEND_WEIGHT) + (srRating / 100) * SERVE_RETURN_BLEND_WEIGHT : outcomeContribution;
    if (srRating !== null) serveReturnResolved += 1;

    weights.push(weight);
    contributions.push(contribution);
  });

  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const weighted = weights.reduce((sum, w, i) => sum + w * contributions[i], 0);
  const rawForm = (weighted / weightTotal) * 100;

  // Tour-level credibility: what share of the (recency-weighted, but NOT level-weighted) window
  // came from genuine tour-level matches, judged only against matches with a KNOWN level -- an
  // unreported level is absent information, not evidence of weak competition, so it's excluded
  // from both the numerator and denominator (defaults to fully trusted when no level is known at
  // all). A form score built almost entirely from beating Challenger/ITF fields shouldn't deviate
  // from neutral (50) with full confidence -- shrink its distance from 50 in proportion to how
  // little tour-level evidence backs it, same mechanism surfaceElo.ts uses for its rating.
  const recencyWeights = recent.map((_, i) => Math.pow(0.85, i));
  const knownLevelRecencyTotal = recencyWeights.reduce((sum, w, i) => sum + (recent[i].tournamentLevel !== null ? w : 0), 0);
  const tourRecencyTotal = recencyWeights.reduce((sum, w, i) => sum + (isTourLevel(recent[i].tournamentLevel) ? w : 0), 0);
  const tourLevelShare = knownLevelRecencyTotal > 0 ? tourRecencyTotal / knownLevelRecencyTotal : 1;
  const tourLevelCredibility = TOUR_CREDIBILITY_FLOOR + (1 - TOUR_CREDIBILITY_FLOOR) * tourLevelShare;
  const form = Math.round(50 + (rawForm - 50) * tourLevelCredibility);

  // Trend: compare the same weighted, opponent-/serve-return-adjusted contribution across the
  // newer vs. older half of the window -- see TREND_DELTA_THRESHOLD's comment for why this
  // replaced the old plain-win-rate-delta approach, and for a minimum-sample guard against a
  // short 2-3 match streak flipping the label on its own.
  const half = Math.ceil(recent.length / 2);
  const halfWeightedAvg = (start: number, end: number): number => {
    let sum = 0;
    let total = 0;
    for (let i = start; i < end; i++) {
      sum += contributions[i] * weights[i];
      total += weights[i];
    }
    return total > 0 ? sum / total : 0.5;
  };
  const delta = halfWeightedAvg(0, half) - halfWeightedAvg(half, recent.length);

  const trend: "improving" | "stable" | "declining" =
    recent.length >= TREND_MIN_SAMPLE && delta > TREND_DELTA_THRESHOLD ? "improving" : recent.length >= TREND_MIN_SAMPLE && delta < -TREND_DELTA_THRESHOLD ? "declining" : "stable";

  return {
    form,
    trend,
    sample: recent.length,
    coverage,
    serveReturnCoverage: recent.length > 0 ? serveReturnResolved / recent.length : 0,
    tourLevelShare,
  };
}

export function computeRecentFormModule(
  player1Matches: MatchRecord[],
  player2Matches: MatchRecord[],
  surface: Surface,
  player1OpponentElo: OpponentEloLookup = new Map(),
  player2OpponentElo: OpponentEloLookup = new Map(),
): RecentFormResult {
  const p1 = formScore(player1Matches, surface, player1OpponentElo);
  const p2 = formScore(player2Matches, surface, player2OpponentElo);
  const minSample = Math.min(p1.sample, p2.sample);
  const reliability = Math.max(10, Math.min(100, minSample * 12));

  const warnings: string[] = [];
  if (minSample < MIN_SAMPLE_FOR_NO_WARNING) {
    warnings.push(`Recent-form sample is thin (as few as ${minSample} match(es) for one player) -- this signal is low-confidence.`);
  }
  if (p1.coverage < 0.5 || p2.coverage < 0.5) {
    warnings.push(
      "Opponent-strength data is only available for a minority of recent matches for one or both players -- form is partly opponent-adjusted and partly raw win/loss.",
    );
  }
  if (minSample < TREND_MIN_SAMPLE) {
    warnings.push(`Trend label needs at least ${TREND_MIN_SAMPLE} recent matches to move off "stable" -- one or both players have fewer.`);
  }
  const minTourShare = Math.min(p1.tourLevelShare, p2.tourLevelShare);
  if (minTourShare < 0.25) {
    const lowPlayer = p1.tourLevelShare <= p2.tourLevelShare ? "Player 1" : "Player 2";
    const pct = Math.round(minTourShare * 100);
    warnings.push(`${lowPlayer}'s recent form is backed mostly by sub-tour (Challenger/ITF) matches (only ${pct}% tour-level) -- their form score is shrunk toward neutral to avoid overcrediting a streak against weaker fields.`);
  }

  return {
    player1Form: p1.form,
    player2Form: p2.form,
    player1Trend: p1.trend,
    player2Trend: p2.trend,
    reliability: Math.round(reliability),
    player1OpponentAdjustedCoverage: Math.round(p1.coverage * 100),
    player2OpponentAdjustedCoverage: Math.round(p2.coverage * 100),
    player1ServeReturnCoverage: Math.round(p1.serveReturnCoverage * 100),
    player2ServeReturnCoverage: Math.round(p2.serveReturnCoverage * 100),
    player1TourLevelShare: Math.round(p1.tourLevelShare * 1000) / 1000,
    player2TourLevelShare: Math.round(p2.tourLevelShare * 1000) / 1000,
    defaulted: p1.sample === 0 || p2.sample === 0,
    warnings,
  };
}
