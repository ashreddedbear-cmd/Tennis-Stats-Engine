import type { MatchFormat } from "../tennisData/types";
import type { SurfaceEloResult } from "./surfaceElo";
import type { ServeReturnResult } from "./serveReturn";

/**
 * Phase 7: point-by-point Monte Carlo match simulator.
 *
 * No provider exposes point-level serve/return data (see serveReturn.ts's NOTE), so this module
 * derives a per-player service-point-win probability from the two signals that ARE real: the
 * surface-Elo win-probability edge and the serve/return dominance proxy. That derived probability
 * is the simulator's only input -- everything downstream (games, tiebreaks, sets, the match) is
 * simulated point-by-point using real tennis scoring rules, thousands of times per match, never a
 * closed-form shortcut. Uncertainty in the *input* probabilities (driven by how thin the
 * underlying data is) is deliberately propagated into the output range -- this is not simulation
 * noise dressed up as confidence, it's the actual measured reliability of the inputs.
 *
 * IMPORTANT: this narrow two-signal input scope (Surface Elo + Serve & Return only, never Recent
 * Form/Fatigue/Availability/Head-to-Head/the specialist blend) is exactly why this simulator's
 * `player1WinProbability` can disagree sharply -- even in the opposite direction -- with the
 * card's final ensemble probability on matches where those other signals dominate the ensemble's
 * vote. See `../evaluation/SIMULATOR_VS_ENSEMBLE_DISAGREEMENT.md` for a reproduced, concrete
 * investigation of this before treating a large disagreement as a bug.
 */

export interface ServicePointEstimate {
  player1ServicePointProbability: number; // 0-1, player1's chance of winning a point on their own serve
  player2ServicePointProbability: number;
  /** 0-100 -- how much to trust these point estimates; drives how widely they're jittered during sampling. */
  reliability: number;
  note: string;
}

const TOUR_AVERAGE_SERVE_POINT_WIN = 0.63; // roughly realistic professional-tour baseline

/**
 * Converts the engine's existing (real, non-fabricated) surface-Elo and serve/return-proxy
 * signals into a service-point-win probability for each player, centered on a realistic
 * tour-average baseline rather than an arbitrary midpoint. This is a derived heuristic -- not a
 * substitute for real point-level serve/return stats (tracked separately) -- and is documented as
 * such everywhere it surfaces.
 */
export function deriveServicePointEstimate(surfaceElo: SurfaceEloResult, serveReturn: ServeReturnResult): ServicePointEstimate {
  // Elo win-probability edge, converted to a point-level nudge: a 400-point Elo gap is roughly a
  // 90% match-win edge, which is a much bigger swing than the same gap should produce on a single
  // point, so it's heavily compressed (divided by 8) before being applied.
  const eloEdge = (surfaceElo.eloWinProbabilityPlayer1 / 100 - 0.5) / 8;

  // Serve/return ratings are 0-100, centered at 50; each 10-point gap nudges the point-win
  // probability by roughly 1.5 percentage points. Player1's serve strength works against
  // player2's return strength and vice versa.
  const p1ServeEdge = (serveReturn.player1ServeRating - serveReturn.player2ReturnRating) / 10 / 100 * 1.5;
  const p2ServeEdge = (serveReturn.player2ServeRating - serveReturn.player1ReturnRating) / 10 / 100 * 1.5;

  const player1ServicePointProbability = clamp(TOUR_AVERAGE_SERVE_POINT_WIN + eloEdge + p1ServeEdge, 0.45, 0.82);
  const player2ServicePointProbability = clamp(TOUR_AVERAGE_SERVE_POINT_WIN - eloEdge + p2ServeEdge, 0.45, 0.82);

  // The simulator can never be more reliable than the weaker of the two real signals it's built
  // from -- it inherits, never inflates, the underlying data quality.
  const reliability = Math.round(Math.min(surfaceElo.reliability, serveReturn.reliability));

  return {
    player1ServicePointProbability: Math.round(player1ServicePointProbability * 1000) / 1000,
    player2ServicePointProbability: Math.round(player2ServicePointProbability * 1000) / 1000,
    reliability,
    note:
      "Point-level serve/return data is not available from any connected provider; these service-point probabilities are derived from real surface-Elo and game-margin serve/return signals, not fabricated or point-tracked.",
  };
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Derives a deterministic seed from stable match identity (player ids, surface, format) so that
 * predicting the exact same match multiple times reproduces the same simulated outcome instead
 * of drifting between calls on unseeded Math.random(). Player ids are sorted before hashing so
 * the seed is order-independent -- it agrees with the ledger's own duplicate-match identity
 * (see ledgerDuplicates.ts), which also treats the two players as an unordered pair.
 */
export function deriveMatchSeed(player1Id: string, player2Id: string, surface: string, matchFormat: string): number {
  const key = `${[player1Id, player2Id].sort().join("|")}::${surface}::${matchFormat}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return hash;
}

// --- Point-by-point scoring primitives ---

/** Simulates one game, returning true if the server wins it. Standard deuce/advantage scoring. */
function simulateGame(serverPointProb: number, rng: () => number): boolean {
  let serverPoints = 0;
  let receiverPoints = 0;
  for (;;) {
    if (rng() < serverPointProb) serverPoints++;
    else receiverPoints++;

    const leader = serverPoints - receiverPoints;
    if (serverPoints >= 4 && leader >= 2) return true;
    if (receiverPoints >= 4 && leader <= -2) return false;
  }
}

/** Simulates a 7-point (win-by-2) tiebreak. Returns true if player1 wins it. Serve alternates 1-2-2-2... but that only affects who serves, not the fixed per-point probabilities used here, so it's modeled as a fair alternating-serve sequence of point probabilities. */
function simulateTiebreak(player1PointProb: number, player2PointProb: number, rng: () => number): boolean {
  let p1 = 0;
  let p2 = 0;
  let pointIndex = 0;
  // Server order: p1 serves point 0, then p2 serves points 1-2, p1 serves 3-4, etc.
  for (;;) {
    const p1Serving = pointIndex === 0 ? true : Math.floor((pointIndex - 1) / 2) % 2 === 0 ? false : true;
    const serveProb = p1Serving ? player1PointProb : 1 - player2PointProb;
    if (rng() < serveProb) p1++;
    else p2++;

    const leader = p1 - p2;
    if (p1 >= 7 && leader >= 2) return true;
    if (p2 >= 7 && leader <= -2) return false;
    pointIndex++;
  }
}

/**
 * Simulates one set (games to 6, win by 2, 7-point tiebreak at 6-6). Server alternates every
 * game, starting with `player1Serves`. Returns the game score and the set winner.
 */
function simulateSet(
  player1PointProb: number,
  player2PointProb: number,
  player1ServesFirst: boolean,
  rng: () => number,
): { player1Games: number; player2Games: number; player1WonSet: boolean } {
  let p1Games = 0;
  let p2Games = 0;
  let player1Serves = player1ServesFirst;

  for (;;) {
    if (p1Games === 6 && p2Games === 6) {
      const p1WonTb = simulateTiebreak(player1PointProb, player2PointProb, rng);
      if (p1WonTb) p1Games++;
      else p2Games++;
      return { player1Games: p1Games, player2Games: p2Games, player1WonSet: p1WonTb };
    }

    // simulateGame's parameter is "probability the SERVER wins the point" -- each player's own
    // service-point probability applies directly, regardless of who is serving (unlike the
    // tiebreak tally below, which needs "probability player1 wins the point" instead).
    const serverProb = player1Serves ? player1PointProb : player2PointProb;
    const serverWonGame = simulateGame(serverProb, rng);
    if (player1Serves === serverWonGame) p1Games++;
    else p2Games++;

    const leader = p1Games - p2Games;
    if (p1Games >= 6 && leader >= 2) return { player1Games: p1Games, player2Games: p2Games, player1WonSet: true };
    if (p2Games >= 6 && leader <= -2) return { player1Games: p1Games, player2Games: p2Games, player1WonSet: false };

    player1Serves = !player1Serves;
  }
}

export interface SingleMatchSimulation {
  player1WonMatch: boolean;
  setsWonPlayer1: number;
  setsWonPlayer2: number;
  setScores: Array<{ player1Games: number; player2Games: number }>;
}

/** Simulates one full best-of-3 or best-of-5 match, point by point, set by set. */
export function simulateMatch(player1PointProb: number, player2PointProb: number, matchFormat: MatchFormat, rng: () => number): SingleMatchSimulation {
  const setsToWin = matchFormat === "BestOf5" ? 3 : 2;
  let setsWonPlayer1 = 0;
  let setsWonPlayer2 = 0;
  let player1ServesFirst = true;
  const setScores: Array<{ player1Games: number; player2Games: number }> = [];

  while (setsWonPlayer1 < setsToWin && setsWonPlayer2 < setsToWin) {
    const set = simulateSet(player1PointProb, player2PointProb, player1ServesFirst, rng);
    setScores.push({ player1Games: set.player1Games, player2Games: set.player2Games });
    if (set.player1WonSet) setsWonPlayer1++;
    else setsWonPlayer2++;
    // Whoever served first in a set receives first in the next -- a real (if minor) rule; total
    // games played in the set determines whether the serve order flips.
    const totalGames = set.player1Games + set.player2Games;
    if (totalGames % 2 === 1) player1ServesFirst = !player1ServesFirst;
  }

  return { player1WonMatch: setsWonPlayer1 > setsWonPlayer2, setsWonPlayer1, setsWonPlayer2, setScores };
}

// --- Simple, seedable-enough PRNG so tests can be deterministic without relying on Math.random --

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MatchSimulationResult {
  /** Point-estimate probability (0-100) that player1 wins the match, from the point-by-point simulation. */
  player1WinProbability: number;
  /** Lower/upper bound of a genuine uncertainty range, driven by jittering the input service-point probabilities within their own measured reliability -- not simulation noise. */
  rangeLow: number;
  rangeHigh: number;
  straightSetsProbabilityPlayer1: number;
  straightSetsProbabilityPlayer2: number;
  /** Probability distribution over set scores in player1's favor, e.g. "2-0", "2-1", descending by probability. */
  setScoreDistribution: Array<{ score: string; probability: number; favors: "player1" | "player2" }>;
  expectedGamesPlayer1: number;
  expectedGamesPlayer2: number;
  player1ServicePointProbability: number;
  player2ServicePointProbability: number;
  inputReliability: number;
  simulationsRun: number;
  note: string;
}

export interface RunSimulationOptions {
  /** Number of outer parameter-uncertainty draws. Each draw re-simulates `innerSimulationsPerDraw` matches. */
  outerDraws?: number;
  innerSimulationsPerDraw?: number;
  /** Deterministic seed for tests; omit in production for real randomness. */
  seed?: number;
}

/**
 * Runs the full uncertainty-aware Monte Carlo simulation: `outerDraws` independent draws of
 * jittered service-point probabilities (the jitter width shrinks as `estimate.reliability`
 * grows), each simulated `innerSimulationsPerDraw` times. The point estimate is the mean win rate
 * across all simulations; the range is the 10th/90th percentile of the per-draw win rates -- a
 * genuine reflection of input uncertainty, never a single falsely-precise number.
 */
export function runMatchSimulation(estimate: ServicePointEstimate, matchFormat: MatchFormat, options: RunSimulationOptions = {}): MatchSimulationResult {
  const outerDraws = options.outerDraws ?? 200;
  const innerSimulationsPerDraw = options.innerSimulationsPerDraw ?? 100;
  const rng = options.seed !== undefined ? mulberry32(options.seed) : Math.random;

  // Reliability 0-100 maps to a jitter standard deviation from 0.06 (very unreliable -> wide
  // spread of plausible inputs) down to 0.015 (highly reliable -> narrow spread).
  const jitterStdDev = 0.06 - (Math.max(0, Math.min(100, estimate.reliability)) / 100) * 0.045;

  const drawWinRates: number[] = [];
  const setScoreCounts = new Map<string, number>();
  let totalGamesPlayer1 = 0;
  let totalGamesPlayer2 = 0;
  let straightSetsPlayer1 = 0;
  let straightSetsPlayer2 = 0;
  let totalSims = 0;

  for (let draw = 0; draw < outerDraws; draw++) {
    const p1 = clamp(estimate.player1ServicePointProbability + gaussian(rng, jitterStdDev), 0.3, 0.92);
    const p2 = clamp(estimate.player2ServicePointProbability + gaussian(rng, jitterStdDev), 0.3, 0.92);

    let winsThisDraw = 0;
    for (let i = 0; i < innerSimulationsPerDraw; i++) {
      const result = simulateMatch(p1, p2, matchFormat, rng);
      totalSims++;
      if (result.player1WonMatch) winsThisDraw++;

      totalGamesPlayer1 += result.setScores.reduce((s, set) => s + set.player1Games, 0);
      totalGamesPlayer2 += result.setScores.reduce((s, set) => s + set.player2Games, 0);

      const setsToWin = matchFormat === "BestOf5" ? 3 : 2;
      const loserSets = result.player1WonMatch ? result.setsWonPlayer2 : result.setsWonPlayer1;
      if (loserSets === 0) {
        if (result.player1WonMatch) straightSetsPlayer1++;
        else straightSetsPlayer2++;
      }

      const scoreKey = result.player1WonMatch ? `${result.setsWonPlayer1}-${result.setsWonPlayer2}` : `${result.setsWonPlayer2}-${result.setsWonPlayer1}`;
      const favorsKey = `${scoreKey}|${result.player1WonMatch ? "player1" : "player2"}`;
      setScoreCounts.set(favorsKey, (setScoreCounts.get(favorsKey) ?? 0) + 1);
      void setsToWin;
    }
    drawWinRates.push(winsThisDraw / innerSimulationsPerDraw);
  }

  drawWinRates.sort((a, b) => a - b);
  const percentile = (p: number) => drawWinRates[Math.min(drawWinRates.length - 1, Math.max(0, Math.round(p * (drawWinRates.length - 1))))];

  const meanWinRate = drawWinRates.reduce((s, w) => s + w, 0) / drawWinRates.length;

  // Cap before rounding: service-point inputs near their clamp bounds can drive meanWinRate to
  // ≥0.9995, which Math.round(x * 1000) / 10 rounds to exactly 100.0. That's a rounding
  // artefact, not a real certainty — cap to [0.001, 0.999] so the display never shows 100%/0%.
  const safeRate = (r: number) => Math.max(0.001, Math.min(0.999, r));

  const setScoreDistribution = Array.from(setScoreCounts.entries())
    .map(([key, count]) => {
      const [score, favors] = key.split("|") as [string, "player1" | "player2"];
      return { score, favors, probability: Math.round((count / totalSims) * 1000) / 10 };
    })
    .sort((a, b) => b.probability - a.probability);

  return {
    player1WinProbability: Math.round(safeRate(meanWinRate) * 1000) / 10,
    rangeLow: Math.round(safeRate(percentile(0.1)) * 1000) / 10,
    rangeHigh: Math.round(safeRate(percentile(0.9)) * 1000) / 10,
    // straightSets can hit 100 % in simulated dominant matchups — apply same safe cap.
    straightSetsProbabilityPlayer1: Math.round(safeRate(straightSetsPlayer1 / totalSims) * 1000) / 10,
    straightSetsProbabilityPlayer2: Math.round(safeRate(straightSetsPlayer2 / totalSims) * 1000) / 10,
    setScoreDistribution,
    expectedGamesPlayer1: Math.round((totalGamesPlayer1 / totalSims) * 10) / 10,
    expectedGamesPlayer2: Math.round((totalGamesPlayer2 / totalSims) * 10) / 10,
    player1ServicePointProbability: estimate.player1ServicePointProbability,
    player2ServicePointProbability: estimate.player2ServicePointProbability,
    inputReliability: estimate.reliability,
    simulationsRun: totalSims,
    note: estimate.note,
  };
}

/** Box-Muller transform for a zero-mean Gaussian jitter with the given standard deviation. */
function gaussian(rng: () => number, stdDev: number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * stdDev;
}
