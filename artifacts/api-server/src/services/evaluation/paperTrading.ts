import { db, evaluationPredictionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getTennisDataProvider, ProviderUnavailableError, type TennisDataProvider } from "../tennisData";
import { getPredictionSettings, settleEvaluationPrediction } from "./settle";
import { LIVE_MODEL_VERSION, type LiveFeatureSnapshot } from "./types";
import { computeVigAdjustedImpliedProbability } from "../oddsData/impliedProbability";
import { logger } from "../../lib/logger";
import { defaultPredictionMode, derivePredictionStrategyIdentity, getCurrentProductionStrategyIdentity } from "./strategyIdentity";
import { predictFromSnapshot } from "./predictionSnapshot";
import { extractFallbackInstrumentation } from "./fallbackInstrumentation";

/**
 * How long after a fixture's cutoff instant the cycle will still lock a fresh prediction for it.
 *
 * Two distinct latency sources must both fit inside this window:
 *  1. **Polling cadence gap** — the in-process timer fires every 15 minutes, but each cycle
 *     takes 22-26 minutes (ledger grading N pending user predictions). The effective inter-cycle
 *     gap is therefore 37-50 minutes. A fixture whose cutoff falls between two runs can sit
 *     uncaught for that entire gap.
 *  2. **Provider fixture-visibility latency** — confirmed live (Aug 2026): API-Tennis does not
 *     publish all upcoming fixtures 30+ minutes in advance. For some tournaments (e.g. National
 *     Bank Open) fixtures only appear in the `get_fixtures` feed 8-15 minutes before their
 *     scheduled start. With `paperTradeLeadMinutes=30`, the cutoff is 30 minutes before start and
 *     the lock deadline under the old 15-minute grace was 15 minutes before start — so any
 *     fixture that first became visible 16+ minutes after cutoff was immediately marked 'missed'.
 *
 * Setting this to 25 minutes makes the lock deadline 5 minutes before the scheduled start
 * (`paperTradeLeadMinutes=30 − LOCK_GRACE_MINUTES=25 = 5 min`). Combined with the hard guard
 * `now >= scheduledStartAt → missed`, the pipeline NEVER locks a prediction after the match has
 * already started. Predictions locked in this extended window are late relative to the intended
 * 30-minute pre-match cutoff, but they are still genuine pre-match predictions and far more
 * useful than no prediction at all for pipeline health monitoring.
 *
 * Recalibrate if `paperTradeLeadMinutes` changes — the invariant to preserve is:
 *   paperTradeLeadMinutes - LOCK_GRACE_MINUTES > 0  (lock deadline stays before match start)
 */
const LOCK_GRACE_MINUTES = 25;

function todayPlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface PaperTradingCycleSummary {
  locked: number;
  missed: number;
  graded: number;
  errors: string[];
}

/**
 * One paper-trading cycle: (1) lock predictions for real upcoming fixtures whose cutoff has just
 * arrived, (2) mark fixtures whose cutoff passed unlocked as 'missed' (never backfilled), (3)
 * grade any pending predictions whose real result is now available. Safe to call repeatedly
 * (e.g. on a timer) -- every step is idempotent via the unique (runKind, provider,
 * externalFixtureId) index and the pending-only settlement guard.
 */
export async function runPaperTradingCycle(providerOverride?: TennisDataProvider): Promise<PaperTradingCycleSummary> {
  const summary: PaperTradingCycleSummary = { locked: 0, missed: 0, graded: 0, errors: [] };
  const settings = await getPredictionSettings();
  const provider = providerOverride ?? getTennisDataProvider();
  const currentProductionIdentity = await getCurrentProductionStrategyIdentity();
  const fallbackProductionIdentity = derivePredictionStrategyIdentity({
    predictionMode: defaultPredictionMode("paper_trade"),
    modelVersion: LIVE_MODEL_VERSION,
    createdAt: new Date(),
  });
  const effectiveProductionIdentity = {
    strategyId: currentProductionIdentity.strategyId ?? fallbackProductionIdentity.strategyId,
    strategyVersion: currentProductionIdentity.strategyVersion ?? fallbackProductionIdentity.strategyVersion,
    strategyFingerprint: currentProductionIdentity.strategyFingerprint ?? LIVE_MODEL_VERSION,
  };

  let fixtures;
  try {
    const [today, tomorrow] = await Promise.all([provider.getUpcomingFixtures(todayPlus(0)), provider.getUpcomingFixtures(todayPlus(1))]);
    fixtures = [...today, ...tomorrow];
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      summary.errors.push(`Provider unavailable while fetching fixtures: ${err.message}`);
      return summary;
    }
    throw err;
  }

  const now = Date.now();
  const fixtureShapeById = new Map<string, { player1Id: string; player2Id: string }>();

  for (const fixture of fixtures) {
    const prior = fixtureShapeById.get(fixture.id);
    if (prior && (prior.player1Id !== fixture.player1Id || prior.player2Id !== fixture.player2Id)) {
      summary.errors.push(`Fixture ${fixture.id}: duplicate fixture id with conflicting players in provider response; skipped to prevent contamination`);
      continue;
    }
    if (!prior) fixtureShapeById.set(fixture.id, { player1Id: fixture.player1Id, player2Id: fixture.player2Id });

    // A cutoff can only be computed from a real, per-fixture provider time -- never from the
    // calendar date alone (that would give every match on a day the same, fabricated cutoff).
    // Fixtures the provider hasn't confirmed a time for yet are simply not processable this
    // cycle; they'll be picked up once the provider publishes a real time for them.
    if (!fixture.timeConfirmed || !fixture.scheduledStart) continue;
    const scheduledStartAt = new Date(fixture.scheduledStart);
    if (Number.isNaN(scheduledStartAt.getTime())) continue;

    const cutoffAt = new Date(scheduledStartAt.getTime() - settings.paperTradeLeadMinutes * 60_000);

    const [existing] = await db
      .select({ id: evaluationPredictionsTable.id })
      .from(evaluationPredictionsTable)
      .where(
        and(
          eq(evaluationPredictionsTable.runKind, "paper_trade"),
          eq(evaluationPredictionsTable.provider, provider.name),
          eq(evaluationPredictionsTable.externalFixtureId, fixture.id),
        ),
      );
    if (existing) continue;

    const lockDeadline = new Date(cutoffAt.getTime() + LOCK_GRACE_MINUTES * 60_000);

    if (now >= scheduledStartAt.getTime() || now >= lockDeadline.getTime()) {
      // Either the match has already started, or the lock grace window after cutoff has already
      // elapsed with nothing locked. Either way this is a miss -- we never generate a prediction
      // after the cutoff has meaningfully passed, and we never backfill.
      await db.insert(evaluationPredictionsTable).values({
        predictionMode: defaultPredictionMode("paper_trade"),
        strategyId: effectiveProductionIdentity.strategyId,
        strategyVersion: effectiveProductionIdentity.strategyVersion,
        strategyFingerprint: effectiveProductionIdentity.strategyFingerprint,
        optimizerRunId: null,
        calibrationVersion: null,
        competitiveBalanceVersion: null,
        evidenceReliabilityVersion: null,
        runKind: "paper_trade",
        segment: "live",
        dataSegment: "live",
        provider: provider.name,
        externalFixtureId: fixture.id,
        player1Id: fixture.player1Id,
        player1Name: fixture.player1Name,
        player2Id: fixture.player2Id,
        player2Name: fixture.player2Name,
        surface: fixture.surface,
        matchFormat: fixture.matchFormat,
        tournamentLevel: fixture.tournamentLevel,
        tournamentName: fixture.tournamentName,
        scheduledStartAt,
        cutoffAt,
        lockedAt: new Date(),
        modelVersion: LIVE_MODEL_VERSION,
        featureSnapshot: null,
        rawProbability: null,
        calibratedProbability: null,
        usedFallback: null,
        fallbackSources: null,
        predictedWinnerId: null,
        predictedWinnerName: null,
        status: "missed",
      });
      summary.missed += 1;
      continue;
    }

    if (now < cutoffAt.getTime()) continue; // not yet time to lock this one

    try {
      if (!fixture.surface || !fixture.matchFormat) {
        summary.errors.push(`Fixture ${fixture.id}: missing player profile or surface/format, skipped this cycle`);
        continue;
      }
      const { player1, player2, output, activeCalibrationId, marketOdds: paperTradeOddsQuote } = await predictFromSnapshot({
        provider,
        player1Id: fixture.player1Id,
        player2Id: fixture.player2Id,
        surface: fixture.surface,
        matchFormat: fixture.matchFormat,
        tournamentName: fixture.tournamentName,
        tournamentLevel: fixture.tournamentLevel,
        scheduledStartAt,
        includeWeather: true,
      });

      // The engine already applies the active Phase-4 calibration internally when one exists (see
      // predictionEngine/index.ts), so its own `calibratedProbability` output IS the final,
      // validated probability here -- no separate post-hoc calibration step is needed anymore.
      const calibratedProbability = output.calibratedProbability;
      const rawProbability = output.rawEnsembleProbability; // pre-calibration, kept for transparency/future refitting

      const favorsPlayer1 = calibratedProbability >= 50;
      const fallback = extractFallbackInstrumentation({
        engine: output.engine,
        decisionTrace: output.decisionTrace,
      });
      const snapshot: LiveFeatureSnapshot = {
        modelVersion: LIVE_MODEL_VERSION,
        engine: output.engine,
        preCalibrationProbability: rawProbability,
        dataQuality: output.dataQuality,
        isEliteTier: output.engine.isEliteTier,
        // Per-module weight trace: written forward-only; absent on rows scored before this field.
        moduleWeights: output.decisionTrace.modules,
      };

      // Task 47 / Task #146: market odds were already fetched inside predictFromSnapshot
      // (shared with the engine's Market Consensus module) — reuse that result here for the
      // audit columns instead of making a second provider call for the same fixture.
      const oddsQuote = paperTradeOddsQuote;
      const impliedProbability = oddsQuote
        ? computeVigAdjustedImpliedProbability(oddsQuote.player1DecimalOdds, oddsQuote.player2DecimalOdds)
        : null;
      // Oriented to the model's own pick, not to player1 -- see schema comment on marketEdge.
      const impliedProbabilityForPick =
        impliedProbability === null ? null : favorsPlayer1 ? impliedProbability : 100 - impliedProbability;
      const marketEdge = impliedProbabilityForPick === null ? null : output.predictedWinnerProbability - impliedProbabilityForPick;

      await db.insert(evaluationPredictionsTable).values({
        predictionMode: defaultPredictionMode("paper_trade"),
        strategyId: effectiveProductionIdentity.strategyId,
        strategyVersion: effectiveProductionIdentity.strategyVersion,
        strategyFingerprint: effectiveProductionIdentity.strategyFingerprint,
        optimizerRunId: null,
        calibrationVersion: activeCalibrationId,
        competitiveBalanceVersion: null,
        evidenceReliabilityVersion: null,
        runKind: "paper_trade",
        segment: "live",
        dataSegment: "live",
        provider: provider.name,
        externalFixtureId: fixture.id,
        player1Id: player1.id,
        player1Name: player1.name,
        player2Id: player2.id,
        player2Name: player2.name,
        surface: fixture.surface,
        matchFormat: fixture.matchFormat,
        tournamentLevel: fixture.tournamentLevel,
        tournamentName: fixture.tournamentName,
        scheduledStartAt,
        cutoffAt,
        lockedAt: new Date(),
        modelVersion: LIVE_MODEL_VERSION,
        featureSnapshot: snapshot,
        modelAgreement: output.engine.modelAgreement,
        upsetRiskTier: output.upsetRisk,
        usedFallback: fallback.usedFallback,
        fallbackSources: fallback.fallbackSources,
        rawProbability,
        calibratedProbability,
        predictedWinnerId: favorsPlayer1 ? player1.id : player2.id,
        predictedWinnerName: favorsPlayer1 ? player1.name : player2.name,
        status: "pending",
        oddsProvider: oddsQuote?.provider ?? null,
        oddsPlayer1Decimal: oddsQuote?.player1DecimalOdds ?? null,
        oddsPlayer2Decimal: oddsQuote?.player2DecimalOdds ?? null,
        oddsFetchedAt: oddsQuote ? new Date(oddsQuote.fetchedAt) : null,
        impliedProbability,
        marketEdge,
      });
      summary.locked += 1;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        summary.errors.push(`Fixture ${fixture.id}: provider unavailable (${err.message})`);
        continue;
      }
      if (err instanceof Error && err.message.includes("could not be found by the data provider")) {
        summary.errors.push(`Fixture ${fixture.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  summary.graded = await gradePendingPaperTrades(summary.errors, provider);
  return summary;
}

async function gradePendingPaperTrades(errors: string[], providerOverride?: TennisDataProvider): Promise<number> {
  const settings = await getPredictionSettings();
  const provider = providerOverride ?? getTennisDataProvider();
  const pending = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(and(eq(evaluationPredictionsTable.runKind, "paper_trade"), eq(evaluationPredictionsTable.status, "pending")));

  let gradedCount = 0;
  for (const row of pending) {
    // Only attempt grading once the match's scheduled start is safely in the past.
    if (Date.now() < row.scheduledStartAt.getTime() + 60 * 60_000) continue;

    if (row.player1Id === row.player2Id) {
      errors.push(`Grading prediction ${row.id}: duplicate player IDs (${row.player1Id}) -- grading blocked`);
      continue;
    }

    try {
      const matches = await provider.getPlayerMatches(row.player1Id);
      const exactFixtureCandidates = row.externalFixtureId
        ? matches.filter((m) => m.id === row.externalFixtureId && m.opponentId === row.player2Id)
        : [];
      const fallbackCandidates = matches.filter(
        (m) => m.opponentId === row.player2Id && Math.abs(new Date(m.date).getTime() - row.scheduledStartAt.getTime()) < 3 * 24 * 60 * 60_000,
      );
      const candidates = row.externalFixtureId ? exactFixtureCandidates : fallbackCandidates;

      if (candidates.length > 1) {
        errors.push(
          row.externalFixtureId
            ? `Grading prediction ${row.id}: ambiguous matches for fixture ${row.externalFixtureId}; grading blocked`
            : `Grading prediction ${row.id}: ambiguous matches for player pair ${row.player1Id}/${row.player2Id}; grading blocked`,
        );
        continue;
      }

      const match = candidates[0];

      if (!match) {
        // No result surfaced after a generous window -- treat as cancelled rather than leaving
        // it pending forever or silently discarding it.
        if (Date.now() > row.scheduledStartAt.getTime() + 48 * 60 * 60_000) {
          await settleEvaluationPrediction(row.id, { actualWinnerId: null, actualWinnerName: null, resultType: "cancelled" }, settings);
          gradedCount += 1;
        }
        continue;
      }

      const winnerId = match.result === "W" ? row.player1Id : row.player2Id;
      const winnerName = winnerId === row.player1Id ? row.player1Name : row.player2Name;
      const resultType = match.walkover ? "walkover" : match.retired ? "retired" : "normal";

      await settleEvaluationPrediction(row.id, { actualWinnerId: winnerId, actualWinnerName: winnerName, resultType }, settings);
      gradedCount += 1;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        errors.push(`Grading prediction ${row.id}: provider unavailable (${err.message})`);
        continue;
      }
      logger.error({ err, predictionId: row.id }, "Unexpected error grading paper-trade prediction");
      errors.push(`Grading prediction ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return gradedCount;
}
