import type { MatchRecord } from "../tennisData/types";
import { inferVenue, type Venue } from "./venueMap";

export type RestCategory = "ShortRest" | "Normal" | "LongLayoff" | "Unknown";
export type TravelBucket = "None" | "Local" | "Regional" | "Intercontinental";

/**
 * A rest gap of this many days or fewer is a real short-turnaround risk (documented threshold,
 * not a medical claim) -- both a fatigue signal and, on tour, often a sign a player is playing
 * through a compressed schedule (e.g. deep run at the prior event).
 */
export const SHORT_REST_THRESHOLD_DAYS = 2;
/**
 * A rest gap of this many days or more is a genuine layoff long enough to raise a "ring rust"
 * question (return from injury, off-season, or a bad early loss) -- distinct from the
 * recent-retirement window below, which flags WHY a layoff happened, not just its length.
 */
export const LONG_LAYOFF_THRESHOLD_DAYS = 14;

/** Documented travel-distance buckets, coarser than the raw km figure but finer than the old flat number -- lets a matchup be flagged as "no travel" vs "short hop" vs "same-continent" vs "intercontinental" without pretending we can weigh a 300km trip the same as a 9,000km one. */
export const TRAVEL_LOCAL_MAX_KM = 800;
export const TRAVEL_REGIONAL_MAX_KM = 4000;

function travelBucketFromKm(km: number): TravelBucket {
  if (km <= 0) return "None";
  if (km <= TRAVEL_LOCAL_MAX_KM) return "Local";
  if (km <= TRAVEL_REGIONAL_MAX_KM) return "Regional";
  return "Intercontinental";
}

function restCategoryFromDays(days: number | null): RestCategory {
  if (days === null) return "Unknown";
  if (days <= SHORT_REST_THRESHOLD_DAYS) return "ShortRest";
  if (days >= LONG_LAYOFF_THRESHOLD_DAYS) return "LongLayoff";
  return "Normal";
}

export type ConfirmedAvailabilityConcernType = "MidMatchRetirement" | "Walkover" | null;

export interface PlayerAvailability {
  /** Exact real days between a player's most recent completed match and this one. Null when the player has no prior match on record at all. */
  daysSinceLastMatch: number | null;
  /** Bucketed read of `daysSinceLastMatch` against the documented thresholds above. "Unknown" only when there's no prior match to measure from. */
  restCategory: RestCategory;
  /** Great-circle distance (km) between the venue of a player's most recent match and this match's venue, computed from real, verified venue coordinates. Null when either venue can't be resolved, or there's no prior match. */
  travelDistanceKm: number | null;
  /** Bucketed read of `travelDistanceKm` (see `TRAVEL_LOCAL_MAX_KM`/`TRAVEL_REGIONAL_MAX_KM`). Null exactly when `travelDistanceKm` is null. */
  travelBucket: TravelBucket | null;
  /**
   * True only when the player's own real match record shows they retired or received a
   * walkover-related result within the lookback window -- a genuine recorded fact, not a
   * diagnosis of an ongoing injury. Retirement always means the loser retired mid-match
   * (`retired && result === "L"`), so this only fires for the player who actually stopped play.
   */
  recentRetirementOrWithdrawal: boolean;
  /** The tournament name of the match that produced `recentRetirementOrWithdrawal`, for disclosure. Null when the flag is false. */
  recentRetirementTournament: string | null;
  /**
   * True only when the player's own real match record shows a walkover LOSS (`walkover && result
   * === "L"`) within the lookback window -- i.e. they were withdrawn before a ball was struck.
   * This is a more definitive real-data signal than a mid-match retirement (the player never took
   * the court at all), and was previously ignored by this module even though `walkover` was
   * already present on every `MatchRecord`.
   */
  recentWalkoverGiven: boolean;
  /** The tournament name of the match that produced `recentWalkoverGiven`, for disclosure. Null when the flag is false. */
  recentWalkoverTournament: string | null;
  /** The stronger of `recentRetirementOrWithdrawal` / `recentWalkoverGiven` (a walkover, being pre-match, is treated as the more definitive confirmed concern when both are somehow present). Null when neither fired. */
  confirmedAvailabilityConcernType: ConfirmedAvailabilityConcernType;
  /** Tournament name backing `confirmedAvailabilityConcernType`. Null when it is null. */
  confirmedAvailabilityConcernTournament: string | null;
}

export interface AvailabilityResult {
  player1: PlayerAvailability;
  player2: PlayerAvailability;
  /**
   * Real-data-derived 0-100 "freshness/availability" score per player, built entirely from
   * `restCategory`/`travelBucket`/confirmed-concern -- each component only nudges the score when
   * its underlying data actually resolved (see `computeAvailabilityScore`), so a player with no
   * resolvable signals lands on the neutral baseline rather than a fabricated extreme.
   */
  player1AvailabilityScore: number;
  player2AvailabilityScore: number;
  reliability: number;
  note: string;
  warnings: string[];
}

const EARTH_RADIUS_KM = 6371;
// A retirement/walkover more than this many days ago is treated as fully resolved (no signal) --
// there's no verified data on actual recovery time, so this window is a documented, conservative
// modeling choice (roughly one full tour cycle back to the same event), not a medical claim.
const RECENT_RETIREMENT_WINDOW_DAYS = 21;

function haversineKm(a: Venue, b: Venue): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return Math.round(EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function mostRecentMatch(matches: MatchRecord[]): MatchRecord | null {
  if (matches.length === 0) return null;
  // Callers already sort matches newest-first, but don't assume it -- pick the max by date directly.
  return matches.reduce((latest, m) => (new Date(m.date).getTime() > new Date(latest.date).getTime() ? m : latest));
}

/**
 * Real-data availability score (0-100, higher = fresher/more available), built ONLY from
 * components that actually resolved for this player -- an unresolved component contributes
 * nothing (not a fabricated "neutral" penalty/bonus), so a player with zero resolvable signals
 * lands exactly on the neutral baseline below, same as the pre-existing "absent, not faked"
 * contract the rest of this module follows.
 */
function computeAvailabilityScore(a: PlayerAvailability): number {
  const NEUTRAL = 60;
  let score = NEUTRAL;

  if (a.restCategory === "ShortRest") score -= 15;
  else if (a.restCategory === "LongLayoff") score -= 6;
  else if (a.restCategory === "Normal") score += 8;

  if (a.travelBucket === "Regional") score -= 5;
  else if (a.travelBucket === "Intercontinental") score -= 12;

  if (a.confirmedAvailabilityConcernType === "Walkover") score -= 30;
  else if (a.confirmedAvailabilityConcernType === "MidMatchRetirement") score -= 18;

  return Math.max(0, Math.min(100, score));
}

function computeOnePlayer(matches: MatchRecord[], currentVenue: Venue | null, now: Date, warnings: string[], playerLabel: string): PlayerAvailability {
  const last = mostRecentMatch(matches);

  let daysSinceLastMatch: number | null = null;
  let travelDistanceKm: number | null = null;
  if (last) {
    const lastDate = new Date(last.date);
    daysSinceLastMatch = Math.max(0, Math.round((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000)));

    const lastVenue = inferVenue(last.tournamentName);
    if (lastVenue && currentVenue) {
      travelDistanceKm = haversineKm(lastVenue, currentVenue);
    }
    // Unresolved travel distance (venue not in the known-venue list) is expected/common and not
    // surfaced as a user-facing warning -- it's still displayed as "n/a" in the UI and still barely
    // moves `reliability` below, but it isn't a signal worth interrupting the user with.
  } else {
    warnings.push(`${playerLabel}: no prior match history at all -- rest days and travel distance can't be computed.`);
  }

  const cutoff = now.getTime() - RECENT_RETIREMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentRetirement = matches.find((m) => m.retired && m.result === "L" && new Date(m.date).getTime() >= cutoff) ?? null;
  const recentWalkover = matches.find((m) => m.walkover && m.result === "L" && new Date(m.date).getTime() >= cutoff) ?? null;

  // A pre-match walkover is a more definitive confirmed-withdrawal signal than a mid-match
  // retirement (the player never took the court at all), so it wins when both somehow fired.
  const confirmedAvailabilityConcernType: ConfirmedAvailabilityConcernType = recentWalkover ? "Walkover" : recentRetirement ? "MidMatchRetirement" : null;
  const confirmedAvailabilityConcernTournament = recentWalkover?.tournamentName ?? recentRetirement?.tournamentName ?? null;

  return {
    daysSinceLastMatch,
    restCategory: restCategoryFromDays(daysSinceLastMatch),
    travelDistanceKm,
    travelBucket: travelDistanceKm !== null ? travelBucketFromKm(travelDistanceKm) : null,
    recentRetirementOrWithdrawal: recentRetirement !== null,
    recentRetirementTournament: recentRetirement?.tournamentName ?? null,
    recentWalkoverGiven: recentWalkover !== null,
    recentWalkoverTournament: recentWalkover?.tournamentName ?? null,
    confirmedAvailabilityConcernType,
    confirmedAvailabilityConcernTournament,
  };
}

/**
 * Real injury/travel/rest signals, built entirely from verified data already on hand -- no
 * external injury-news feed was found to be reachable from this environment (RAPIDAPI_KEY and
 * API_SPORTS_KEY are present but neither resolves to a live, subscribed tennis data source as of
 * 2026-07-11 -- see docs/audit-phase4-availability.md). Rather than fabricate a "current fitness"
 * score that looks verified but isn't, this module reports what it CAN verify, at finer
 * granularity than the original version:
 *   1. Exact rest days since each player's last real completed match, bucketed against explicit,
 *      documented thresholds (`SHORT_REST_THRESHOLD_DAYS` / `LONG_LAYOFF_THRESHOLD_DAYS`).
 *   2. Real travel distance between that match's venue and this one (same verified venue
 *      coordinates the weather module relies on, `venueMap.ts`), bucketed into
 *      None/Local/Regional/Intercontinental instead of a flat, undifferentiated km figure.
 *   3. A CONFIRMED withdrawal/injury signal built from TWO real match-record facts, not one:
 *      a mid-match retirement (`retired && result === "L"`, as before) AND -- newly -- a
 *      pre-match walkover given (`walkover && result === "L"`), which every `MatchRecord` has
 *      always carried but this module previously ignored entirely. A walkover means the player
 *      never even took the court, which is a more definitive real signal than a retirement.
 * Withdrawal announced *before* any of a player's own match records reflect it (e.g. a same-day
 * news-only pullout) still has no verified source connected -- that gap is disclosed explicitly
 * in the engine's `availabilityNote`, never silently assumed away.
 */
export function computeAvailabilityModule(
  player1Matches: MatchRecord[],
  player2Matches: MatchRecord[],
  tournamentName: string | null | undefined,
  now: Date = new Date(),
  /**
   * Task #107 (Phase 5): Optional real-time web-research injury signal from Gemini, pre-fetched
   * by the caller. When present, a high riskLevel (≥60) for a player depresses their availability
   * score and surfaces a user-facing warning so it's never silently applied.
   */
  webResearch?: import("../shared/webResearchProvider.js").MatchupResearch | null,
): AvailabilityResult {
  const currentVenue = inferVenue(tournamentName);
  const warnings: string[] = [];
  // An unresolved match venue (not in the known-venue list) is common and expected -- travel
  // distance simply displays as "n/a" and barely moves `reliability` below; it is not surfaced
  // as a user-facing warning.

  const player1 = computeOnePlayer(player1Matches, currentVenue, now, warnings, "Player 1");
  const player2 = computeOnePlayer(player2Matches, currentVenue, now, warnings, "Player 2");

  // Reliability reflects how much of this module is actually backed by resolvable data for THIS
  // match, weighted so rest days (need only a prior match, usually available) dominate and travel
  // distance (needs two resolved venues, much rarer -- gated by venueMap's current ~18-tournament
  // coverage) barely moves the score either way. Unresolved travel is the expected common case,
  // not a data gap worth dragging reliability (and therefore Data Quality) down over.
  const REST_SIGNAL_WEIGHT = 0.4; // per player -- dominant driver
  const TRAVEL_SIGNAL_WEIGHT = 0.1; // per player -- barely moves the score when unresolved
  let weightedResolved = 0;
  if (player1.daysSinceLastMatch !== null) weightedResolved += REST_SIGNAL_WEIGHT;
  if (player2.daysSinceLastMatch !== null) weightedResolved += REST_SIGNAL_WEIGHT;
  if (player1.travelDistanceKm !== null) weightedResolved += TRAVEL_SIGNAL_WEIGHT;
  if (player2.travelDistanceKm !== null) weightedResolved += TRAVEL_SIGNAL_WEIGHT;
  const reliability = Math.round(weightedResolved * 100);

  if (player1.recentWalkoverGiven) {
    warnings.push(`Player 1 was withdrawn (walkover) at ${player1.recentWalkoverTournament ?? "a recent tournament"} within the last 3 weeks -- a real, confirmed pre-match withdrawal, weighted more heavily than a mid-match retirement.`);
  }
  if (player2.recentWalkoverGiven) {
    warnings.push(`Player 2 was withdrawn (walkover) at ${player2.recentWalkoverTournament ?? "a recent tournament"} within the last 3 weeks -- a real, confirmed pre-match withdrawal, weighted more heavily than a mid-match retirement.`);
  }

  // Task #107 Phase 5: web-research injury signal. Only surfaces a warning and applies a
  // small score discount when riskLevel is elevated (≥60/100), so ordinary matches are
  // unaffected. The signal is always disclosed explicitly -- never silently baked in.
  const WEB_RESEARCH_RISK_THRESHOLD = 60;
  let p1Score = computeAvailabilityScore(player1);
  let p2Score = computeAvailabilityScore(player2);
  if (webResearch?.selected && typeof webResearch.selected.riskLevel === "number" && webResearch.selected.riskLevel >= WEB_RESEARCH_RISK_THRESHOLD) {
    const riskExcess = webResearch.selected.riskLevel - WEB_RESEARCH_RISK_THRESHOLD;
    const discount = Math.round(riskExcess / 2); // 0–20 pt discount
    p1Score = Math.max(0, p1Score - discount);
    const detail = webResearch.selected.injuryDetail ?? webResearch.selected.injuryStatus ?? "injury/fitness concern";
    warnings.push(`Real-time injury research (Player 1): risk score ${webResearch.selected.riskLevel}/100 — ${detail}. Applied ${discount}-point availability discount.`);
  }
  if (webResearch?.opponent && typeof webResearch.opponent.riskLevel === "number" && webResearch.opponent.riskLevel >= WEB_RESEARCH_RISK_THRESHOLD) {
    const riskExcess = webResearch.opponent.riskLevel - WEB_RESEARCH_RISK_THRESHOLD;
    const discount = Math.round(riskExcess / 2);
    p2Score = Math.max(0, p2Score - discount);
    const detail = webResearch.opponent.injuryDetail ?? webResearch.opponent.injuryStatus ?? "injury/fitness concern";
    warnings.push(`Real-time injury research (Player 2): risk score ${webResearch.opponent.riskLevel}/100 — ${detail}. Applied ${discount}-point availability discount.`);
  }

  return {
    player1,
    player2,
    player1AvailabilityScore: p1Score,
    player2AvailabilityScore: p2Score,
    reliability,
    note:
      `Rest days (bucketed as ShortRest <=${SHORT_REST_THRESHOLD_DAYS}d / Normal / LongLayoff >=${LONG_LAYOFF_THRESHOLD_DAYS}d) and confirmed-withdrawal flags (mid-match retirement OR pre-match walkover) are real, derived from each player's actual match record. Travel distance is a real great-circle calculation between verified venue coordinates, bucketed into None/Local (<=${TRAVEL_LOCAL_MAX_KM}km)/Regional (<=${TRAVEL_REGIONAL_MAX_KM}km)/Intercontinental, but only available when both the last and current tournaments are in the known-venue list. No verified pre-match news-only withdrawal/injury feed is connected -- see the prediction's availability disclosure.`,
    warnings,
  };
}
