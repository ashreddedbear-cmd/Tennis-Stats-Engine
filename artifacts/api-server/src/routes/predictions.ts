import { Router, type IRouter } from "express";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { db, predictionsTable } from "@workspace/db";
import {
  ListPredictionsQueryParams,
  ListPredictionsResponse,
  CreatePredictionBody,
  CreatePredictionResponse,
  GetPredictionStatsResponse,
  GetPredictionParams,
  GetPredictionResponse,
  RecordPredictionOutcomeParams,
  RecordPredictionOutcomeBody,
  RecordPredictionOutcomeResponse,
  DeletePredictionParams,
  BulkDeletePredictionsBody,
  BulkDeletePredictionsResponse,
  GradePendingLedgerPredictionsResponse,
  PreviewDuplicatePredictionsResponse,
  RemoveDuplicatePredictionsResponse,
  SearchLedgerPlayersQueryParams,
  SearchLedgerPlayersResponse,
  GetLedgerPlayerPredictionsParams,
  GetLedgerPlayerPredictionsResponse,
} from "@workspace/api-zod";
import { getTennisDataProvider, ProviderUnavailableError } from "../services/tennisData";
import { usedHistoricalMatchFallback } from "../services/predictionEngine/playerProfileWarnings";
import { computeMatchIdentityKey, computeInputSnapshotHash } from "../services/predictionEngine/predictionIdentity";
import { gradePendingLedgerPredictions } from "../services/evaluation/ledgerGrading";
import { findDuplicatePredictionGroups, removeDuplicatePredictions } from "../services/evaluation/ledgerDuplicates";
import { searchLedgerPlayers, getPredictionsForPlayer } from "../services/evaluation/ledgerPlayers";
import { saveOrUpdatePrediction } from "../services/evaluation/savePrediction";
import { predictFromSnapshot, PredictionSnapshotResolutionError } from "../services/evaluation/predictionSnapshot";
import { LIVE_MODEL_VERSION } from "../services/evaluation/types";
import { defaultPredictionMode, derivePredictionStrategyIdentity, getCurrentProductionStrategyIdentity } from "../services/evaluation/strategyIdentity";
import { enforceEntitlement } from "../lib/entitlements";
import { logger } from "../lib/logger";
import { formatDatabaseError } from "../lib/databaseError";
import {
  assertPredictionIdentityIntegrity,
  getExternalFixtureIdFromRequestMatchId,
  parsePredictionRequestIntegrityHeaders,
} from "./predictionRequestIntegrity";
import {
  canUseCompetitiveBalance,
  canUseEliteRecommendations,
  canUseEvidenceReliability,
  canUsePredictionHistory,
} from "../services/payments/entitlementService";

const router: IRouter = Router();

/**
 * Task #30: attaches the real historical-match-fallback disclosure (derived from this row's own
 * stored `engine.warnings`, per `usedHistoricalMatchFallback`) to a raw `predictionsTable` row so
 * list endpoints -- which serialize through the trimmed `PredictionSummary` schema and would
 * otherwise silently drop the full `engine` blob -- can still surface it as a real, non-guessed
 * boolean.
 */
function withHistoricalMatchFallbackFlag<T extends { engine: unknown }>(row: T): T & { usedHistoricalMatchFallback: boolean } {
  const warnings = (row.engine as { warnings?: unknown } | null)?.warnings;
  return { ...row, usedHistoricalMatchFallback: usedHistoricalMatchFallback(warnings) };
}

router.get("/predictions", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const parsed = ListPredictionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(predictionsTable)
    .orderBy(desc(predictionsTable.createdAt))
    .limit(parsed.data.limit);

  res.json(ListPredictionsResponse.parse(rows.map(withHistoricalMatchFallbackFlag)));
});

router.get("/predictions/stats", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  // Aggregated in SQL rather than loading every row into Node -- same output shape as before,
  // but the endpoint no longer scales linearly with total prediction count.
  const [totals] = await db
    .select({
      totalPredictions: sql<number>`count(*)`.mapWith(Number),
      resolvedPredictions: sql<number>`count(*) filter (where ${predictionsTable.actualWinnerId} is not null)`.mapWith(Number),
      correctPredictions: sql<number>`count(*) filter (where ${predictionsTable.actualWinnerId} = ${predictionsTable.predictedWinnerId})`.mapWith(
        Number,
      ),
    })
    .from(predictionsTable);

  const byRecommendationRows = await db
    .select({
      recommendation: predictionsTable.recommendation,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(predictionsTable)
    .groupBy(predictionsTable.recommendation);

  const { totalPredictions, resolvedPredictions, correctPredictions } = totals ?? {
    totalPredictions: 0,
    resolvedPredictions: 0,
    correctPredictions: 0,
  };
  const accuracy = resolvedPredictions > 0 ? Math.round((correctPredictions / resolvedPredictions) * 1000) / 10 : null;

  res.json(
    GetPredictionStatsResponse.parse({
      totalPredictions,
      resolvedPredictions,
      correctPredictions,
      accuracy,
      byRecommendation: byRecommendationRows,
    }),
  );
});

// Registered before /predictions/:predictionId and /predictions/players/:playerId so that
// "/predictions/players/search" resolves as this literal route rather than being swallowed by
// the :playerId param route below.
router.get("/predictions/players/search", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const parsed = SearchLedgerPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const players = await searchLedgerPlayers(parsed.data.query);
  res.json(SearchLedgerPlayersResponse.parse(players));
});

router.get("/predictions/players/:playerId", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = GetLedgerPlayerPredictionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await getPredictionsForPlayer(params.data.playerId);
  res.json(GetLedgerPlayerPredictionsResponse.parse(rows.map(withHistoricalMatchFallbackFlag)));
});

router.post("/predictions", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUseCompetitiveBalance, "competitiveBalance"))) return;
  if (!(await enforceEntitlement(res, canUseEvidenceReliability, "evidenceReliability"))) return;
  if (!(await enforceEntitlement(res, canUseEliteRecommendations, "eliteRecommendations"))) return;

  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;

  if (body.player1Id === body.player2Id) {
    res.status(400).json({ error: "player1Id and player2Id must be different players" });
    return;
  }

  const integrity = parsePredictionRequestIntegrityHeaders(req.headers as Record<string, unknown>);
  if ("code" in integrity) {
    res.status(400).json({ error: integrity.message });
    return;
  }

  const provider = getTennisDataProvider();

  try {
    const currentProductionIdentity = await getCurrentProductionStrategyIdentity();
    const fallbackProductionIdentity = derivePredictionStrategyIdentity({
      predictionMode: defaultPredictionMode("live"),
      modelVersion: LIVE_MODEL_VERSION,
      createdAt: new Date(),
    });
    const effectiveProductionIdentity = {
      strategyId: currentProductionIdentity.strategyId ?? fallbackProductionIdentity.strategyId,
      strategyVersion: currentProductionIdentity.strategyVersion ?? fallbackProductionIdentity.strategyVersion,
      strategyFingerprint: currentProductionIdentity.strategyFingerprint ?? LIVE_MODEL_VERSION,
    };

    const {
      player1,
      player2,
      player1Matches,
      player2Matches,
      headToHead,
      player1OpponentStrength,
      player2OpponentStrength,
      activeCalibrationId,
      output,
    } = await predictFromSnapshot({
      provider,
      player1Id: body.player1Id,
      player2Id: body.player2Id,
      surface: body.surface,
      matchFormat: body.matchFormat,
      tournamentName: body.tournamentName ?? null,
      tournamentLevel: body.tournamentLevel ?? null,
      // Ad-hoc live-search predictions have no fixture start time, so weather remains intentionally
      // unavailable here while using the same canonical snapshot scorer as paper trading.
      includeWeather: false,
    });

    const identityViolation = assertPredictionIdentityIntegrity(body, integrity, player1, player2);
    if (identityViolation) {
      res.status(identityViolation.code === "BAD_REQUEST" ? 400 : 409).json({ error: identityViolation.message });
      return;
    }

    const matchIdentityKey = computeMatchIdentityKey(player1.id, player2.id, body.tournamentName ?? null, body.surface, body.matchFormat);
    const inputSnapshotHash = computeInputSnapshotHash({
      player1Id: player1.id,
      player2Id: player2.id,
      player1Matches,
      player2Matches,
      headToHead,
      player1OpponentElo: player1OpponentStrength.lookup,
      player2OpponentElo: player2OpponentStrength.lookup,
      requestNonce: integrity.requestId,
    });

    output.engine.warnings.push(`REQUEST_ID:${integrity.requestId}`);
    output.engine.warnings.push(`REQUEST_MATCH_ID:${integrity.requestMatchId}`);

    const saved = await saveOrUpdatePrediction({
      player1Id: player1.id,
      player1Name: player1.name,
      player2Id: player2.id,
      player2Name: player2.name,
      surface: body.surface,
      matchFormat: body.matchFormat,
      tournamentLevel: body.tournamentLevel ?? null,
      tournamentName: body.tournamentName ?? null,
      strategyId: effectiveProductionIdentity.strategyId,
      strategyVersion: effectiveProductionIdentity.strategyVersion,
      calibrationVersion: activeCalibrationId,
      externalFixtureId: getExternalFixtureIdFromRequestMatchId(integrity.requestMatchId),
      snapshotCapturedAt: new Date(),
      predictedWinnerId: output.predictedWinnerId,
      predictedWinnerName: output.predictedWinnerName,
      calibratedProbability: output.calibratedProbability,
      predictedWinnerProbability: output.predictedWinnerProbability,
      dataQuality: output.dataQuality,
      dataQualityLabel: output.dataQualityLabel,
      upsetRisk: output.upsetRisk,
      recommendation: output.recommendation,
      predictedSetScore: output.predictedSetScore,
      engine: output.engine,
      decisionTrace: output.decisionTrace,
      crossEngineAgreement: output.crossEngineAgreement,
      matchIdentityKey,
      inputSnapshotHash,
    });

    if (
      saved.player1Id !== body.player1Id ||
      saved.player2Id !== body.player2Id ||
      saved.surface !== body.surface ||
      saved.matchFormat !== body.matchFormat ||
      (saved.tournamentName ?? null) !== (body.tournamentName ?? null)
    ) {
      res.status(409).json({ error: "Integrity check failed: saved prediction no longer matches the submitted request context" });
      return;
    }

    if ((saved.externalFixtureId ?? null) !== getExternalFixtureIdFromRequestMatchId(integrity.requestMatchId)) {
      res.status(409).json({ error: "Integrity check failed: saved fixture lineage no longer matches the submitted request context" });
      return;
    }

    res.setHeader("x-prediction-request-id", integrity.requestId);
    res.setHeader("x-prediction-match-id", integrity.requestMatchId);

    res.status(201).json(CreatePredictionResponse.parse(saved));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    if (err instanceof PredictionSnapshotResolutionError) {
      logger.warn({ err, requestBody: body }, "Prediction blocked due to unresolved required player identity inputs");
      res.status(422).json({
        error: "Prediction cannot run because required player identity data is unavailable.",
        detail: err.message,
        missingFields: err.missingFields,
      });
      return;
    }
    const dbErr = formatDatabaseError(err, "Prediction insert failed");
    logger.error({ err, requestBody: body, dbError: dbErr.log }, "Prediction engine failed during persistence");
    res.status(dbErr.status).json(dbErr.body);
    return;
  }
});

router.get("/predictions/:predictionId", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = GetPredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.predictionId));

  if (!row) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  res.json(GetPredictionResponse.parse(row));
});

router.delete("/predictions/:predictionId", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = DeletePredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db
    .delete(predictionsTable)
    .where(eq(predictionsTable.id, params.data.predictionId))
    .returning({ id: predictionsTable.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  res.status(204).end();
});

router.post("/predictions/bulk-delete", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const parsed = BulkDeletePredictionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const deleted = await db
    .delete(predictionsTable)
    .where(inArray(predictionsTable.id, parsed.data.ids))
    .returning({ id: predictionsTable.id });

  res.json(BulkDeletePredictionsResponse.parse({ deletedCount: deleted.length }));
});

router.post("/predictions/duplicates/preview", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const groups = await findDuplicatePredictionGroups();
  const removableCount = groups.reduce((sum, g) => sum + g.removeIds.length, 0);
  res.json(PreviewDuplicatePredictionsResponse.parse({ removableCount, groups }));
});

router.post("/predictions/duplicates/remove", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const { removedCount, groups } = await removeDuplicatePredictions();
  res.json(RemoveDuplicatePredictionsResponse.parse({ removedCount, groups }));
});

router.post("/predictions/grade-pending", async (_req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  try {
    const summary = await gradePendingLedgerPredictions();
    res.json(GradePendingLedgerPredictionsResponse.parse(summary));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: "Tennis data provider unavailable", detail: err.message });
      return;
    }
    throw err;
  }
});

router.patch("/predictions/:predictionId/outcome", async (req, res): Promise<void> => {
  if (!(await enforceEntitlement(res, canUsePredictionHistory, "predictionHistory"))) return;

  const params = RecordPredictionOutcomeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = RecordPredictionOutcomeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.predictionId));
  if (!existing) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  const actualWinnerName =
    body.data.actualWinnerId === existing.player1Id
      ? existing.player1Name
      : body.data.actualWinnerId === existing.player2Id
        ? existing.player2Name
        : null;

  const [updated] = await db
    .update(predictionsTable)
    .set({
      actualWinnerId: body.data.actualWinnerId,
      actualWinnerName,
      resolvedAt: new Date(),
    })
    .where(eq(predictionsTable.id, params.data.predictionId))
    .returning();

  res.json(GetPredictionResponse.parse(updated));
});

export default router;
