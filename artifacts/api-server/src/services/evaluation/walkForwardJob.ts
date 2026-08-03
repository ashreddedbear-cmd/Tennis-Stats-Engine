/**
 * Async job wrapper for the walk-forward evaluation.
 *
 * Walk-forward runs take 8–12+ minutes, far beyond any HTTP proxy timeout.
 * Pattern: POST returns immediately with { started }, frontend polls GET /status.
 * Identical architecture to ablationJob.ts — see that file for the rationale.
 */

import { logger } from "../../lib/logger";
import { runWalkForwardEvaluation, type WalkForwardSummary } from "./walkForward";

export type WalkForwardJobStatus =
  | { state: "idle" }
  | { state: "running"; startedAt: string; evaluationOnly: boolean; matchesScored: number }
  | { state: "done"; startedAt: string; finishedAt: string; evaluationOnly: boolean; result: WalkForwardSummary }
  | { state: "error"; startedAt: string; finishedAt: string; evaluationOnly: boolean; error: string };

let currentJob: WalkForwardJobStatus = { state: "idle" };

// Simple in-process counter updated by the walk-forward progress callback.
let _matchesScored = 0;

export function getWalkForwardJobStatus(): WalkForwardJobStatus {
  return currentJob;
}

export function startWalkForwardJob(opts: {
  foldCount?: number;
  evaluationOnly?: boolean;
  /** Scope the run to specific historical_matches.id values (integer PKs). */
  matchIds?: number[];
}): { started: boolean; reason?: string } {
  if (currentJob.state === "running") {
    return { started: false, reason: "A walk-forward run is already in progress." };
  }

  const startedAt = new Date().toISOString();
  const evaluationOnly = opts.evaluationOnly ?? true;
  _matchesScored = 0;

  currentJob = { state: "running", startedAt, evaluationOnly, matchesScored: 0 };

  // Intentionally not awaited — job runs in the background inside this long-lived server process.
  void runJob(startedAt, evaluationOnly, opts);

  return { started: true };
}

async function runJob(
  startedAt: string,
  evaluationOnly: boolean,
  opts: { foldCount?: number; evaluationOnly?: boolean; matchIds?: number[] },
): Promise<void> {
  try {
    const result = await runWalkForwardEvaluation(opts);

    currentJob = {
      state: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      evaluationOnly,
      result,
    };
    logger.info({ foldsRun: result.foldsRun }, "Walk-forward job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Walk-forward job failed");
    currentJob = {
      state: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      evaluationOnly,
      error: message,
    };
  }
}
