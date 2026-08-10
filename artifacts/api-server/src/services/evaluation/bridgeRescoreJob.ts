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
import { db, jobRunsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { runBridgeRescore, type BridgeRescoreResult } from "./bridgeRescore";

export const BRIDGE_RESCORE_JOB_NAME = "bridge-rescore";

export interface BridgeRescoreJobPersistence {
  createRun(startedAt: Date): Promise<number>;
  finishRun(runId: number, update: { status: "done" | "error"; finishedAt: Date; rowsRescored: number; errorMessage: string | null }): Promise<void>;
}

const persistence: BridgeRescoreJobPersistence = {
  async createRun(startedAt) {
    const [run] = await db.insert(jobRunsTable).values({
      jobName: BRIDGE_RESCORE_JOB_NAME,
      startedAt,
      finishedAt: sql`NULL`, // column is nullable; sql`NULL` satisfies the required-field insert type
      status: "running",
      attempts: 1,
      summary: { rowsRescored: 0 },
      errorMessage: null,
    }).returning({ id: jobRunsTable.id });
    return run.id;
  },
  async finishRun(runId, update) {
    await db.update(jobRunsTable).set({
      status: update.status,
      finishedAt: update.finishedAt,
      summary: { rowsRescored: update.rowsRescored },
      errorMessage: update.errorMessage,
    }).where(eq(jobRunsTable.id, runId));
  },
};

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
  void runBridgeRescoreJob(matchIds, runBridgeRescore, persistence, startedAt);

  return { started: true };
}

export async function runBridgeRescoreJob(
  matchIds: number[],
  rescore: (matchIds: number[]) => Promise<BridgeRescoreResult> = runBridgeRescore,
  jobPersistence: BridgeRescoreJobPersistence = persistence,
  startedAt = new Date().toISOString(),
): Promise<void> {
  const runId = await jobPersistence.createRun(new Date(startedAt));

  try {
    const result = await rescore(matchIds);
    const finishedAt = new Date();
    await jobPersistence.finishRun(runId, {
      status: "done",
      finishedAt,
      rowsRescored: result.scored,
      errorMessage: null,
    });
    currentJob = {
      state: "done",
      startedAt,
      finishedAt: finishedAt.toISOString(),
      result,
    };
    logger.info(
      { scored: result.scored, failed: result.failed, notFound: result.notFound },
      "Bridge rescore job completed",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    await jobPersistence.finishRun(runId, {
      status: "error",
      finishedAt,
      rowsRescored: 0,
      errorMessage: message,
    });
    logger.error({ err }, "Bridge rescore job failed");
    currentJob = {
      state: "error",
      startedAt,
      finishedAt: finishedAt.toISOString(),
      error: message,
    };
  }
}
