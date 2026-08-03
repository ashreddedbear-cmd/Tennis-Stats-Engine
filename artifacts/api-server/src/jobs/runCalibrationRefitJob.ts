/**
 * Standalone entrypoint for refitting the live probability calibration model, decoupled from the
 * long-lived API server process (`src/index.ts`) -- same pattern as `runPaperTradingJob.ts`. This
 * script runs one walk-forward evaluation cycle to completion (which re-fits and activates the
 * pooled isotonic calibration model as its final step -- see `runWalkForwardEvaluation`) and
 * exits. It holds no timer and does not depend on any server process's uptime.
 *
 * Before this job existed, the only way to refresh the active calibration model was someone
 * manually calling `POST /evaluation/walk-forward/run` -- so the model could silently go stale
 * (or never exist at all on a fresh environment), leaving every live prediction on the
 * `calibrateProbability` dataQuality-shrink fallback indefinitely instead of the real,
 * outcome-fitted mapping.
 *
 * Intended run command for a Replit Scheduled Deployment: once daily (calibration only needs to
 * move as fast as new graded historical/paper-trading outcomes accumulate -- unlike paper trading's
 * 15-minute fixture-locking cadence, there is no benefit to refitting more often than that), pointed at:
 *
 *   CALIBRATION_REFIT_JOB_STANDALONE=1 node --enable-source-maps dist/jobs/runCalibrationRefitJob.mjs
 *
 * (built by the same `build.mjs` that produces `dist/index.mjs`; see package.json's
 * `job:calibration-refit` script for the equivalent local/dev invocation).
 *
 * Every attempt's outcome is written to `job_runs` before the process exits, so a run's result is
 * durable and inspectable via `GET /evaluation/calibration-refit/job-runs` regardless of which
 * process/host executed it -- a gap in successful rows, or a run that reports
 * `skippedNoEligibleMatches`, is the signal an operator (or future alerting integration, see the
 * paper-trading alerting task) can act on.
 *
 * Retries only guard against whole-run failures (e.g. a transient DB connection blip). A
 * "not enough historical matches yet" outcome is not an error -- it's recorded as a successful run
 * with `foldsRun: 0` so it's visible without being treated as a failure worth retrying.
 */
import { db, jobRunsTable, evaluationPredictionsTable, calibrationModelsTable } from "@workspace/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { runWalkForwardEvaluation, type WalkForwardSummary } from "../services/evaluation/walkForward";
import { logger } from "../lib/logger";
import { CALIBRATION_REFIT_JOB_NAME } from "./calibrationRefitJobName";

export { CALIBRATION_REFIT_JOB_NAME };

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [5_000, 30_000];

/**
 * Minimum number of newly-graded paper-trade or live evaluation_predictions that must exist
 * since the last calibration model was fitted before a training-mode refit is permitted.
 *
 * Root cause of calibration model #697 (99% prediction bug): a training-mode walk-forward
 * fired when the historical_matches store had very few rows, producing only 14 validation
 * points — far too few for a meaningful isotonic fit. The walkForward.ts training-mode guard
 * (eligible < 500) is the deeper safety net, but this job-level check prevents the run from
 * even starting when there is no new live signal to learn from.
 *
 * Why 500: paper-trade predictions are graded by the recurring paper-trading cycle. 500 new
 * graded rows since the last refit represents roughly 2–4 weeks of live paper-trading
 * activity at typical fixture volumes — enough new signal to justify refitting. On a fresh
 * environment with no prior calibration model, the first refit always runs (the guard only
 * applies when a previous model exists), so bootstrapping is unaffected.
 */
const MIN_NEW_GRADED_FOR_REFIT = 500;

/**
 * Returns the number of newly-graded paper-trade / live evaluation_predictions since the
 * most recently fitted calibration model, or null if no calibration model has ever been
 * fitted (first-run bootstrap — guard does not apply).
 */
export async function countNewGradedSinceLastRefit(): Promise<number | null> {
  // Use the currently-active model's fittedAt as the reference date.
  // Inactive rows (including degenerate models stored by a prior failed refit that was
  // blocked by the holdoutSampleSize quality gate) are intentionally excluded: an
  // inactive model was never deployed, so graded predictions written after its fittedAt
  // have already been counted as "new" relative to the last real deployed model.
  const [lastModel] = await db
    .select({ fittedAt: calibrationModelsTable.fittedAt })
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .orderBy(desc(calibrationModelsTable.fittedAt))
    .limit(1);

  if (!lastModel) {
    // No active calibration model — always allow the refit (bootstrap or recovery).
    return null;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(evaluationPredictionsTable)
    .where(
      and(
        inArray(evaluationPredictionsTable.runKind, ["paper_trade", "live"]),
        eq(evaluationPredictionsTable.status, "graded"),
        gt(evaluationPredictionsTable.gradedAt, lastModel.fittedAt),
      ),
    );

  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(): Promise<
  | { attempts: number; summary: WalkForwardSummary }
  | { attempts: number; skipped: true; reason: string }
  | { attempts: number; error: unknown }
> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Guard: only run training-mode walk-forward when enough new graded live
      // predictions have accumulated since the last refit. This prevents the recurring
      // refit job from creating degenerate calibration noise rows (inactive models that
      // never serve predictions but pollute calibration_models) when the paper-trading
      // pipeline is idle or the historical store is sparse.
      //
      // The check is inside the retry loop so a transient DB error on the first attempt
      // does not silently bypass it on retry. The guard is a fast read-only query
      // (indexed on runKind + status + gradedAt) and retrying it is safe.
      const newGradedCount = await countNewGradedSinceLastRefit();
      if (newGradedCount !== null && newGradedCount < MIN_NEW_GRADED_FOR_REFIT) {
        const reason = `only ${newGradedCount} new graded predictions since last refit (min ${MIN_NEW_GRADED_FOR_REFIT})`;
        logger.info({ newGradedCount, min: MIN_NEW_GRADED_FOR_REFIT }, "Calibration-refit skipped: not enough new graded predictions since last model was fitted");
        return { attempts: attempt, skipped: true, reason };
      }

      const summary = await runWalkForwardEvaluation();
      return { attempts: attempt, summary };
    } catch (err) {
      lastError = err;
      logger.error({ err, attempt, maxAttempts: MAX_ATTEMPTS }, "Calibration-refit run attempt failed");
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      }
    }
  }
  return { attempts: MAX_ATTEMPTS, error: lastError };
}

export async function runCalibrationRefitJob(): Promise<{ ok: boolean }> {
  const startedAt = new Date();
  const outcome = await runWithRetry();
  const finishedAt = new Date();

  if ("summary" in outcome) {
    await db.insert(jobRunsTable).values({
      jobName: CALIBRATION_REFIT_JOB_NAME,
      startedAt,
      finishedAt,
      status: "success",
      attempts: outcome.attempts,
      summary: outcome.summary,
      errorMessage: null,
    });
    logger.info({ ...outcome.summary, attempts: outcome.attempts }, "Calibration refit completed");
    return { ok: true };
  }

  if ("skipped" in outcome) {
    // Not an error — the guard determined there isn't enough new signal to justify a refit.
    // Record a success row so the job-run history stays continuous and the skip is visible
    // to operators via GET /evaluation/calibration-refit/job-runs without a log search.
    await db.insert(jobRunsTable).values({
      jobName: CALIBRATION_REFIT_JOB_NAME,
      startedAt,
      finishedAt,
      status: "success",
      attempts: outcome.attempts,
      summary: { skipped: true, reason: outcome.reason },
      errorMessage: null,
    });
    logger.info({ reason: outcome.reason }, "Calibration-refit job recorded as skipped");
    return { ok: true };
  }

  const errorMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  await db.insert(jobRunsTable).values({
    jobName: CALIBRATION_REFIT_JOB_NAME,
    startedAt,
    finishedAt,
    status: "failed",
    attempts: outcome.attempts,
    summary: null,
    errorMessage,
  });
  logger.error({ err: outcome.error, attempts: outcome.attempts }, "Calibration refit failed after exhausting retries");
  return { ok: false };
}

// Only run when invoked directly via the standalone CLI (e.g. `pnpm run job:calibration-refit`),
// not when imported as a module -- an explicit env var, not an `import.meta.url`/`process.argv[1]`
// comparison, because `build.mjs` bundles each esbuild entry point independently: if this file's
// code were ever imported into another entry point (as happened with `runPaperTradingJob.ts` and
// `dist/index.mjs`), that comparison would false-match inside the *other* bundle and call
// `process.exit()` there too. See `runPaperTradingJob.ts` for the incident this mirrors.
if (process.env["CALIBRATION_REFIT_JOB_STANDALONE"] === "1") {
  runCalibrationRefitJob()
    .then(({ ok }) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      logger.error({ err }, "Unhandled error running calibration-refit job");
      process.exit(1);
    });
}
