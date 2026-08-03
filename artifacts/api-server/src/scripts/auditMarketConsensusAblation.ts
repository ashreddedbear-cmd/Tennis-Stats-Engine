/**
 * Market Consensus ablation analysis — Task #21.
 *
 * WHY A DEDICATED SCRIPT (NOT THE STANDARD ablation.ts FRAMEWORK):
 * The standard ablation runner (services/evaluation/ablation.ts) works exclusively on the
 * historical match corpus and never passes `input.marketOdds` to `scoreMatch()`. Because the
 * Market Consensus module ONLY fires when `input.marketOdds != null`, the "ablate_marketOdds"
 * leave-one-out variant in the standard runner is always identical to baseline — the module was
 * never active in the first place. A standard run would produce a meaningless delta of exactly
 * 0.0pp and tell us nothing about whether the module earns its place.
 *
 * The correct data source is `evaluation_predictions` paper_trade rows where real market odds
 * were locked at cutoff time (odds_player1_decimal IS NOT NULL). For each such row we can:
 *   (A) Read the stored calibrated_probability — this IS the "with market odds" prediction,
 *       because the engine was run with the real odds when the row was locked.
 *   (B) Re-run the same prediction WITHOUT market odds by replaying the historical feature
 *       inputs through the engine with excludedModels = {"marketOdds"}.
 * Comparing (A) vs (B) gives a clean, apples-to-apples view of exactly what the module does to
 * accuracy and log-loss — on real, independently graded outcomes.
 *
 * SECTION C — Historical Market Odds (tennis-data.co.uk):
 * The walk-forward scores historical rows WITHOUT market odds, so the stored
 * calibratedProbability is the "no-odds" baseline. Re-running WITH the bookmaker odds embedded
 * in raw_source._marketOdds gives a counterfactual with a much larger sample (up to 11k rows
 * from the 2016–2020 backfill). This is corroborating evidence — Section B (live odds at real
 * prediction time) remains the primary criterion for the KEEP/EXCLUDE decision.
 *
 * ADDITIONAL ANALYSIS — market direction alignment:
 * Even on rows where we can't re-run the engine (e.g. player IDs not in the historical corpus),
 * we can still ask: "when the market's implied probability agreed with the model's pick, did that
 * increase accuracy? When it disagreed, was the model actually wrong?" This doesn't require
 * re-running the engine and uses purely stored columns.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/auditMarketConsensusAblation.ts
 */

import { db, evaluationPredictionsTable, historicalMatchesTable, calibrationModelsTable, specialistModelsTable, pool } from "@workspace/db";
import { and, isNotNull, eq, asc, sql } from "drizzle-orm";
import { runPredictionEngine } from "../services/predictionEngine";
import { buildMatchHistoryIndex, reconstructPlayerMatchHistory, reconstructHeadToHead } from "../services/historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex, resolveOpponentStrengthFromIndex } from "../services/predictionEngine/opponentStrength";
import { resolveSegment } from "../services/predictionEngine/segments";
import type { AblationModelKey, SegmentSpecialistInput } from "../services/predictionEngine/types";
import type { CalibrationKnot } from "../services/evaluation/types";
import {
  splitForCalibrationHoldout,
  fitIsotonicCalibrationBinned,
  applyCalibration,
  logLoss as calibrationLogLoss,
  brierScore as calibrationBrierScore,
  type CalibrationPoint,
} from "../services/evaluation/calibration.js";
import type { Surface, MatchFormat } from "../services/tennisData/types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GradedOddsRow {
  id: number;
  runKind: string;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  surface: string | null;
  matchFormat: string | null;
  tournamentName: string | null;
  tournamentLevel: string | null;
  cutoffAt: Date;
  scheduledStartAt: Date;
  rawProbability: number | null;
  calibratedProbability: number | null;
  predictedWinnerId: string | null;
  actualWinnerId: string | null;
  includedInAccuracy: boolean | null;
  oddsPlayer1Decimal: number | null;
  oddsPlayer2Decimal: number | null;
  impliedProbability: number | null;
  marketEdge: number | null;
}

interface PairResult {
  rowId: number;
  actualWinnerId: string;
  predictedWinnerId: string;    // with market odds
  noOddsPredictedWinnerId: string; // without market odds
  withOddsProb: number;         // calibrated probability for player1, with odds
  noOddsProb: number;           // calibrated probability for player1, without odds
  correctWithOdds: boolean;
  correctWithoutOdds: boolean;
  player1Id: string;
  tour: string | null;
  surface: string | null;
}

interface HistoricalOddsCandidate {
  evalId: number;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  surface: string | null;
  matchFormat: string | null;
  tournamentName: string | null;
  cutoffAt: Date;
  calibratedProbability: number | null;
  predictedWinnerId: string | null;
  actualWinnerId: string | null;
  rawSource: unknown;
}

// ─── Log-loss helpers ─────────────────────────────────────────────────────────

function logLoss(prob: number, correct: boolean): number {
  const p = Math.min(Math.max(prob / 100, 1e-6), 1 - 1e-6);
  return correct ? -Math.log(p) : -Math.log(1 - p);
}

function accuracy(rows: { correct: boolean }[]): number | null {
  if (rows.length === 0) return null;
  return Math.round((rows.filter((r) => r.correct).length / rows.length) * 1000) / 10;
}

function avgLogLoss(rows: { logLoss: number }[]): number | null {
  if (rows.length === 0) return null;
  return Math.round((rows.reduce((s, r) => s + r.logLoss, 0) / rows.length) * 10000) / 10000;
}

function pct(n: number, total: number): string {
  if (total === 0) return "n/a";
  return `${Math.round((n / total) * 1000) / 10}%`;
}

// ─── Shared ablation helpers ──────────────────────────────────────────────────

/**
 * Run a single ablation pair (with / without market odds) and return a PairResult.
 *
 * mode="paperTrade":  stored calibratedProbability = "with odds" (engine saw live odds at lock).
 *                     Re-run WITHOUT odds = counterfactual.
 * mode="historical":  stored calibratedProbability = "without odds" (walk-forward never passes odds).
 *                     Re-run WITH avgWinner/avgLoser = counterfactual.
 */
function runAblationPair(
  rowId: number,
  player1Id: string,
  player1Name: string,
  player2Id: string,
  player2Name: string,
  surface: string,
  matchFormat: string,
  tournamentName: string | null,
  cutoffAt: Date,
  actualWinnerId: string,
  p1DecimalOdds: number,
  p2DecimalOdds: number,
  matchHistory: ReturnType<typeof buildMatchHistoryIndex>,
  eloHistory: Awaited<ReturnType<typeof buildEloHistoryIndex>>,
  activeCalibration: CalibrationKnot[] | null,
  segmentByKey: Map<string, SegmentSpecialistInput>,
  mode: "paperTrade" | "historical",
  storedPredictedWinnerId: string,
  storedCalibratedProbability: number,
): PairResult | null {
  const EXCLUDED_MARKET: ReadonlySet<AblationModelKey> = new Set(["marketOdds"]);

  const p1Matches = reconstructPlayerMatchHistory(matchHistory, player1Id, cutoffAt);
  const p2Matches = reconstructPlayerMatchHistory(matchHistory, player2Id, cutoffAt);
  if (p1Matches.length === 0 || p2Matches.length === 0) return null;

  const p1Strength = resolveOpponentStrengthFromIndex(p1Matches, eloHistory);
  const p2Strength = resolveOpponentStrengthFromIndex(p2Matches, eloHistory);
  const headToHead = reconstructHeadToHead(matchHistory, player1Id, player2Id, cutoffAt);

  const tour = (() => {
    const levels = p1Matches.map((m) => m.tournamentLevel).filter(Boolean) as string[];
    if (levels.some((l) => l.startsWith("ATP") || l === "GrandSlam" || l === "Masters1000")) return "ATP";
    if (levels.some((l) => l.startsWith("WTA"))) return "WTA";
    return null;
  })();

  const segmentDef = resolveSegment(tour, surface as Surface);
  const segment = segmentDef ? (segmentByKey.get(segmentDef.segmentKey) ?? null) : null;

  const playerProfile = (id: string, name: string) => ({
    id, name, countryCode: null, currentRank: null, tour: null, age: null, plays: null, fullName: null,
  });

  const commonInput = {
    player1: playerProfile(player1Id, player1Name),
    player2: playerProfile(player2Id, player2Name),
    player1Matches: p1Matches,
    player2Matches: p2Matches,
    headToHead,
    surface: surface as Surface,
    matchFormat: matchFormat as MatchFormat,
    player1OpponentElo: p1Strength.lookup,
    player2OpponentElo: p2Strength.lookup,
    tournamentName,
    weather: null,
    segment,
    simulatorAdoption: null,
    activeCalibration,
    asOfDate: cutoffAt,
  };

  try {
    if (mode === "paperTrade") {
      // Stored = "with odds" (engine saw real odds at lock). Re-run WITHOUT gives counterfactual.
      const noOddsOutput = runPredictionEngine({ ...commonInput, excludedModels: EXCLUDED_MARKET });
      return {
        rowId,
        actualWinnerId,
        predictedWinnerId: storedPredictedWinnerId,
        noOddsPredictedWinnerId: noOddsOutput.predictedWinnerId,
        withOddsProb: storedCalibratedProbability,
        noOddsProb: noOddsOutput.calibratedProbability,
        correctWithOdds: storedPredictedWinnerId === actualWinnerId,
        correctWithoutOdds: noOddsOutput.predictedWinnerId === actualWinnerId,
        player1Id, tour, surface,
      };
    } else {
      // Stored = "without odds" (walk-forward never passes odds). Re-run WITH odds = counterfactual.
      const withOddsOutput = runPredictionEngine({
        ...commonInput,
        marketOdds: {
          provider: "replay",
          player1DecimalOdds: p1DecimalOdds,
          player2DecimalOdds: p2DecimalOdds,
          fetchedAt: cutoffAt.toISOString(),
        },
        excludedModels: new Set(), // ablation mode: bypass EXCLUDED_FROM_ENSEMBLE gate
      });
      return {
        rowId,
        actualWinnerId,
        predictedWinnerId: withOddsOutput.predictedWinnerId,
        noOddsPredictedWinnerId: storedPredictedWinnerId,
        withOddsProb: withOddsOutput.calibratedProbability,
        noOddsProb: storedCalibratedProbability,
        correctWithOdds: withOddsOutput.predictedWinnerId === actualWinnerId,
        correctWithoutOdds: storedPredictedWinnerId === actualWinnerId,
        player1Id, tour, surface,
      };
    }
  } catch {
    return null;
  }
}

/** Print the standard ablation results table and KEEP/EXCLUDE recommendation. */
function printAblationResults(pairs: PairResult[], label: string, requireN: number): void {
  if (pairs.length === 0) { console.log("  No pairs to report."); return; }

  const withOddsAccuracy = accuracy(pairs.map((p) => ({ correct: p.correctWithOdds })));
  const noOddsAccuracy   = accuracy(pairs.map((p) => ({ correct: p.correctWithoutOdds })));
  const withOddsLL = avgLogLoss(pairs.map((p) => ({ logLoss: logLoss(p.withOddsProb,  p.actualWinnerId === p.player1Id) })));
  const noOddsLL   = avgLogLoss(pairs.map((p) => ({ logLoss: logLoss(p.noOddsProb,    p.actualWinnerId === p.player1Id) })));

  console.log(`\n  ┌──────────────────────────────────────────────────────────────────┐`);
  console.log(`  │  ${label.padEnd(66)}│`);
  console.log(`  ├──────────────────────┬────────────┬───────────────────────────────┤`);
  console.log(`  │ Variant              │ Accuracy   │ Avg Log-Loss                  │`);
  console.log(`  ├──────────────────────┼────────────┼───────────────────────────────┤`);
  console.log(`  │ With market odds      │ ${String(withOddsAccuracy ?? "n/a").padEnd(10)} │ ${String(withOddsLL ?? "n/a").padEnd(29)} │`);
  console.log(`  │ Without market odds   │ ${String(noOddsAccuracy ?? "n/a").padEnd(10)} │ ${String(noOddsLL ?? "n/a").padEnd(29)} │`);
  console.log(`  └──────────────────────┴────────────┴───────────────────────────────┘`);

  const deltaAcc = withOddsAccuracy !== null && noOddsAccuracy !== null
    ? Math.round((withOddsAccuracy - noOddsAccuracy) * 10) / 10 : null;
  const deltaLL  = withOddsLL !== null && noOddsLL !== null
    ? Math.round((withOddsLL - noOddsLL) * 10000) / 10000 : null;

  console.log(`\n  Δ accuracy  (with − without): ${deltaAcc !== null ? `${deltaAcc > 0 ? "+" : ""}${deltaAcc}pp` : "n/a"}`);
  console.log(`  Δ log-loss  (with − without): ${deltaLL !== null ? `${deltaLL > 0 ? "+" : ""}${deltaLL}` : "n/a"}  (negative = with-odds is BETTER)`);

  const flipped = pairs.filter((p) => p.predictedWinnerId !== p.noOddsPredictedWinnerId);
  console.log(`\n  Pairs where market odds flipped the pick: ${flipped.length}/${pairs.length} (${pct(flipped.length, pairs.length)})`);
  if (flipped.length > 0) {
    const fc = flipped.filter((p) => p.correctWithOdds).length;
    const fn = flipped.filter((p) => p.correctWithoutOdds).length;
    console.log(`    On flip-pairs: with-odds correct=${pct(fc, flipped.length)}, without-odds correct=${pct(fn, flipped.length)}`);
  }

  const tours = [...new Set(pairs.map((p) => p.tour ?? "Unknown"))];
  if (tours.length > 1) {
    console.log("\n  Per-tour breakdown:");
    for (const t of tours) {
      const sub = pairs.filter((p) => (p.tour ?? "Unknown") === t);
      const wA = accuracy(sub.map((p) => ({ correct: p.correctWithOdds })));
      const nA = accuracy(sub.map((p) => ({ correct: p.correctWithoutOdds })));
      const d  = wA !== null && nA !== null ? Math.round((wA - nA) * 10) / 10 : null;
      console.log(`    ${String(t).padEnd(12)} n=${String(sub.length).padEnd(5)} with=${wA ?? "n/a"} without=${nA ?? "n/a"} delta=${d !== null ? `${d > 0 ? "+" : ""}${d}pp` : "n/a"}`);
    }
  }

  const surfaces = [...new Set(pairs.map((p) => p.surface ?? "Unknown"))];
  if (surfaces.length > 1) {
    console.log("\n  Per-surface breakdown:");
    for (const s of surfaces) {
      const sub = pairs.filter((p) => (p.surface ?? "Unknown") === s);
      const wA = accuracy(sub.map((p) => ({ correct: p.correctWithOdds })));
      const nA = accuracy(sub.map((p) => ({ correct: p.correctWithoutOdds })));
      const d  = wA !== null && nA !== null ? Math.round((wA - nA) * 10) / 10 : null;
      console.log(`    ${String(s).padEnd(12)} n=${String(sub.length).padEnd(5)} with=${wA ?? "n/a"} without=${nA ?? "n/a"} delta=${d !== null ? `${d > 0 ? "+" : ""}${d}pp` : "n/a"}`);
    }
  }

  console.log("\n  ─── RECOMMENDATION ───");
  if (pairs.length < requireN) {
    console.log(`  ✗  EXCLUDE (n=${pairs.length} < ${requireN} required): sample too small to confirm net positive.`);
    if (deltaAcc !== null) {
      console.log(`     Directional signal: Δacc=${deltaAcc > 0 ? "+" : ""}${deltaAcc}pp, Δlog-loss=${deltaLL !== null ? (deltaLL < 0 ? "" : "+") + deltaLL : "n/a"}`);
    }
  } else if (deltaAcc !== null && deltaAcc >= 0.5) {
    console.log(`  ✓  KEEP: market module improves accuracy by +${deltaAcc}pp (n=${pairs.length}). Net positive confirmed.`);
    console.log("     Remove 'marketOdds' from EXCLUDED_FROM_ENSEMBLE in dataQuality.ts.");
  } else if (deltaAcc !== null && deltaAcc <= -0.5) {
    console.log(`  ✗  EXCLUDE: market module hurts accuracy by ${deltaAcc}pp (n=${pairs.length}). Remains in EXCLUDED_FROM_ENSEMBLE.`);
  } else {
    console.log(`  ~  NEUTRAL: delta=${deltaAcc ?? "n/a"}pp (n=${pairs.length}). Too small to confirm net positive.`);
    console.log("     Per the task spec, neutral/ambiguous results keep the module in EXCLUDED_FROM_ENSEMBLE.");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Market Consensus Module Ablation (Task #21) ===\n");

  // ── 1. Load graded paper_trade rows with market odds ──────────────────────
  // Restrict to paper_trade rows ONLY for Section A + B. Market odds are locked at real
  // prediction time for paper_trade rows — the engine saw real live odds before the match
  // started, so these are the only rows where "with market odds" vs "without market odds"
  // reflects a genuine real-world counterfactual. historical_test rows never have stored odds;
  // paper_trade_shadow rows use a simulated lock window and are explicitly excluded.
  console.log("Loading graded paper_trade rows with market odds...");
  const rawRows = await db
    .select({
      id: evaluationPredictionsTable.id,
      runKind: evaluationPredictionsTable.runKind,
      player1Id: evaluationPredictionsTable.player1Id,
      player1Name: evaluationPredictionsTable.player1Name,
      player2Id: evaluationPredictionsTable.player2Id,
      player2Name: evaluationPredictionsTable.player2Name,
      surface: evaluationPredictionsTable.surface,
      matchFormat: evaluationPredictionsTable.matchFormat,
      tournamentName: evaluationPredictionsTable.tournamentName,
      tournamentLevel: evaluationPredictionsTable.tournamentLevel,
      cutoffAt: evaluationPredictionsTable.cutoffAt,
      scheduledStartAt: evaluationPredictionsTable.scheduledStartAt,
      rawProbability: evaluationPredictionsTable.rawProbability,
      calibratedProbability: evaluationPredictionsTable.calibratedProbability,
      predictedWinnerId: evaluationPredictionsTable.predictedWinnerId,
      actualWinnerId: evaluationPredictionsTable.actualWinnerId,
      includedInAccuracy: evaluationPredictionsTable.includedInAccuracy,
      oddsPlayer1Decimal: evaluationPredictionsTable.oddsPlayer1Decimal,
      oddsPlayer2Decimal: evaluationPredictionsTable.oddsPlayer2Decimal,
      impliedProbability: evaluationPredictionsTable.impliedProbability,
      marketEdge: evaluationPredictionsTable.marketEdge,
    })
    .from(evaluationPredictionsTable)
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "paper_trade"),
        eq(evaluationPredictionsTable.status, "graded"),
        isNotNull(evaluationPredictionsTable.oddsPlayer1Decimal),
        isNotNull(evaluationPredictionsTable.actualWinnerId),
      ),
    );

  const oddsRows: GradedOddsRow[] = rawRows as GradedOddsRow[];
  console.log(`  Total graded rows with market odds: ${oddsRows.length}`);

  const accuracyEligible = oddsRows.filter((r) => r.includedInAccuracy === true);
  console.log(`  Accuracy-eligible subset: ${accuracyEligible.length}`);

  // ── 2. Load historical tennis-data.co.uk rows with embedded bookmaker odds ─
  // (Queried early so we know the combined candidate pool before building context.)
  console.log("\nLoading historical_test rows joined with tennis-data.co.uk market odds...");
  const historicalOddsRaw = await db
    .select({
      evalId: evaluationPredictionsTable.id,
      player1Id: evaluationPredictionsTable.player1Id,
      player1Name: evaluationPredictionsTable.player1Name,
      player2Id: evaluationPredictionsTable.player2Id,
      player2Name: evaluationPredictionsTable.player2Name,
      surface: evaluationPredictionsTable.surface,
      matchFormat: evaluationPredictionsTable.matchFormat,
      tournamentName: evaluationPredictionsTable.tournamentName,
      cutoffAt: evaluationPredictionsTable.cutoffAt,
      calibratedProbability: evaluationPredictionsTable.calibratedProbability,
      predictedWinnerId: evaluationPredictionsTable.predictedWinnerId,
      actualWinnerId: evaluationPredictionsTable.actualWinnerId,
      rawSource: historicalMatchesTable.rawSource,
    })
    .from(evaluationPredictionsTable)
    .innerJoin(
      historicalMatchesTable,
      eq(evaluationPredictionsTable.historicalMatchId, historicalMatchesTable.id),
    )
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        eq(evaluationPredictionsTable.status, "graded"),
        eq(evaluationPredictionsTable.includedInAccuracy, true),
        isNotNull(evaluationPredictionsTable.calibratedProbability),
        isNotNull(evaluationPredictionsTable.predictedWinnerId),
        isNotNull(evaluationPredictionsTable.actualWinnerId),
        eq(historicalMatchesTable.provider, "tennis-data-co-uk"),
        sql`(${historicalMatchesTable.rawSource}->'_marketOdds'->>'avgWinner')::float > 1`,
        sql`(${historicalMatchesTable.rawSource}->'_marketOdds'->>'avgLoser')::float > 1`,
      ),
    );

  const historicalOddsCandidates = historicalOddsRaw as unknown as HistoricalOddsCandidate[];
  console.log(`  Historical rows (graded, accuracy-eligible, has avgWinner+avgLoser): ${historicalOddsCandidates.length}`);
  if (historicalOddsCandidates.length === 0) {
    console.log("  → No historical tennis-data.co.uk rows have been scored yet.");
    console.log("    Trigger POST /evaluation/walk-forward/score-unscored (admin) then re-run this script.");
  }

  // ─── SECTION A: Market Direction Analysis (no engine re-run needed) ────────

  console.log("\n--- SECTION A: Market Direction vs. Model Agreement ---");
  console.log("(Uses stored implied_probability and calibrated_probability only)\n");

  const withBothProbs = accuracyEligible.filter(
    (r) =>
      r.calibratedProbability !== null &&
      r.predictedWinnerId !== null &&
      r.impliedProbability !== null &&
      r.oddsPlayer1Decimal !== null &&
      r.oddsPlayer2Decimal !== null,
  );

  console.log(`Rows with all required columns: ${withBothProbs.length}`);

  if (withBothProbs.length > 0) {
    // "Market agrees with model" = market's implied winner is the same as model's predicted winner
    const marketAgreesRows    = withBothProbs.filter((r) => { const mFP1 = r.impliedProbability! >= 50; const mFavP1 = r.predictedWinnerId === r.player1Id; return mFP1 === mFavP1; });
    const marketDisagreesRows = withBothProbs.filter((r) => { const mFP1 = r.impliedProbability! >= 50; const mFavP1 = r.predictedWinnerId === r.player1Id; return mFP1 !== mFavP1; });

    const agreesCorrect    = marketAgreesRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;
    const disagreesCorrect = marketDisagreesRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;

    console.log(`Market AGREES with model:    n=${marketAgreesRows.length}, model accuracy=${pct(agreesCorrect, marketAgreesRows.length)}`);
    console.log(`Market DISAGREES with model: n=${marketDisagreesRows.length}, model accuracy=${pct(disagreesCorrect, marketDisagreesRows.length)}`);

    if (marketDisagreesRows.length > 0) {
      const marketRightWhenDisagrees = marketDisagreesRows.filter((r) => r.predictedWinnerId !== r.actualWinnerId).length;
      console.log(`  → When market disagrees: market was correct ${pct(marketRightWhenDisagrees, marketDisagreesRows.length)} of the time`);
      console.log(`    (Model was correct ${pct(disagreesCorrect, marketDisagreesRows.length)} — if market > model here, it adds value)`);
    }

    const withEdge = withBothProbs.filter((r) => r.marketEdge !== null);
    if (withEdge.length > 0) {
      const positiveEdgeRows = withEdge.filter((r) => r.marketEdge! > 0);
      const negativeEdgeRows = withEdge.filter((r) => r.marketEdge! <= 0);
      const posCorrect = positiveEdgeRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;
      const negCorrect = negativeEdgeRows.filter((r) => r.predictedWinnerId === r.actualWinnerId).length;

      console.log(`\nMarket EDGE analysis (n=${withEdge.length}):`);
      console.log(`  Positive edge (model sees value vs market): n=${positiveEdgeRows.length}, accuracy=${pct(posCorrect, positiveEdgeRows.length)}`);
      console.log(`  Negative edge (market MORE confident than model): n=${negativeEdgeRows.length}, accuracy=${pct(negCorrect, negativeEdgeRows.length)}`);
    }
  }

  // ─── Shared context — built once, used by Section B and Section C ─────────

  const reRunCandidates = accuracyEligible.filter(
    (r) =>
      r.surface !== null &&
      r.matchFormat !== null &&
      r.predictedWinnerId !== null &&
      r.calibratedProbability !== null &&
      r.oddsPlayer1Decimal !== null &&
      r.oddsPlayer2Decimal !== null,
  );

  const needsContext = reRunCandidates.length > 0 || historicalOddsCandidates.length > 0;

  // ─── SECTION B-CAL: Calibration Curve Refit Diagnostic ────────────────────
  //
  // Runs EARLY — uses only stored DB columns (rawProbability, calibratedProbability).
  // No engine re-run or history index required. Fast regardless of corpus size.
  //
  // WHY: Section B found market odds +1.6pp accuracy but +0.0243 worse log-loss.
  // The global calibration curve was fit on historical_test rows where market odds
  // was NEVER active (it's in EXCLUDED_FROM_ENSEMBLE). When market odds is turned on,
  // the raw ensemble probability shifts into a region the global curve has never seen.
  // This section tests whether that distribution mismatch (not the module itself) is
  // the source of the log-loss regression.
  //
  // Method:
  //   1. rawProbability stored at lock time = raw ensemble prob WITH market odds active.
  //   2. calibratedProbability stored = rawProbability mapped through the global curve.
  //   3. Fit a NEW curve on fit-split rawProbabilities, same splitForCalibrationHoldout
  //      discipline (probability-rank stride, 20 % or MIN_HOLDOUT_COUNT held out).
  //   4. Apply BOTH curves to holdout: compare LL(storedCalibratedProb) vs LL(newCurve).
  //   5. If refit meaningfully closes the gap → stale-curve artifact.
  //      If gap persists → module itself over-shifts probabilities.
  //
  // Probability scale: DB stores rawProbability and calibratedProbability as 0–100.
  //   CalibrationPoint.rawProbability expects 0–1 → divide by 100.

  console.log("\n--- SECTION B-CAL: Calibration Curve Refit Diagnostic ---");
  console.log("Hypothesis: the log-loss regression is a distribution mismatch from the stale");
  console.log("global curve, not a flaw in the market-odds module itself.\n");

  const bcalRows = reRunCandidates.filter(
    (r) => r.rawProbability != null && r.calibratedProbability != null && r.actualWinnerId != null,
  );

  if (bcalRows.length < 50) {
    console.log(`  Skipped — only ${bcalRows.length} paper_trade rows with rawProbability; need ≥50.`);
  } else {
    // Load the active calibration model (small query, independent of match history).
    const [bcalCalibRow] = await db
      .select()
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1);
    const bcalGlobalKnots: CalibrationKnot[] | null = bcalCalibRow
      ? (bcalCalibRow.mapping as CalibrationKnot[])
      : null;

    // Build augmented rows that carry BOTH rawProb01 and storedCal01 so the stored
    // calibrated probability survives through the manual holdout split below.
    interface BCalRow { rawProb01: number; storedCal01: number; outcome: 0 | 1 }
    const bcalTracked: BCalRow[] = bcalRows.map((r) => ({
      rawProb01:   r.rawProbability!   / 100,
      storedCal01: r.calibratedProbability! / 100,
      outcome:     (r.actualWinnerId === r.player1Id ? 1 : 0) as 0 | 1,
    })).filter((r) => r.rawProb01 > 0 && r.rawProb01 < 1);

    // Manual stride split — identical algorithm to splitForCalibrationHoldout so
    // both curves are evaluated on the SAME holdout set sampled across the full
    // probability range (not a contiguous tail that could introduce bias).
    const HOLDOUT_FRACTION  = 0.2;
    const MIN_HOLDOUT_COUNT = 100;
    const sorted = [...bcalTracked].sort((a, b) => a.rawProb01 - b.rawProb01);
    const holdoutSize = Math.max(MIN_HOLDOUT_COUNT, Math.ceil(sorted.length * HOLDOUT_FRACTION));
    const bcalHoldout:   BCalRow[]          = [];
    const bcalFitPoints: CalibrationPoint[] = [];
    if (holdoutSize < sorted.length) {
      const stride = sorted.length / holdoutSize;
      let nextMark = 0;
      for (let i = 0; i < sorted.length; i++) {
        if (bcalHoldout.length < holdoutSize && i >= Math.round(nextMark)) {
          bcalHoldout.push(sorted[i]);
          nextMark += stride;
        } else {
          bcalFitPoints.push({ rawProbability: sorted[i].rawProb01, outcome: sorted[i].outcome });
        }
      }
    } else {
      // Degenerate: not enough data to hold out — fit on everything, skip comparison.
      for (const r of sorted) bcalFitPoints.push({ rawProbability: r.rawProb01, outcome: r.outcome });
    }

    console.log(`  Rows: ${bcalTracked.length}  fit: ${bcalFitPoints.length}  holdout: ${bcalHoldout.length}`);
    console.log(`  Global calibration: ${bcalGlobalKnots ? `${bcalGlobalKnots.length} knots (active model)` : "none active — identity used"}\n`);

    if (bcalHoldout.length < 10) {
      console.log("  Skipped — holdout too small after split.");
    } else {
      // Fit new curve on fit split only.
      const bcalNewKnots = fitIsotonicCalibrationBinned(bcalFitPoints);

      // Evaluate on holdout: three variants on the SAME rows.
      //   (A) Stored calibrated probability = global curve already applied at lock time.
      //   (B) Global knots re-applied to raw prob (cross-check; should ≈ A).
      //   (C) New market-odds-aware curve applied to raw prob.
      const llA = calibrationLogLoss(bcalHoldout.map((r) => ({
        rawProbability: r.storedCal01, outcome: r.outcome,
      })));
      const llB = bcalGlobalKnots ? calibrationLogLoss(bcalHoldout.map((r) => ({
        rawProbability: applyCalibration(bcalGlobalKnots, r.rawProb01), outcome: r.outcome,
      }))) : null;
      const llC = calibrationLogLoss(bcalHoldout.map((r) => ({
        rawProbability: applyCalibration(bcalNewKnots, r.rawProb01), outcome: r.outcome,
      })));

      const bsA = calibrationBrierScore(bcalHoldout.map((r) => ({
        rawProbability: r.storedCal01, outcome: r.outcome,
      })));
      const bsC = calibrationBrierScore(bcalHoldout.map((r) => ({
        rawProbability: applyCalibration(bcalNewKnots, r.rawProb01), outcome: r.outcome,
      })));

      const fmt4 = (v: number | null) => v == null ? " n/a   " : v.toFixed(4);
      const W = 80;
      console.log(`  ┌${"─".repeat(W - 2)}┐`);
      console.log(`  │  B-CAL: holdout n=${String(bcalHoldout.length).padEnd(4)} fit n=${String(bcalFitPoints.length).padEnd(4)}${"".padEnd(W - 41)}│`);
      console.log(`  ├${"─".repeat(45)}┬${"─".repeat(12)}┬${"─".repeat(W - 60)}┤`);
      console.log(`  │ Variant                                     │  Log-Loss  │  Brier Score    │`);
      console.log(`  ├${"─".repeat(45)}┼${"─".repeat(12)}┼${"─".repeat(W - 60)}┤`);
      console.log(`  │ (A) Stored calibrated (global curve, as-is) │ ${fmt4(llA)} │ ${fmt4(bsA)}         │`);
      if (llB != null) {
        console.log(`  │ (B) Global knots re-applied  [cross-check]  │ ${fmt4(llB)} │ n/a             │`);
      }
      console.log(`  │ (C) New market-odds-aware curve             │ ${fmt4(llC)} │ ${fmt4(bsC)}         │`);
      console.log(`  └${"─".repeat(45)}┴${"─".repeat(12)}┴${"─".repeat(W - 60)}┘`);

      if (llA != null && llC != null) {
        const improvement = llA - llC;   // positive = new curve better
        // Section B historically found Δ=+0.0243 (with-odds vs without-odds LL).
        // A "meaningful improvement" here means the refit recovers most of that gap.
        const STALE_THRESHOLD   = 0.005;  // ≥0.005 improvement = non-trivial
        const PARTIAL_THRESHOLD = 0.002;  // 0.002–0.005 = partial

        console.log(`\n  Δ log-loss (A→C, old curve → new curve): ${improvement >= 0 ? "+" : ""}${improvement.toFixed(4)}`);
        console.log(`    positive = new curve is better calibrated on market-odds-shifted probs`);
        if (llB != null) {
          const crossCheckDelta = llA - llB;
          console.log(`  Cross-check (A vs B, stored vs re-applied global): ${crossCheckDelta >= 0 ? "+" : ""}${crossCheckDelta.toFixed(4)}`);
          console.log(`    ≈0 means stored calibrated probability faithfully reflects the global curve`);
        }
        console.log(`\n  Section B reference: Δlog-loss(with odds – without odds) was +0.0243 (n=180).`);
        console.log(`  (Section B re-run below will show the updated figure at n≥200.)\n`);

        console.log(`  ─── CONCLUSION ───`);
        if (improvement >= STALE_THRESHOLD) {
          console.log(`  ✓  STALE-CURVE ARTIFACT (improvement ${improvement.toFixed(4)} ≥ ${STALE_THRESHOLD} threshold)`);
          console.log(`     The log-loss regression shrinks meaningfully when the calibration curve`);
          console.log(`     is fit on market-odds-inclusive predictions. The global curve was never`);
          console.log(`     trained on this probability distribution — a distribution mismatch, not`);
          console.log(`     a flaw in the market-odds module.`);
          console.log(`     → The KEEP/EXCLUDE decision should rest on accuracy alone (Section B).`);
          console.log(`     → Weight-tuning (Task #83) is NOT needed for the log-loss axis.`);
        } else if (improvement >= PARTIAL_THRESHOLD) {
          console.log(`  ~  PARTIAL ARTIFACT (improvement ${improvement.toFixed(4)}, between ${PARTIAL_THRESHOLD} and ${STALE_THRESHOLD})`);
          console.log(`     Refit helps somewhat but does not fully account for the regression.`);
          console.log(`     Part is stale-curve mismatch; part may be real module noise.`);
          console.log(`     → Consider light weight-tuning (Task #83) alongside the accuracy evidence.`);
        } else {
          console.log(`  ✗  REAL MODULE PROBLEM (improvement ${improvement.toFixed(4)} < ${PARTIAL_THRESHOLD} threshold)`);
          console.log(`     Refitting the calibration curve on market-odds-inclusive predictions does`);
          console.log(`     not materially reduce the log-loss regression. The miscalibration is`);
          console.log(`     inherent to how the module shifts raw probabilities.`);
          console.log(`     → Weight-tuning (Task #83) is needed before KEEP is safe.`);
        }
      }
    }
  }

  let sharedMatchHistory: ReturnType<typeof buildMatchHistoryIndex> | null = null;
  let sharedEloHistory:   Awaited<ReturnType<typeof buildEloHistoryIndex>> | null = null;
  let sharedCalibration:  CalibrationKnot[] | null = null;
  let sharedSegmentByKey: Map<string, SegmentSpecialistInput> | null = null;

  if (needsContext) {
    console.log("\nBuilding shared historical context (this may take a moment)...");
    const allMatches = await db
      .select()
      .from(historicalMatchesTable)
      .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

    sharedMatchHistory = buildMatchHistoryIndex(allMatches);
    sharedEloHistory   = await buildEloHistoryIndex();

    const [calibRow] = await db
      .select()
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1);
    sharedCalibration = calibRow ? (calibRow.mapping as CalibrationKnot[]) : null;

    const specialistRows = await db.select().from(specialistModelsTable);
    sharedSegmentByKey = new Map<string, SegmentSpecialistInput>();
    for (const row of specialistRows) {
      sharedSegmentByKey.set(row.segmentKey, {
        segmentKey: row.segmentKey,
        label: row.label,
        meetsThreshold: row.meetsThreshold,
        historicalMatchCount: row.historicalMatchCount,
        validationSampleSize: row.validationSampleSize,
        minHistoricalMatches: 0,
        minValidationSamples: 0,
        calibrationMapping: row.meetsThreshold ? (row.calibrationMapping as CalibrationKnot[]) : undefined,
        weight: row.meetsThreshold ? row.weight : undefined,
      });
    }

    console.log(`Historical corpus: ${allMatches.length} matches. Context ready.\n`);
  }

  // ─── SECTION B: Engine Re-run Ablation (paper_trade) ─────────────────────
  // Paper-trade: stored calibratedProbability = "with odds". Re-run without = counterfactual.

  console.log("\n--- SECTION B: Engine Re-run Ablation (paper_trade — with vs. without odds) ---\n");
  console.log(`Candidates for re-run (have surface + format + odds): ${reRunCandidates.length}`);

  if (reRunCandidates.length === 0) {
    console.log("No candidates for engine re-run — section B skipped.");
  } else if (sharedMatchHistory && sharedEloHistory && sharedSegmentByKey) {
    const pairsB: PairResult[] = [];
    let noHistoryB = 0;
    let engineErrorsB = 0;

    for (let i = 0; i < reRunCandidates.length; i++) {
      const row = reRunCandidates[i];
      if (i > 0 && i % 50 === 0) console.log(`  [B] Processed ${i}/${reRunCandidates.length}...`);

      if (!row.surface || !row.matchFormat || !row.predictedWinnerId || row.calibratedProbability == null || !row.actualWinnerId) {
        engineErrorsB++; continue;
      }

      const result = runAblationPair(
        row.id, row.player1Id, row.player1Name, row.player2Id, row.player2Name,
        row.surface, row.matchFormat, row.tournamentName ?? null,
        row.cutoffAt, row.actualWinnerId,
        row.oddsPlayer1Decimal!, row.oddsPlayer2Decimal!,
        sharedMatchHistory, sharedEloHistory, sharedCalibration, sharedSegmentByKey,
        "paperTrade", row.predictedWinnerId, row.calibratedProbability,
      );
      if (result === null) { noHistoryB++; continue; }
      pairsB.push(result);
    }

    console.log(`\n  [B] Re-run complete. Skipped (no history): ${noHistoryB}. Skipped (bad input): ${engineErrorsB}. Paired: ${pairsB.length}.`);
    printAblationResults(pairsB, "Section B — Paper-Trade Engine Re-run Results (n=" + pairsB.length + ")", 200);
  }

  // ─── SECTION C: Historical Market Odds (tennis-data.co.uk) ───────────────
  // Walk-forward ran without market odds → stored calibratedProbability = "no-odds" baseline.
  // Re-running WITH avgWinner/avgLoser odds gives the counterfactual over a much larger sample.
  //
  // Note: in tennis-data.co.uk backfill, player1 = actual winner (by construction), so
  //   avgWinner = decimal odds for player1 (the actual winner)
  //   avgLoser  = decimal odds for player2 (the actual loser)
  //
  // The engine's Market Consensus module will see that the market heavily favors player1 on
  // winning rows and lightly penalizes player2 — this is a PURE test of whether market
  // information helps when we KNOW the market was right (tennis-data.co.uk only stores
  // completed matches). Treat with appropriate caution re: hindsight bias vs paper-trade rows.

  console.log("\n--- SECTION C: Historical Market Odds (tennis-data.co.uk backfill) ---\n");
  console.log(`Candidates (graded historical_test with avgWinner+avgLoser): ${historicalOddsCandidates.length}`);

  if (historicalOddsCandidates.length === 0) {
    console.log("Section C skipped — no scored rows. Trigger POST /evaluation/walk-forward/score-unscored then re-run.");
  } else if (sharedMatchHistory && sharedEloHistory && sharedSegmentByKey) {
    console.log(`  [C] Running ablation on ${historicalOddsCandidates.length} rows...`);
    const pairsC: PairResult[] = [];
    let noHistoryC = 0;
    let badOddsC = 0;

    for (let i = 0; i < historicalOddsCandidates.length; i++) {
      const row = historicalOddsCandidates[i];
      if (i > 0 && i % 200 === 0) console.log(`  [C] Processed ${i}/${historicalOddsCandidates.length}...`);

      if (!row.surface || !row.matchFormat || !row.predictedWinnerId || row.calibratedProbability == null || !row.actualWinnerId) continue;

      const rawOdds = (row.rawSource as Record<string, unknown>)?._marketOdds as {
        avgWinner?: number | null;
        avgLoser?: number | null;
      } | undefined;

      const p1Odds = rawOdds?.avgWinner ?? null;
      const p2Odds = rawOdds?.avgLoser  ?? null;
      if (!p1Odds || !p2Odds || p1Odds <= 1 || p2Odds <= 1) { badOddsC++; continue; }

      const result = runAblationPair(
        row.evalId, row.player1Id, row.player1Name, row.player2Id, row.player2Name,
        row.surface, row.matchFormat, row.tournamentName ?? null,
        row.cutoffAt, row.actualWinnerId,
        p1Odds, p2Odds,
        sharedMatchHistory, sharedEloHistory, sharedCalibration, sharedSegmentByKey,
        "historical", row.predictedWinnerId!, row.calibratedProbability,
      );
      if (result === null) { noHistoryC++; continue; }
      pairsC.push(result);
    }

    console.log(`\n  [C] Re-run complete. Skipped (bad odds): ${badOddsC}. Skipped (no history): ${noHistoryC}. Paired: ${pairsC.length}.`);
    printAblationResults(pairsC, "Section C — Historical Market Odds Results (n=" + pairsC.length + ")", 500);

    // Note on hindsight: tennis-data.co.uk only stores completed matches, so the market odds
    // always favored the actual winner (for favourites). Section C measures whether the engine
    // correctly extracts that information — NOT whether adding odds improves live-prediction
    // accuracy on future unknowns. The paper-trade Section B is the canonical live-accuracy test.
    console.log("\n  ⚠  Hindsight note: Section C averages include retrospective odds where the");
    console.log("     market already knew the winner. Treat as corroborating, not primary evidence.");
    console.log("     Section B (live paper-trade odds) is the canonical criterion for KEEP/EXCLUDE.");
  }

  console.log("\n=== Done ===");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
