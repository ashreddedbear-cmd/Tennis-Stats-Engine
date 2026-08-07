import { db, jobRunsTable } from "@workspace/db";
import { recomputeDegradedPredictions } from "../services/evaluation/degradedPredictionRecompute";
import { logger } from "../lib/logger";

export const DEGRADED_PREDICTION_RECOMPUTE_JOB_NAME = "degraded-prediction-recompute";

/** One retry pass for incomplete predictions; safe to run from a scheduler or the API process. */
export async function runDegradedPredictionRecomputeJob(): Promise<{ ok: boolean }> {
  const startedAt = new Date();
  try {
    const summary = await recomputeDegradedPredictions();
    await db.insert(jobRunsTable).values({
      jobName: DEGRADED_PREDICTION_RECOMPUTE_JOB_NAME,
      startedAt,
      finishedAt: new Date(),
      status: "success",
      attempts: 1,
      summary,
      errorMessage: null,
    });
    logger.info(summary, "degraded prediction recomputation completed");
    return { ok: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db.insert(jobRunsTable).values({
      jobName: DEGRADED_PREDICTION_RECOMPUTE_JOB_NAME,
      startedAt,
      finishedAt: new Date(),
      status: "failed",
      attempts: 1,
      summary: null,
      errorMessage,
    });
    logger.error({ err }, "degraded prediction recomputation failed");
    return { ok: false };
  }
}

if (process.env.DEGRADED_PREDICTION_RECOMPUTE_STANDALONE === "1") {
  runDegradedPredictionRecomputeJob().then(({ ok }) => process.exitCode = ok ? 0 : 1);
}
