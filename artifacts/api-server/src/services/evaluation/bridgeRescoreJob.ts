/**
 * Singleton job wrapper for runBridgeRescore.
 *
 * Runs asynchronously in the background — the bridge endpoint calls
 * startBridgeRescoreJob() and returns immediately while the rescore proceeds.
 * Callers poll status via getBridgeRescoreJobStatus() or inspect the job_runs
 * summary written by the bridge route handler.
 *
 * Architecture mirrors walkForwardJob.ts: one in-process singleton, no durable
 * queue. This is intentional — the rescore is expected to complete in < 5 min
 * for any realistic bridge correction set (< few hundred matches).
 */

import { logger } from "../../lib/logger";
import { runBridgeRescore, type BridgeRescoreResult } from "./bridgeRescore";

export type BridgeRescoreJobStatus =
  | { state: "idle" }
  | { state: "running"; startedAt: string; targetCount: number }
  | { state: "done"; startedAt: string; finishedAt: string; result: BridgeRescoreResult }
  | { state: "error"; startedAt: string; finishedAt: string; error: string };

let currentJob: BridgeRescoreJobStatus = { state: "idle" };

export function getBridgeRescoreJobStatus(): BridgeRescoreJobStatus {
  return currentJob;
}

export function startBridgeRescoreJob(
  matchIds: number[],
): { started: boolean; reason?: string } {
  if (currentJob.state === "running") {
    return { started: false, reason: "A bridge rescore is already in progress." };
  }
  if (matchIds.length === 0) {
    return { started: false, reason: "No matchIds to rescore." };
  }

  const startedAt = new Date().toISOString();
  currentJob = { state: "running", startedAt, targetCount: matchIds.length };

  // Intentionally not awaited — runs in the background inside this long-lived process.
  void runJob(startedAt, matchIds);

  return { started: true };
}

async function runJob(startedAt: string, matchIds: number[]): Promise<void> {
  try {
    const result = await runBridgeRescore(matchIds);
    currentJob = {
      state: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
    };
    logger.info(
      { scored: result.scored, failed: result.failed, notFound: result.notFound },
      "Bridge rescore job completed",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Bridge rescore job failed");
    currentJob = {
      state: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    };
  }
}
