import type { MatchRecord, Surface, TournamentLevel } from "../tennisData/types";
import type { OpponentEloLookup } from "./opponentStrength";
import { eloFallbackTracker } from "./fallbackTracking";
import { asFraction, asPercentage, type Fraction, type Percentage } from "./units";

/**
 * `Percentage` (0-100) vs `Fraction` (0-1) below are branded per the convention in `./units.ts` --
 * read that file first. This module is the reference example: `eloWinProbabilityPlayer1` and
 * `reliability` are `Percentage` (display directly, never re-multiply by 100); `player1BlendWeight`
 * and `player1TourLevelShare` are `Fraction` (must go through `fractionToPercentage` before
 * display). The WIN PROB (ELO) bug was exactly this distinction getting lost once the value left
 * this file as a plain `number`.
 */
export interface SurfaceEloResult {
  /** Final rating actually used for the win-probability edge -- a recency/competition-level-weighted surface-only Elo, blended toward the player's overall (cross-surface) Elo when their surface-specific sample is shallow. */
  player1SurfaceElo: number;
  player2SurfaceElo: number;
  eloDifference: number;
  /** Player 1's win probability (Percentage, 0-100), pulled toward 50 when the underlying rating gap is backed by high uncertainty -- see `rawEloWinProbabilityPlayer1` for the un-shrunk figure. */
  eloWinProbabilityPlayer1: Percentage;
  /** Un-shrunk logistic win probability (Percentage, 0-100) from `eloDifference` alone, before the uncertainty pull-to-50 is applied. Kept for transparency/debugging -- `eloWinProbabilityPlayer1` is what the ensemble actually votes with. */
  rawEloWinProbabilityPlayer1: Percentage;
  /** Uncertainty-aware confidence (Percentage, 0-100), derived from each player's *effective* (recency/level-weighted) surface sample size rather than a flat count -- this now IS the same figure used to shrink `eloWinProbabilityPlayer1` toward 50. */
  reliability: Percentage;
  /** Raw count of on-surface matches found for each player (unweighted) -- kept for existing consumers (`computeSurfaceSampleDepth`, `upsetRisk.ts`) that key off the plain match count. */
  sampleSizePlayer1: number;
  sampleSizePlayer2: number;
  /** Recency/competition-level-weighted "effective" surface sample size -- a recent Masters/Slam match counts close to 1, an old Challenger match counts a small fraction. Drives `reliability` and the overall-Elo fallback blend below. */
  effectiveSampleSizePlayer1: number;
  effectiveSampleSizePlayer2: number;
  /** Cross-surface (all-surfaces) Elo, computed with the same recency/level weighting -- the fallback rating blended in when a player's surface-specific history is thin. */
  player1OverallElo: number;
  player2OverallElo: number;
  /** Pure surface-only Elo (recency/level-weighted, but with NO overall-Elo blending) -- kept for transparency so the blend's effect is auditable. */
  player1SurfaceOnlyElo: number;
  player2SurfaceOnlyElo: number;
  /** Fraction (0-1): how much of `player1SurfaceElo`/`player2SurfaceElo` came from the overall-Elo fallback rather than the player's own surface-only rating. 0 = pure surface Elo, 1 = pure overall Elo. Fades smoothly toward 0 as the player's effective surface sample grows. */
  player1BlendWeight: Fraction;
  player2BlendWeight: Fraction;
  /** Fraction (0-1) share of each player's OVERALL (cross-surface) effective sample that came from genuine
   * tour-level competition (ATP/WTA main tour or above), not Challenger/ITF/Other. Low share
   * means their rating leans on `tourLevelCredibility` shrink toward the corpus baseline. */
  player1TourLevelShare: Fraction;
  player2TourLevelShare: Fraction;
  /** True when either player has no surface-specific history and the baseline Elo is used. */
  defaulted: boolean;
  warnings: string[];
}

const STARTING_ELO = 1500;
/** Base K-factor for a full-weight (most-recent, mid-tier-competition) match -- scaled per-match by `recencyWeight()` and `levelMultiplier()` below. */
const BASE_K = 32;
const MIN_SAMPLE_FOR_NO_WARNING = 5;

/**
 * Real corpus-wide average `eloOverall` (see `matchFeatureSnapshotsTable`, written by the Phase 3
 * backfill's chronological Elo replay) as of 2026-07-13, across ~29.4k feature rows: mean 1523.1,
 * median 1516. Used two ways below: (1) `LEVEL_BASELINE_ELO` replaces the old flat `STARTING_ELO`
 * assumption for an opponent this system has never seen, with the REAL average rating actually
 * observed at that match's own level, instead of a single made-up neutral constant; (2)
 * `CORPUS_BASELINE_ELO` anchors the tour-level-credibility shrink below.
 *
 * Root cause this addresses: a player whose rating is built almost entirely from beating other
 * Challenger/ITF players can rise well above 1500 *within that pool's own reference frame* even
 * though the pool's real average strength is far below tour level -- because most of their
 * matches never touch a tour-level opponent, there's nothing to pull their number back toward a
 * real cross-level anchor. This let e.g. a Challenger/ITF-only player's surface Elo (1619) read
 * as stronger than an established ATP tour player's (1545), despite the tour player facing
 * objectively tougher competition throughout their own history.
 */
export const CORPUS_BASELINE_ELO = 1520;
/** Real average `eloOverall` observed at matches of each level, from the same 2026-07-13 query,
 * grouped by that match's own `tournamentLevel` (rounded). Missing/"Other" levels use the
 * corpus-wide baseline -- never a fabricated per-level number. */
const LEVEL_BASELINE_ELO: Partial<Record<TournamentLevel, number>> = {
  GrandSlam: 1523,
  Masters1000: 1537,
  WTA1000: 1528,
  ATP500: 1533,
  WTA500: 1533, // no WTA500 rows in the corpus yet -- shares ATP500's real average as the closest same-tier analog.
  ATP250: 1524,
  WTA250: 1522,
  Challenger: 1524,
  ITF: 1522,
  Other: 1507,
};

/**
 * Exported for reuse (Task #77) -- any code that needs "the real, level-aware average rating to
 * assume for a genuinely unresolved opponent" should call this rather than re-deriving its own
 * copy; the level-aware baseline value itself is owned here by #76 and is never re-implemented
 * elsewhere.
 */
export function levelBaselineElo(level: TournamentLevel | null): number {
  if (!level) return CORPUS_BASELINE_ELO;
  return LEVEL_BASELINE_ELO[level] ?? CORPUS_BASELINE_ELO;
}

/** Levels considered genuine tour-level competition (main ATP/WTA tour and above). Challenger,
 * ITF, "Other", and unresolved levels are sub-tour -- a rating built mostly from beating sub-tour
 * fields shouldn't earn full credit for deviating from the baseline; see `tourLevelCredibility`. */
const TOUR_LEVELS = new Set<TournamentLevel>(["GrandSlam", "Masters1000", "WTA1000", "ATP500", "WTA500", "ATP250", "WTA250"]);

function isTourLevel(level: TournamentLevel | null): boolean {
  return level !== null && TOUR_LEVELS.has(level);
}

/** Floor on how much a rating's deviation from `CORPUS_BASELINE_ELO` is trusted when NONE of a
 * player's effective sample came from tour-level competition -- real sub-tour wins still count
 * for something (never zero), just heavily discounted, mirroring `MIN_RECENCY_WEIGHT`'s floor. */
const TOUR_CREDIBILITY_FLOOR = 0.35;

/**
 * Recency half-life: a match this many days old counts for half as much toward the Elo update
 * (and toward the "effective sample size" used for confidence/blending) as a match happening
 * today. ~18 months -- long enough that a full recent season still dominates, short enough that a
 * strong surface run from several years ago doesn't silently freeze a rating that no longer
 * reflects the player's current level on that surface.
 */
const RECENCY_HALF_LIFE_DAYS = 545;
/** Floor on recency weight -- an old match still counts for a little (real history isn't erased), just heavily discounted. */
const MIN_RECENCY_WEIGHT = 0.12;

/**
 * How much a match's competition level scales its K-factor -- a Grand Slam/Masters result is
 * real signal about current top-level ability and should move the rating more than a Challenger
 * or ITF result against much weaker fields. Missing/"Other" levels use `DEFAULT_LEVEL_MULTIPLIER`
 * (never fabricated as any specific tier).
 */
const LEVEL_K_MULTIPLIER: Partial<Record<TournamentLevel, number>> = {
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
const DEFAULT_LEVEL_MULTIPLIER = 0.85;

/** Effective-sample-size scale for the overall-Elo fallback blend: at this many effective surface matches, the blend is already down to ~37% overall / 63% surface; it keeps fading smoothly from there. */
const BLEND_EFFECTIVE_SAMPLE_SCALE = 4;
/** Effective-sample-size scale for confidence: at this many effective surface matches, confidence reaches ~63 of its max. */
const CONFIDENCE_EFFECTIVE_SAMPLE_SCALE = 6;

function levelMultiplier(level: TournamentLevel | null): number {
  if (!level) return DEFAULT_LEVEL_MULTIPLIER;
  return LEVEL_K_MULTIPLIER[level] ?? DEFAULT_LEVEL_MULTIPLIER;
}

/** Exponential decay weight (0-1, floored at `MIN_RECENCY_WEIGHT`) for a match `ageDays` before `referenceDate`. */
function recencyWeight(matchDate: string, referenceDate: string): number {
  const ageMs = new Date(referenceDate).getTime() - new Date(matchDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.max(MIN_RECENCY_WEIGHT, Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS));
}

/**
 * Replays a chronologically-sorted set of matches into a single Elo rating, weighting each
 * match's K-factor by how recent it was (relative to `referenceDate`, the player's own most
 * recent match on record) and by its competition level. When a real opponent-strength estimate
 * is available (from Phase 3's historical store) it's used directly for that match's expected
 * score; otherwise this falls back to the league-average (starting-Elo) opponent assumption --
 * never a fabricated strength. Also returns the recency-weighted "effective sample size" -- a
 * more honest measure of how much real, still-relevant evidence backs the rating than a flat
 * match count.
 */
function replayElo(
  matches: MatchRecord[],
  opponentElo: OpponentEloLookup,
  referenceDate: string,
  /**
   * When provided, every match replayed here records a fallback-tracker attempt (Task #77) --
   * pass this only from the ONE replay pass that iterates every one of the player's matches
   * exactly once (the overall, cross-surface replay), never from the surface-scoped replay too,
   * or a single match would be double-counted toward the run's fallback rate.
   */
  subjectPlayerId?: string,
): {
  elo: number;
  sampleSize: number;
  effectiveSampleSize: number;
  effectiveTourSampleSize: number;
  effectiveKnownLevelSampleSize: number;
  opponentCoverage: number;
} {
  const sorted = [...matches].sort((a, b) => (a.date > b.date ? 1 : -1));
  let elo = STARTING_ELO;
  let covered = 0;
  let effectiveSampleSize = 0;
  let effectiveTourSampleSize = 0;
  let effectiveKnownLevelSampleSize = 0;

  for (const match of sorted) {
    const knownOpponentElo = opponentElo.get(match.id);
    const usedFallback = knownOpponentElo === undefined;
    if (!usedFallback) covered += 1;
    if (subjectPlayerId !== undefined) {
      eloFallbackTracker.record(
        usedFallback,
        usedFallback
          ? {
              player: subjectPlayerId,
              opponent: match.opponentId,
              opponentName: match.opponentName,
              tournament: match.tournamentName,
              level: match.tournamentLevel,
              date: match.date,
              reason: "opponent's real Elo history could not be resolved (even after identity cross-reference) -- level-aware baseline used",
            }
          : undefined,
      );
    }
    // An opponent this system has never seen is assumed to be an AVERAGE player at THIS match's
    // own level -- not a flat, level-blind 1500 -- so a run of wins against unresolved Challenger
    // or ITF opponents isn't silently scored as "beat a string of tour-average players".
    const opponentReference = knownOpponentElo ?? levelBaselineElo(match.tournamentLevel);
    const expected = 1 / (1 + Math.pow(10, (opponentReference - elo) / 400));
    const actual = match.result === "W" ? 1 : 0;

    const recency = recencyWeight(match.date, referenceDate);
    const k = BASE_K * recency * levelMultiplier(match.tournamentLevel);
    elo += k * (actual - expected);
    effectiveSampleSize += recency;
    // Tour-level share is judged only from matches whose level is actually KNOWN -- a match with
    // no reported level is absent information, not evidence of weak competition, so it's excluded
    // from both the numerator and denominator here rather than counted against the player.
    if (match.tournamentLevel !== null) {
      effectiveKnownLevelSampleSize += recency;
      if (isTourLevel(match.tournamentLevel)) effectiveTourSampleSize += recency;
    }
  }

  return {
    elo,
    sampleSize: sorted.length,
    effectiveSampleSize,
    effectiveTourSampleSize,
    effectiveKnownLevelSampleSize,
    opponentCoverage: sorted.length > 0 ? covered / sorted.length : 0,
  };
}

interface PlayerSurfaceEloResult {
  blendedElo: number;
  surfaceOnlyElo: number;
  overallElo: number;
  blendWeight: number;
  sampleSize: number;
  effectiveSampleSize: number;
  confidence: number;
  /** 0-1 share of the player's OVERALL (cross-surface) effective sample that came from genuine
   * tour-level competition (ATP/WTA main tour or above) rather than Challenger/ITF/Other. Drives
   * `tourLevelCredibility` below. */
  tourLevelShare: number;
  /** 0-1: how much of this player's deviation from `CORPUS_BASELINE_ELO` is trusted, given their
   * tour-level share. 1 = fully trusted (rating earned mostly at tour level), floored at
   * `TOUR_CREDIBILITY_FLOOR` for a player whose rating comes almost entirely from sub-tour play. */
  tourLevelCredibility: number;
}

/**
 * Uncertainty-aware confidence (0-100) from a recency/level-weighted effective sample size, with
 * diminishing returns -- a handful of highly-relevant recent matches earns most of the available
 * confidence quickly, but confidence never fully saturates on a thin sample the way a linear
 * `sampleSize * constant` score would.
 */
function confidenceFromEffectiveSampleSize(effectiveSampleSize: number): number {
  const raw = 100 * (1 - Math.exp(-effectiveSampleSize / CONFIDENCE_EFFECTIVE_SAMPLE_SCALE));
  return Math.max(5, Math.min(100, Math.round(raw)));
}

/**
 * Computes one player's surface-specific Elo, decay/level-weighted, and blends it toward their
 * overall (cross-surface) Elo when their surface-specific effective sample is shallow. The blend
 * fades out smoothly (exponentially) as the surface effective sample grows, rather than a hard
 * cutoff -- a player with 2 real surface matches leans heavily on their overall form, a player
 * with 20 barely leans on it at all.
 */
function computePlayerSurfaceElo(
  matches: MatchRecord[],
  surface: Surface,
  opponentElo: OpponentEloLookup,
  subjectPlayerId?: string,
): PlayerSurfaceEloResult {
  const referenceDate = matches.length > 0 ? matches.reduce((max, m) => (m.date > max ? m.date : max), matches[0].date) : "1970-01-01";
  const onSurface = matches.filter((m) => m.surface === surface);

  const surfaceResult = replayElo(onSurface, opponentElo, referenceDate);
  // Fallback tracking is attached to this pass only -- it iterates every one of the player's
  // matches exactly once (see `replayElo`'s `subjectPlayerId` doc above).
  const overallResult = replayElo(matches, opponentElo, referenceDate, subjectPlayerId);

  const blendWeight = Math.exp(-surfaceResult.effectiveSampleSize / BLEND_EFFECTIVE_SAMPLE_SCALE);
  const rawBlendedElo = blendWeight * overallResult.elo + (1 - blendWeight) * surfaceResult.elo;

  // Tour-level credibility is judged from the player's OVERALL (cross-surface) history, not the
  // surface-only slice -- a thin surface sample shouldn't by itself make an otherwise
  // tour-proven player look uncredible. Judged only against matches with a KNOWN level -- when
  // level is never reported, there's no real evidence of weak competition, so credibility
  // defaults to fully trusted (1) rather than penalized.
  const tourLevelShare =
    overallResult.effectiveKnownLevelSampleSize > 0 ? overallResult.effectiveTourSampleSize / overallResult.effectiveKnownLevelSampleSize : 1;
  const tourLevelCredibility = TOUR_CREDIBILITY_FLOOR + (1 - TOUR_CREDIBILITY_FLOOR) * tourLevelShare;

  // Shrink the rating's deviation from the real corpus baseline toward that baseline in
  // proportion to how little of it is backed by genuine tour-level competition -- this is what
  // stops a Challenger/ITF-only grinder's rating (built almost entirely against sub-tour fields)
  // from reading as strong as a rating built by actually beating tour-level opponents. Applied
  // symmetrically (works the same whether the raw rating sits above or below baseline).
  const blendedElo = CORPUS_BASELINE_ELO + (rawBlendedElo - CORPUS_BASELINE_ELO) * tourLevelCredibility;

  return {
    blendedElo,
    surfaceOnlyElo: surfaceResult.elo,
    overallElo: overallResult.elo,
    blendWeight,
    sampleSize: surfaceResult.sampleSize,
    effectiveSampleSize: surfaceResult.effectiveSampleSize,
    confidence: confidenceFromEffectiveSampleSize(surfaceResult.effectiveSampleSize),
    tourLevelShare,
    tourLevelCredibility,
  };
}

export function computeSurfaceEloModule(
  player1Matches: MatchRecord[],
  player2Matches: MatchRecord[],
  surface: Surface,
  player1OpponentElo: OpponentEloLookup = new Map(),
  player2OpponentElo: OpponentEloLookup = new Map(),
  /**
   * Real player ids (Task #77), used ONLY to attribute fallback-tracker log entries to the right
   * player -- optional and purely additive; omitting them (existing callers/tests) simply means
   * fallback events from that call aren't attributed/tracked, with no other behavior change.
   */
  player1Id?: string,
  player2Id?: string,
): SurfaceEloResult {
  const p1 = computePlayerSurfaceElo(player1Matches, surface, player1OpponentElo, player1Id);
  const p2 = computePlayerSurfaceElo(player2Matches, surface, player2OpponentElo, player2Id);

  // Round each player's displayed Elo FIRST, then derive `eloDifference` (and therefore which
  // player it says is "favored") from those same rounded numbers -- never from the raw, unrounded
  // blended Elo independently. Rounding `p1.blendedElo` and `p2.blendedElo` separately before
  // subtracting can disagree in sign with rounding their raw difference directly whenever the true
  // gap is small (e.g. a raw gap of ~0.3-0.9 straddling a rounding boundary on one or both sides),
  // which previously let the "favors X" text name a different player than the two displayed Elo
  // numbers implied. Deriving from the rounded display values guarantees the two can never
  // disagree, by construction.
  const player1SurfaceElo = Math.round(p1.blendedElo);
  const player2SurfaceElo = Math.round(p2.blendedElo);
  const eloDifference = player1SurfaceElo - player2SurfaceElo;
  const rawEloWinProbabilityPlayer1 = 1 / (1 + Math.pow(10, -eloDifference / 400));

  // Weakest-link confidence -- a matchup is only as well-supported as its thinner side, matching
  // how `sampleSizePlayer1`/`sampleSizePlayer2` were already treated below.
  const reliability = Math.min(p1.confidence, p2.confidence);

  // Pull the win probability toward 50% in proportion to how uncertain the underlying rating gap
  // is -- the same rating gap backed by deep surface history should read as more decisive than
  // the same gap backed by a thin, mostly-overall-Elo-fallback sample.
  const eloWinProbabilityPlayer1 = 50 + (rawEloWinProbabilityPlayer1 * 100 - 50) * (reliability / 100);

  const warnings: string[] = [];
  const minSample = Math.min(p1.sampleSize, p2.sampleSize);
  if (minSample < MIN_SAMPLE_FOR_NO_WARNING) {
    warnings.push(`Only ${minSample} match(es) on this surface for one player -- surface Elo is low-confidence.`);
  }
  const maxBlendWeight = Math.max(p1.blendWeight, p2.blendWeight);
  if (maxBlendWeight > 0.3) {
    const blendedPlayer = p1.blendWeight >= p2.blendWeight ? "Player 1" : "Player 2";
    const pct = Math.round(maxBlendWeight * 100);
    warnings.push(`${blendedPlayer}'s surface history is shallow -- their surface Elo is blended ${pct}% toward their overall (cross-surface) Elo.`);
  }
  if (surface === "Hard") {
    // Task #123: indoor/outdoor hard-court status is now resolved for the large majority of
    // ATP/WTA tour-level tournaments (real per-tournament provider data plus a maintained
    // reference list of fixed-venue indoor events -- no longer just the ~26 majors/Masters/500s
    // this warning used to imply). This still only fires for a match that itself resolved to the
    // generic Hard pool rather than IndoorHard -- i.e. a real tournament that either isn't
    // classified as indoor by any source, or whose historical sample may include older matches
    // imported before this classification existed.
    warnings.push(
      "This match's surface resolved to the generic Hard-court pool (not specifically Indoor Hard) -- its historical sample may still blend indoor and outdoor results for tournaments outside known indoor coverage.",
    );
  }
  const minTourShare = Math.min(p1.tourLevelShare, p2.tourLevelShare);
  if (minTourShare < 0.25) {
    const lowPlayer = p1.tourLevelShare <= p2.tourLevelShare ? "Player 1" : "Player 2";
    const pct = Math.round(minTourShare * 100);
    warnings.push(`${lowPlayer}'s rating is backed mostly by sub-tour (Challenger/ITF) competition (only ${pct}% tour-level) -- their Elo is shrunk toward the corpus baseline to avoid overcrediting wins against weaker fields.`);
  }

  return {
    player1SurfaceElo,
    player2SurfaceElo,
    eloDifference,
    eloWinProbabilityPlayer1: asPercentage(Math.round(eloWinProbabilityPlayer1 * 10) / 10),
    rawEloWinProbabilityPlayer1: asPercentage(Math.round(rawEloWinProbabilityPlayer1 * 1000) / 10),
    reliability: asPercentage(Math.round(reliability)),
    sampleSizePlayer1: p1.sampleSize,
    sampleSizePlayer2: p2.sampleSize,
    effectiveSampleSizePlayer1: Math.round(p1.effectiveSampleSize * 10) / 10,
    effectiveSampleSizePlayer2: Math.round(p2.effectiveSampleSize * 10) / 10,
    player1OverallElo: Math.round(p1.overallElo),
    player2OverallElo: Math.round(p2.overallElo),
    player1SurfaceOnlyElo: Math.round(p1.surfaceOnlyElo),
    player2SurfaceOnlyElo: Math.round(p2.surfaceOnlyElo),
    player1BlendWeight: asFraction(Math.round(p1.blendWeight * 1000) / 1000),
    player2BlendWeight: asFraction(Math.round(p2.blendWeight * 1000) / 1000),
    player1TourLevelShare: asFraction(Math.round(p1.tourLevelShare * 1000) / 1000),
    player2TourLevelShare: asFraction(Math.round(p2.tourLevelShare * 1000) / 1000),
    defaulted: p1.sampleSize === 0 || p2.sampleSize === 0,
    warnings,
  };
}
