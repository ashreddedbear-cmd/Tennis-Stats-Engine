/**
 * Bridge-triggered rescore: re-evaluate specific historical matches using the
 * full historical context (Elo / h2h / form from ALL DB rows), without fold
 * structure or minimum-eligibility floors.
 *
 * Used after the ext-csv player-ID bridge corrects ext-xxx → real player IDs
 * so those matches are re-scored with accurate player histories instead of the
 * stale features computed from the placeholder IDs.
 *
 * Key differences from runWalkForwardEvaluation:
 *   1. Loads ALL historical_matches (no matchIds scope) so h2h and form
 *      features reflect the complete corpus — not just the corrected subset.
 *      The scoped matchIds path in runWalkForwardEvaluation only loads the
 *      target rows, which starves matchHistory of the prior matches needed
 *      for per-player form and h2h.
 *   2. Scores ONLY the specified matchIds — no fold structure, no warmup, no
 *      minimum eligible-match floors.  Even a single corrected match is scored.
 *   3. Uses the currently-active calibration without refitting it (frozen,
 *      same as evaluationOnly=true in walk-forward).
 *   4. Inserts one evaluation_predictions row per match
 *      (run_kind='historical_test', segment='test', foldId=null).
 *
 * Callers must delete the stale evaluation_predictions for these matchIds
 * BEFORE calling this function, or the insert will conflict on the
 * (run_kind, historical_match_id) unique index.
 */

import {
  db,
  evaluationPredictionsTable,
  calibrationModelsTable,
  historicalMatchesTable,
} from "@workspace/db";
import { eq, asc, inArray } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { scoreHistoricalMatch } from "./historicalScoring";
import { getPredictionSettings } from "./settle";
import { getActiveSpecialistSegments } from "./specialistWeights";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { applyCalibrationOriented } from "./calibration";
import { defaultPredictionMode, derivePredictionStrategyIdentity } from "./strategyIdentity";
import { eloFallbackTracker } from "../predictionEngine/fallbackTracking";
import { HISTORICAL_MODEL_VERSION, type RetirementRule } from "./types";
import type { CalibrationKnot } from "./types";

export interface BridgeRescoreResult {
  /** Matches successfully scored and inserted into evaluation_predictions. */
  scored: number;
  /** Matches that threw during scoring or insertion (logged, never rethrown). */
  failed: number;
  /**
   * matchIds passed in but absent from historical_matches.
   * This is expected to be 0 under normal operation; non-zero means the
   * bridge deleted rows that the rescore was asked to cover.
   */
  notFound: number;
}

export interface BridgeRescoreOpts {
  /**
   * When provided, the "full historical context" query that builds the
   * Elo / h2h / form index is scoped to these match IDs instead of the
   * entire historical_matches table.
   *
   * **Production**: always omit this field — it defaults to the full corpus.
   *
   * **Integration tests**: pass the IDs of all synthetic matches seeded by
   * the test (background rows + target rows). This keeps the corpus small so
   * the test completes in seconds rather than loading 100k+ real rows.
   * The real scoring path (scoreHistoricalMatch, buildMatchHistoryIndex,
   * buildEloHistoryIndex) is still exercised with the synthetic corpus.
   */
  contextMatchIds?: number[];
}

export async function runBridgeRescore(
  matchIds: number[],
  opts: BridgeRescoreOpts = {},
): Promise<BridgeRescoreResult> {
  if (matchIds.length === 0) return { scored: 0, failed: 0, notFound: 0 };

  logger.info({ targetCount: matchIds.length }, "runBridgeRescore: starting targeted rescore");

  // Frozen calibration — this is not a training run; never refit.
  const [activeCalibration] = await db
    .select()
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);
  const calibrationMapping: CalibrationKnot[] | null = activeCalibration
    ? (activeCalibration.mapping as CalibrationKnot[])
    : null;

  const settings = await getPredictionSettings();
  const retirementRule = (settings.retirementRule ?? "excluded") as RetirementRule;

  // ── Full corpus load ───────────────────────────────────────────────────────
  // Load ALL historical matches so matchHistory (h2h, form) reflects the
  // complete corpus — not just the corrected subset. Each corrected match needs
  // the full prior history of both players to produce accurate Elo ratings and
  // recent-form features.
  //
  // opts.contextMatchIds scopes this query to a known synthetic set; it is
  // ONLY for integration tests where loading the full 100k+ row corpus would
  // time out. Never pass it in production.
  const allMatches = await db
    .select()
    .from(historicalMatchesTable)
    .where(
      opts.contextMatchIds && opts.contextMatchIds.length > 0
        ? inArray(historicalMatchesTable.id, opts.contextMatchIds)
        : undefined,
    )
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  const identityIndex = await buildPlayerIdentityIndex();
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(
    previousSpecialistRows.map((row) => [row.segmentKey, row]),
  );

  const scoringContext = {
    matchHistory: buildMatchHistoryIndex(allMatches),
    eloHistory: await buildEloHistoryIndex(identityIndex),
    identityIndex,
    specialistRowsBySegmentKey,
  };

  // Filter to only the requested matches (from the full corpus above)
  const targetMatchIdSet = new Set(matchIds);
  const targetMatches = allMatches.filter((m) => targetMatchIdSet.has(m.id));
  const notFound = matchIds.length - targetMatches.length;

  if (notFound > 0) {
    logger.warn(
      { matchIds, notFound },
      "runBridgeRescore: some target matchIds not found in historical_matches",
    );
  }

  eloFallbackTracker.reset();

  let scored = 0;
  let failed = 0;

  for (const match of targetMatches) {
    // Cancelled matches are never scored in walk-forward either.
    if (match.cancelled) {
      logger.debug({ matchId: match.id }, "runBridgeRescore: skipping cancelled match");
      continue;
    }

    try {
      const resultType =
        match.walkover ? "walkover" : match.retired ? "retired" : "normal";
      const isVoid = resultType === "walkover";
      const player1Id = typeof match.player1Id === "string" ? match.player1Id : null;
      const player1Name = typeof match.player1Name === "string" ? match.player1Name : null;
      const player2Id = typeof match.player2Id === "string" ? match.player2Id : null;
      const player2Name = typeof match.player2Name === "string" ? match.player2Name : null;

      if (!player1Id || !player1Name || !player2Id || !player2Name) {
        logger.warn(
          { historicalMatchId: match.id },
          "runBridgeRescore: skipping match with missing required player identifiers",
        );
        failed++;
        continue;
      }

      const scoredResult = await scoreHistoricalMatch(match, scoringContext);
      const rawProbability = scoredResult?.rawProbability ?? null;
      const predictedWinnerId =
        rawProbability !== null
          ? rawProbability >= 0.5
            ? player1Id
            : player2Id
          : null;
      const includedInAccuracy =
        !isVoid &&
        (resultType === "normal" || retirementRule === "included") &&
        rawProbability !== null;
      const lockedAt = new Date();

      const strategyIdentity = derivePredictionStrategyIdentity({
        predictionMode: defaultPredictionMode("historical_test"),
        modelVersion: HISTORICAL_MODEL_VERSION,
        createdAt: lockedAt,
      });

      // Apply frozen calibration when available; fall back to raw probability.
      let calibratedProbability: number | null = null;
      if (rawProbability !== null) {
        calibratedProbability = calibrationMapping
          ? applyCalibrationOriented(calibrationMapping, rawProbability) * 100
          : rawProbability * 100;
      }

      const toInsert = {
        predictionMode: defaultPredictionMode("historical_test"),
        strategyId: strategyIdentity.strategyId,
        strategyVersion: strategyIdentity.strategyVersion,
        strategyFingerprint: HISTORICAL_MODEL_VERSION,
        optimizerRunId: null as string | null,
        calibrationVersion: null as string | null,
        competitiveBalanceVersion: null as string | null,
        evidenceReliabilityVersion: null as string | null,
        runKind: "historical_test",
        foldId: null as number | null,
        segment: "test",
        dataSegment: "test",
        historicalMatchId: typeof match.id === "number" ? match.id : null,
        player1Id,
        player1Name,
        player2Id,
        player2Name,
        surface: typeof match.surface === "string" ? match.surface : null,
        matchFormat: typeof match.matchFormat === "string" ? match.matchFormat : null,
        tournamentLevel:
          typeof match.tournamentLevel === "string" ? match.tournamentLevel : null,
        tournamentName:
          typeof match.tournamentName === "string" ? match.tournamentName : null,
        scheduledStartAt:
          match.scheduledStartAt instanceof Date
            ? match.scheduledStartAt
            : new Date(match.scheduledStartAt),
        cutoffAt:
          match.cutoffAt instanceof Date ? match.cutoffAt : new Date(match.cutoffAt),
        lockedAt,
        modelVersion: HISTORICAL_MODEL_VERSION,
        featureSnapshot: scoredResult?.snapshot ?? null,
        modelAgreement:
          typeof scoredResult?.modelAgreement === "string"
            ? scoredResult.modelAgreement
            : null,
        upsetRiskTier:
          typeof scoredResult?.upsetRiskTier === "string"
            ? scoredResult.upsetRiskTier
            : null,
        usedFallback: scoredResult?.usedFallback ?? null,
        fallbackSources: scoredResult?.fallbackSources ?? null,
        rawProbability:
          rawProbability !== null && Number.isFinite(rawProbability)
            ? rawProbability * 100
            : null,
        calibratedProbability,
        predictedWinnerId: predictedWinnerId ?? null,
        predictedWinnerName: predictedWinnerId
          ? predictedWinnerId === player1Id
            ? player1Name
            : player2Name
          : null,
        status: rawProbability === null ? "void" : isVoid ? "void" : "graded",
        actualWinnerId: typeof match.winnerId === "string" ? match.winnerId : null,
        actualWinnerName:
          match.winnerId && typeof match.winnerId === "string"
            ? match.winnerId === player1Id
              ? player1Name
              : player2Name
            : null,
        resultType: rawProbability === null ? null : resultType,
        includedInAccuracy:
          typeof includedInAccuracy === "boolean" ? includedInAccuracy : false,
        gradedAt: new Date(),
      };

      try {
        await db.insert(evaluationPredictionsTable).values(toInsert);
        scored++;
      } catch (insertErr: unknown) {
        // Repair attempt: drop featureSnapshot (common cause of JSON serialization issues).
        // Mirrors the same recovery path in walkForward.ts's scoreAndInsert helper.
        try {
          await db
            .insert(evaluationPredictionsTable)
            .values({ ...toInsert, featureSnapshot: null });
          scored++;
          logger.warn(
            { historicalMatchId: match.id },
            "runBridgeRescore: insert recovered by dropping featureSnapshot",
          );
        } catch (repairErr: unknown) {
          logger.error(
            { err: insertErr, repairErr, historicalMatchId: match.id },
            "runBridgeRescore: both insert attempts failed",
          );
          failed++;
        }
      }
    } catch (err: unknown) {
      logger.error({ err, matchId: match.id }, "runBridgeRescore: failed to score match");
      failed++;
    }
  }

  logger.info(
    { targetCount: targetMatches.length, scored, failed, notFound },
    "runBridgeRescore: complete",
  );
  return { scored, failed, notFound };
}
