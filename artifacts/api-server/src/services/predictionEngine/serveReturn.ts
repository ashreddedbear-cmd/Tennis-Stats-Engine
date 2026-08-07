import type { MatchRecord, Surface } from "../tennisData/types";
import type { OpponentEloLookup } from "./opponentStrength";
import { realSetGameMargins } from "./setMargins";

/**
 * Point-level serve/return breakdown, computed directly from real provider match-level stats
 * (never fabricated/interpolated). Each field is null independently when its underlying provider
 * field never resolved for enough of this player's matches -- there is no shared "all or nothing"
 * gate across the four fields, since a provider can report break-point counts without reporting
 * first-serve splits, or vice versa.
 */
export interface PointLevelStats {
  /** Real, provider-reported average % of points won on first serve (`MatchStatLine.firstServeWon`). */
  firstServeWinPct: number | null;
  /** Real break points saved / break points faced on this player's own serve, aggregated as a single ratio (not a per-match average) so a handful of high-pressure games don't get diluted by matches with none. */
  breakPointsSavedPct: number | null;
  /** Real break points converted while returning, derived from the opponent's own service-game stats (`opponentStats.breakPointsFaced/breakPointsSaved`) recorded on the SAME match -- this is the only place that data exists, since a player's own stat line never reports their return-side break conversions directly. */
  breakPointsConvertedPct: number | null;
  /** Estimated probability (0-100) of holding a service game, derived from real `servicePointsWonPct` via the standard (Newton & Keller 1974) closed-form game-win formula -- an established statistical model applied to a real input, not a fabricated number. Null when `servicePointsWonPct` never resolved. */
  serviceGamesHeldPct: number | null;
  /** Count of matches that contributed to at least one of the fields above. */
  sampleSize: number;
}

export interface ServeReturnResult {
  player1ServeRating: number;
  player2ServeRating: number;
  player1ReturnRating: number;
  player2ReturnRating: number;
  /** Point-level inputs behind the ratings above (first-serve win %, break points saved/converted, service games held) -- see `PointLevelStats`. Always computed and exposed, independent of whether the overall module fell back to the margin proxy. */
  player1PointLevel: PointLevelStats;
  player2PointLevel: PointLevelStats;
  reliability: number;
  /** True when one side had no usable score margins or provider stats for this module. */
  defaulted: boolean;
  note: string | null;
  warnings: string[];
}

const PROXY_NOTE =
  "Provider does not expose point-level serve/return statistics for enough recent matches; ratings are derived from real set/game score margins across recent matches, weighted by real opponent strength where available, never fabricated.";

const REAL_STATS_NOTE =
  "Ratings are derived from the provider's real match-level point statistics (service/return points won), weighted by real opponent strength where available. Never fabricated or interpolated for matches without provider stats.";

const BASELINE_ELO = 1500;
const MIN_SAMPLE_FOR_NO_WARNING = 5;

// Rough tour-wide averages used only to center real service/return points-won percentages onto
// the same 0-100 "50 = average" rating scale the rest of the engine expects. These are stable,
// widely-cited approximations (not fetched from the provider), and only affect how a real,
// provider-reported percentage is displayed -- never used in place of missing provider data.
const TOUR_AVG_SERVICE_POINTS_WON_PCT = 62;
const TOUR_AVG_RETURN_POINTS_WON_PCT = 38;
const REAL_STATS_RATING_SCALE = 2.5;
const MIN_REAL_SAMPLE = 3;

// Rough tour-wide averages for the point-level breakdown, used the same way as the tour averages
// above: only to center a real, provider-reported (or provider-input-derived) percentage onto a
// "50 = average" rating scale -- never used in place of missing data.
const TOUR_AVG_SERVICE_GAMES_HELD_PCT = 80;
const TOUR_AVG_BREAK_POINTS_CONVERTED_PCT = 40;
const POINT_LEVEL_RATING_SCALE = 1.8;
// How much weight the deeper point-level breakdown gets blended into the headline serve/return
// rating once it resolves for both players -- kept modest so this is a refinement of the
// existing real-stats rating, not a replacement of it.
const POINT_LEVEL_BLEND_WEIGHT = 0.2;
const MIN_POINT_LEVEL_SAMPLE = 3;

// A match on a different surface than the one being predicted is still real signal about a
// player's serve/return game, just less directly transferable -- same de-weighting `recentForm.ts`
// already applies, not a full exclusion. `serveReturn.ts` previously had zero surface awareness
// (every match at any weight regardless of surface), even though hard-court dominance in
// particular can look very different indoors vs outdoors.
const SURFACE_MISMATCH_WEIGHT = 0.7;

/** Real per-match weight multiplier for a surface mismatch -- 1 when the surface is unknown or matches. */
function surfaceWeight(match: MatchRecord, surface: Surface): number {
  return match.surface !== null && match.surface !== surface ? SURFACE_MISMATCH_WEIGHT : 1;
}

/**
 * Closed-form probability of winning a standard (advantage) tennis game given a real, per-point
 * probability `p` of winning each point on serve -- the well-established Newton & Keller (1974)
 * formula, not a fit/guess. Used only to translate a real `servicePointsWonPct` into an estimated
 * "service games held %" -- a genuinely deeper, game-outcome-relevant statistic than the raw
 * points-won percentage alone, without requiring the provider to report game-level data directly
 * (which it doesn't).
 */
function estimateServiceGameHoldProbability(pointWinProbPct: number): number {
  const p = Math.max(0.01, Math.min(0.99, pointWinProbPct / 100));
  const q = 1 - p;
  const winStraight = Math.pow(p, 4) * (1 + 4 * q + 10 * q * q);
  const reachDeuce = 20 * Math.pow(p, 3) * Math.pow(q, 3);
  const winFromDeuce = (p * p) / (p * p + q * q);
  return Math.round((winStraight + reachDeuce * winFromDeuce) * 1000) / 10;
}

/**
 * Aggregates the point-level breakdown (first-serve win %, break points saved/converted, service
 * games held) from real provider match-level stats. Each field resolves independently -- a
 * provider can supply break-point counts without first-serve splits, or vice versa -- so this
 * never gates one field's availability on another's.
 */
function computePointLevelStats(matches: MatchRecord[], opponentElo: OpponentEloLookup, surface: Surface): PointLevelStats {
  let firstServeWeightedSum = 0;
  let firstServeWeightTotal = 0;
  let bpSavedSum = 0;
  let bpFacedSum = 0;
  let bpConvertedSum = 0;
  let bpReturnFacedSum = 0;
  let gamesHeldWeightedSum = 0;
  let gamesHeldWeightTotal = 0;
  const contributingMatchIds = new Set<string>();

  for (const m of matches) {
    const elo = opponentElo.get(m.id);
    const strengthFactor = (elo !== undefined ? Math.max(0.6, Math.min(1.6, elo / BASELINE_ELO)) : 1) * surfaceWeight(m, surface);

    if (m.stats?.firstServeWon != null) {
      firstServeWeightedSum += m.stats.firstServeWon * strengthFactor;
      firstServeWeightTotal += strengthFactor;
      contributingMatchIds.add(m.id);
    }
    if (m.stats?.breakPointsSaved != null && m.stats?.breakPointsFaced != null && m.stats.breakPointsFaced > 0) {
      bpSavedSum += m.stats.breakPointsSaved * surfaceWeight(m, surface);
      bpFacedSum += m.stats.breakPointsFaced * surfaceWeight(m, surface);
      contributingMatchIds.add(m.id);
    }
    if (m.opponentStats?.breakPointsFaced != null && m.opponentStats?.breakPointsSaved != null && m.opponentStats.breakPointsFaced > 0) {
      // The opponent's own break points faced/saved on THEIR serve, during this same match, is
      // exactly how many break points this player generated/converted while returning.
      bpConvertedSum += (m.opponentStats.breakPointsFaced - m.opponentStats.breakPointsSaved) * surfaceWeight(m, surface);
      bpReturnFacedSum += m.opponentStats.breakPointsFaced * surfaceWeight(m, surface);
      contributingMatchIds.add(m.id);
    }
    if (m.stats?.servicePointsWonPct != null) {
      gamesHeldWeightedSum += estimateServiceGameHoldProbability(m.stats.servicePointsWonPct) * strengthFactor;
      gamesHeldWeightTotal += strengthFactor;
      contributingMatchIds.add(m.id);
    }
  }

  return {
    firstServeWinPct: firstServeWeightTotal > 0 ? Math.round((firstServeWeightedSum / firstServeWeightTotal) * 10) / 10 : null,
    breakPointsSavedPct: bpFacedSum > 0 ? Math.round((bpSavedSum / bpFacedSum) * 1000) / 10 : null,
    breakPointsConvertedPct: bpReturnFacedSum > 0 ? Math.round((bpConvertedSum / bpReturnFacedSum) * 1000) / 10 : null,
    serviceGamesHeldPct: gamesHeldWeightTotal > 0 ? Math.round((gamesHeldWeightedSum / gamesHeldWeightTotal) * 10) / 10 : null,
    sampleSize: contributingMatchIds.size,
  };
}

/**
 * Nudges a base 0-100 rating toward a point-level metric's own centered rating, only when that
 * metric actually resolved for BOTH players (the same "fair comparison" rule the top-level
 * real-vs-proxy fallback already uses) and each side has enough matches behind it -- otherwise
 * returns the base rating completely unchanged.
 */
function blendPointLevel(baseRating: number, p1Pct: number | null, p2Pct: number | null, p1Sample: number, p2Sample: number, tourAvg: number): number {
  if (p1Pct === null || p2Pct === null || p1Sample < MIN_POINT_LEVEL_SAMPLE || p2Sample < MIN_POINT_LEVEL_SAMPLE) return baseRating;
  const centered = Math.max(5, Math.min(95, 50 + (p1Pct - tourAvg) * POINT_LEVEL_RATING_SCALE));
  return Math.max(5, Math.min(95, baseRating * (1 - POINT_LEVEL_BLEND_WEIGHT) + centered * POINT_LEVEL_BLEND_WEIGHT));
}

/**
 * Average games-per-set differential in matches won vs lost, as a serve/return dominance proxy,
 * weighted by the real strength of the opponent when it's known (a set margin against a strong
 * opponent counts for more than the same margin against a weak one) instead of treating every
 * match equally.
 */
function ratingsFromMargins(
  matches: MatchRecord[],
  opponentElo: OpponentEloLookup,
  surface: Surface,
): { serve: number; ret: number; sample: number; coverage: number } {
  // `setGameMargins` is a fixed-length (5-slot) array padded with {0,0} trailing entries for
  // unplayed sets -- `.length` is always 5 regardless of real set count, so filtering (and later
  // iterating) must go through `realSetGameMargins` instead, or matches with zero real set data
  // get counted in, and every match's weighted-margin sum gets diluted by the padded zero sets.
  const withMargins = matches
    .map((m) => ({ match: m, realMargins: realSetGameMargins(m) }))
    .filter((entry) => entry.realMargins.length > 0);
  if (withMargins.length === 0) return { serve: 50, ret: 50, sample: 0, coverage: 0 };

  let weightedMarginSum = 0;
  let weightTotal = 0;
  let coveredMatches = 0;
  for (const { match: m, realMargins } of withMargins) {
    const elo = opponentElo.get(m.id);
    const strengthFactor = (elo !== undefined ? Math.max(0.6, Math.min(1.6, elo / BASELINE_ELO)) : 1) * surfaceWeight(m, surface);
    if (elo !== undefined) coveredMatches += 1;
    for (const set of realMargins) {
      weightedMarginSum += (set.playerGames - set.opponentGames) * strengthFactor;
      weightTotal += strengthFactor;
    }
  }
  const avgMargin = weightTotal > 0 ? weightedMarginSum / weightTotal : 0;
  // Map an average game-margin per set (roughly -6..6) onto a 0-100 rating centered at 50.
  const rating = Math.max(5, Math.min(95, 50 + avgMargin * 6));
  return { serve: rating, ret: rating, sample: withMargins.length, coverage: coveredMatches / withMargins.length };
}

/**
 * Real, provider-reported service/return points-won percentages for matches where the provider
 * included match-level statistics, weighted by real opponent strength where available (same
 * approach as the margin-based proxy). Returns null when fewer than MIN_REAL_SAMPLE matches have
 * real stats -- callers must fall back to the proxy rather than rate off a handful of matches.
 */
function realRatingsFromStats(
  matches: MatchRecord[],
  opponentElo: OpponentEloLookup,
  surface: Surface,
): { serve: number; ret: number; sample: number; coverage: number } | null {
  const withStats = matches.filter((m) => m.stats?.servicePointsWonPct != null && m.stats?.returnPointsWon != null);
  if (withStats.length < MIN_REAL_SAMPLE) return null;

  let serveWeightedSum = 0;
  let retWeightedSum = 0;
  let weightTotal = 0;
  let coveredMatches = 0;
  for (const m of withStats) {
    const elo = opponentElo.get(m.id);
    const strengthFactor = (elo !== undefined ? Math.max(0.6, Math.min(1.6, elo / BASELINE_ELO)) : 1) * surfaceWeight(m, surface);
    if (elo !== undefined) coveredMatches += 1;
    serveWeightedSum += m.stats!.servicePointsWonPct! * strengthFactor;
    retWeightedSum += m.stats!.returnPointsWon! * strengthFactor;
    weightTotal += strengthFactor;
  }
  const avgServicePct = serveWeightedSum / weightTotal;
  const avgReturnPct = retWeightedSum / weightTotal;
  const serve = Math.max(5, Math.min(95, 50 + (avgServicePct - TOUR_AVG_SERVICE_POINTS_WON_PCT) * REAL_STATS_RATING_SCALE));
  const ret = Math.max(5, Math.min(95, 50 + (avgReturnPct - TOUR_AVG_RETURN_POINTS_WON_PCT) * REAL_STATS_RATING_SCALE));
  return { serve, ret, sample: withStats.length, coverage: coveredMatches / withStats.length };
}

export function computeServeReturnModule(
  player1Matches: MatchRecord[],
  player2Matches: MatchRecord[],
  surface: Surface,
  player1OpponentElo: OpponentEloLookup = new Map(),
  player2OpponentElo: OpponentEloLookup = new Map(),
): ServeReturnResult {
  // Prefer real, provider-reported point-level stats when both players have enough matches with
  // them -- a mix of real stats for one player and a proxy for the other isn't a fair comparison,
  // so the module falls back to the margin-based proxy for both players unless both clear the bar.
  const p1Real = realRatingsFromStats(player1Matches, player1OpponentElo, surface);
  const p2Real = realRatingsFromStats(player2Matches, player2OpponentElo, surface);

  const p1PointLevel = computePointLevelStats(player1Matches, player1OpponentElo, surface);
  const p2PointLevel = computePointLevelStats(player2Matches, player2OpponentElo, surface);

  if (p1Real && p2Real) {
    const minSample = Math.min(p1Real.sample, p2Real.sample);
    // Real data starts at a meaningfully higher floor than the proxy's 60 cap, and keeps climbing
    // with more matches -- unlike the proxy, this is never artificially capped at "not excellent".
    let reliability = Math.max(65, Math.min(95, 65 + (minSample - MIN_REAL_SAMPLE) * 5));

    const warnings: string[] = [];
    if (minSample < MIN_SAMPLE_FOR_NO_WARNING) {
      warnings.push(`Only ${minSample} match(es) with real point-level stats for one player -- confidence is limited despite using real data.`);
    }
    if (p1Real.coverage < 0.5 || p2Real.coverage < 0.5) {
      warnings.push("Opponent-strength weighting is only partially available -- some matches are weighted as opponent-neutral.");
    }

    // Deepen the headline rating with the point-level breakdown (service games held, break
    // points converted) when it resolves for both players -- a modest, capped nudge (see
    // `blendPointLevel`) on top of the already-real servicePointsWonPct/returnPointsWon rating,
    // never a replacement for it. When the point-level fields are unavailable this is a no-op,
    // so it never changes behavior for a provider stat line that only reports the match-level
    // percentages (the pre-existing, tested behavior).
    let player1ServeRating = blendPointLevel(p1Real.serve, p1PointLevel.serviceGamesHeldPct, p2PointLevel.serviceGamesHeldPct, p1PointLevel.sampleSize, p2PointLevel.sampleSize, TOUR_AVG_SERVICE_GAMES_HELD_PCT);
    let player2ServeRating = blendPointLevel(p2Real.serve, p2PointLevel.serviceGamesHeldPct, p1PointLevel.serviceGamesHeldPct, p2PointLevel.sampleSize, p1PointLevel.sampleSize, TOUR_AVG_SERVICE_GAMES_HELD_PCT);
    let player1ReturnRating = blendPointLevel(p1Real.ret, p1PointLevel.breakPointsConvertedPct, p2PointLevel.breakPointsConvertedPct, p1PointLevel.sampleSize, p2PointLevel.sampleSize, TOUR_AVG_BREAK_POINTS_CONVERTED_PCT);
    let player2ReturnRating = blendPointLevel(p2Real.ret, p2PointLevel.breakPointsConvertedPct, p1PointLevel.breakPointsConvertedPct, p2PointLevel.sampleSize, p1PointLevel.sampleSize, TOUR_AVG_BREAK_POINTS_CONVERTED_PCT);

    const pointLevelApplied =
      p1PointLevel.serviceGamesHeldPct !== null &&
      p2PointLevel.serviceGamesHeldPct !== null &&
      p1PointLevel.sampleSize >= MIN_POINT_LEVEL_SAMPLE &&
      p2PointLevel.sampleSize >= MIN_POINT_LEVEL_SAMPLE;
    if (pointLevelApplied) {
      reliability = Math.min(95, reliability + 5);
    }

    return {
      player1ServeRating: Math.round(player1ServeRating),
      player2ServeRating: Math.round(player2ServeRating),
      player1ReturnRating: Math.round(player1ReturnRating),
      player2ReturnRating: Math.round(player2ReturnRating),
      player1PointLevel: p1PointLevel,
      player2PointLevel: p2PointLevel,
      reliability: Math.round(reliability),
      defaulted: false,
      note: pointLevelApplied ? `${REAL_STATS_NOTE} Deepened with point-level inputs (first-serve win %, break points saved/converted, estimated service games held).` : REAL_STATS_NOTE,
      warnings,
    };
  }

  const p1 = ratingsFromMargins(player1Matches, player1OpponentElo, surface);
  const p2 = ratingsFromMargins(player2Matches, player2OpponentElo, surface);

  const minSample = Math.min(p1.sample, p2.sample);
  const reliability = Math.max(5, Math.min(60, minSample * 6)); // capped -- this is a proxy, never "excellent"

  const warnings: string[] = [];
  if (minSample < MIN_SAMPLE_FOR_NO_WARNING) {
    warnings.push(`Only ${minSample} match(es) with recorded set scores for one player -- serve/return proxy is low-confidence.`);
  }
  if (p1.coverage < 0.5 || p2.coverage < 0.5) {
    warnings.push("Opponent-strength weighting is only partially available -- some matches are weighted as opponent-neutral.");
  }

  return {
    player1ServeRating: Math.round(p1.serve),
    player2ServeRating: Math.round(p2.serve),
    player1ReturnRating: Math.round(p1.ret),
    player2ReturnRating: Math.round(p2.ret),
    player1PointLevel: p1PointLevel,
    player2PointLevel: p2PointLevel,
    reliability: Math.round(reliability),
    defaulted: p1.sample === 0 || p2.sample === 0,
    note: PROXY_NOTE,
    warnings,
  };
}
