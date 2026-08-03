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
import { db, jobRunsTable } from "@workspace/db";
import { runWalkForwardEvaluation, type WalkForwardSummary } from "../services/evaluation/walkForward";
import { logger } from "../lib/logger";
import { CALIBRATION_REFIT_JOB_NAME } from "./calibrationRefitJobName";

export { CALIBRATION_REFIT_JOB_NAME };

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [5_000, 30_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(): Promise<{ attempts: number; summary: WalkForwardSummary } | { attempts: number; error: unknown }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Never rely on walk-forward defaults here: this job exists specifically to REFIT
      // calibration, so evaluationOnly must be explicitly false.
      const summary = await runWalkForwardEvaluation({ evaluationOnly: false });
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
