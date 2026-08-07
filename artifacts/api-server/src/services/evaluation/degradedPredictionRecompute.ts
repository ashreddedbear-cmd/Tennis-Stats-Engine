import { db, predictionsTable, type PredictionRow } from "@workspace/db";
import { desc } from "drizzle-orm";
import { computeInputSnapshotHash, computeMatchIdentityKey } from "../predictionEngine/predictionIdentity";
import { predictFromSnapshot } from "./predictionSnapshot";
import { saveOrUpdatePrediction } from "./savePrediction";
import { getTennisDataProvider } from "../tennisData";
import { logger } from "../../lib/logger";

const DEFAULT_BATCH_SIZE = 50;

type StoredEngine = {
  defaultedInputs?: unknown;
  supersedesPredictionId?: number;
};

function defaultedInputCount(row: PredictionRow): number {
  const values = (row.engine as StoredEngine | null)?.defaultedInputs;
  return Array.isArray(values) ? values.length : 0;
}

function hasNewerSnapshot(row: PredictionRow, allRows: PredictionRow[]): boolean {
  return allRows.some((candidate) =>
    candidate.id !== row.id &&
    candidate.matchIdentityKey === row.matchIdentityKey &&
    candidate.createdAt.getTime() > row.createdAt.getTime(),
  );
}

/**
 * Re-attempts predictions whose stored engine snapshot explicitly recorded neutral defaults.
 * A successful retry is inserted as a new immutable prediction row; the original remains in
 * History and is never rewritten.
 */
export async function recomputeDegradedPredictions(batchSize = DEFAULT_BATCH_SIZE): Promise<{ scanned: number; retried: number; improved: number; errors: string[] }> {
  const allRows = await db.select().from(predictionsTable).orderBy(desc(predictionsTable.createdAt));
  const candidates = allRows
    .filter((row) => defaultedInputCount(row) > 0 && !hasNewerSnapshot(row, allRows))
    .slice(0, batchSize);
  const provider = getTennisDataProvider();
  let retried = 0;
  let improved = 0;
  const errors: string[] = [];

  for (const row of candidates) {
    retried++;
    try {
      const snapshot = await predictFromSnapshot({
        provider,
        player1Id: row.player1Id,
        player2Id: row.player2Id,
        player1SubmittedName: row.player1Name,
        player2SubmittedName: row.player2Name,
        surface: row.surface as "Hard" | "Clay" | "Grass" | "IndoorHard",
        matchFormat: row.matchFormat as "BestOf3" | "BestOf5",
        tournamentName: row.tournamentName,
        tournamentLevel: row.tournamentLevel as any,
        includeWeather: false,
      });
      const newDefaultedInputs = snapshot.output.engine.defaultedInputs;
      if (newDefaultedInputs.length >= defaultedInputCount(row)) continue;

      const inputSnapshotHash = computeInputSnapshotHash({
        player1Id: snapshot.player1.id,
        player2Id: snapshot.player2.id,
        player1Matches: snapshot.player1Matches,
        player2Matches: snapshot.player2Matches,
        headToHead: snapshot.headToHead,
        player1OpponentElo: snapshot.player1OpponentStrength.lookup,
        player2OpponentElo: snapshot.player2OpponentStrength.lookup,
      });
      const engine = { ...snapshot.output.engine, currentForMatch: true, supersedesPredictionId: row.id };
      await saveOrUpdatePrediction({
        player1Id: snapshot.player1.id,
        player1Name: snapshot.player1.name,
        player2Id: snapshot.player2.id,
        player2Name: snapshot.player2.name,
        surface: row.surface,
        matchFormat: row.matchFormat,
        tournamentLevel: row.tournamentLevel,
        tournamentName: row.tournamentName,
        strategyId: row.strategyId,
        strategyVersion: row.strategyVersion,
        calibrationVersion: snapshot.activeCalibrationId,
        externalFixtureId: row.externalFixtureId,
        snapshotCapturedAt: new Date(),
        predictedWinnerId: snapshot.output.predictedWinnerId,
        predictedWinnerName: snapshot.output.predictedWinnerName,
        calibratedProbability: snapshot.output.calibratedProbability,
        predictedWinnerProbability: snapshot.output.predictedWinnerProbability,
        dataQuality: snapshot.output.dataQuality,
        dataQualityLabel: snapshot.output.dataQualityLabel,
        upsetRisk: snapshot.output.upsetRisk,
        recommendation: snapshot.output.recommendation,
        predictedSetScore: snapshot.output.predictedSetScore,
        engine,
        decisionTrace: snapshot.output.decisionTrace,
        crossEngineAgreement: null,
        matchIdentityKey: computeMatchIdentityKey(snapshot.player1.id, snapshot.player2.id, row.tournamentName, row.surface, row.matchFormat),
        inputSnapshotHash,
        clerkUserId: row.clerkUserId,
      });
      improved++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${row.id}: ${message}`);
      logger.warn({ err, predictionId: row.id }, "degraded prediction recomputation failed; original preserved");
    }
  }

  return { scanned: candidates.length, retried, improved, errors };
}
