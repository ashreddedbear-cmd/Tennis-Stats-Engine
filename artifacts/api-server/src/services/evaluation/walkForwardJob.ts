/**
 * Async job wrapper for the walk-forward evaluation.
 *
 * Walk-forward runs take 8–12+ minutes, far beyond any HTTP proxy timeout.
 * Pattern: POST returns immediately with { started }, frontend polls GET /status.
 * Identical architecture to ablationJob.ts — see that file for the rationale.
 */

import { logger } from "../../lib/logger";
import { runWalkForwardEvaluation, type WalkForwardSummary } from "./walkForward";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type WalkForwardJobStatus =
  | { state: "idle" }
  | { state: "running"; startedAt: string; evaluationOnly: boolean; matchesScored: number; runUid: string }
  | { state: "done"; startedAt: string; finishedAt: string; evaluationOnly: boolean; result: WalkForwardSummary; runUid: string }
  | { state: "error"; startedAt: string; finishedAt: string; evaluationOnly: boolean; error: string; runUid: string };

let currentJob: WalkForwardJobStatus = { state: "idle" };
const PROCESS_STARTED_AT = new Date();
const STALE_RESTART_ROW_CLEAR_THRESHOLD = 25;

// Simple in-process counter updated by the walk-forward progress callback.
let _matchesScored = 0;

export function getWalkForwardJobStatus(): WalkForwardJobStatus {
  return currentJob;
}

async function getHistoricalTestPredictionCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n
    from evaluation_predictions
    where run_kind = 'historical_test'
  `);
  const rows = (result as { rows?: Array<{ n?: number }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function findStaleRunningRun(): Promise<{ id: number; startedAt: Date } | null> {
  const result = await db.execute(sql`
    select id, started_at
    from walk_forward_runs
    where status = 'running'
    order by created_at desc
    limit 1
  `);
  const rows = (result as { rows?: Array<{ id?: number; started_at?: Date | string }> }).rows ?? [];
  const row = rows[0];
  if (!row?.id || !row?.started_at) return null;
  const startedAt = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
  if (Number.isNaN(startedAt.getTime())) return null;
  // A "running" marker older than this process implies interruption by a prior restart.
  if (startedAt >= PROCESS_STARTED_AT) return null;
  return { id: Number(row.id), startedAt };
}

async function markInterruptedRun(runId: number, rowsAtInterruption: number): Promise<void> {
  await db.execute(sql`
    update walk_forward_runs
    set status = 'interrupted',
        finished_at = now(),
        checkpoint = coalesce(checkpoint, '{}'::jsonb) || jsonb_build_object(
          'interruptedByRestart', true,
          'rowsAtInterruption', ${rowsAtInterruption},
          'interruptedAt', now()
        )
    where id = ${runId}
  `);
}

async function insertRunningMarker(runUid: string, evaluationOnly: boolean, foldCount: number | null): Promise<void> {
  await db.execute(sql`
    insert into walk_forward_runs (
      run_uid,
      evaluation_only,
      status,
      fold_count,
      started_at,
      checkpoint
    ) values (
      ${runUid},
      ${evaluationOnly},
      'running',
      ${foldCount},
      now(),
      jsonb_build_object('processStartedAt', ${PROCESS_STARTED_AT.toISOString()})
    )
    on conflict (run_uid) do nothing
  `);
}

async function finalizeRunMarker(runUid: string, status: "done" | "error", details: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    update walk_forward_runs
    set status = ${status},
        finished_at = now(),
        checkpoint = coalesce(checkpoint, '{}'::jsonb) || ${JSON.stringify(details)}::jsonb
    where run_uid = ${runUid}
  `);
}

export async function startWalkForwardJob(opts: {
  foldCount?: number;
  evaluationOnly?: boolean;
}): Promise<{ started: boolean; reason?: string }> {
  if (currentJob.state === "running") {
    return { started: false, reason: "A walk-forward run is already in progress." };
  }

  const staleRun = await findStaleRunningRun();
  if (staleRun) {
    const rowCount = await getHistoricalTestPredictionCount();
    if (rowCount > STALE_RESTART_ROW_CLEAR_THRESHOLD) {
      return {
        started: false,
        reason:
          `Detected prior walk-forward interruption after restart (run id ${staleRun.id}). ` +
          `historical_test row count is still ${rowCount} (expected near zero <= ${STALE_RESTART_ROW_CLEAR_THRESHOLD}) before re-triggering. ` +
          `Confirm the interrupted corpus has been cleared/rolled over first, then retry.`,
      };
    }
    await markInterruptedRun(staleRun.id, rowCount);
  }

  const startedAt = new Date().toISOString();
  const evaluationOnly = opts.evaluationOnly ?? true;
  const runUid = `wf-${randomUUID()}`;
  _matchesScored = 0;

  await insertRunningMarker(runUid, evaluationOnly, opts.foldCount ?? null);

  currentJob = { state: "running", startedAt, evaluationOnly, matchesScored: 0, runUid };

  // Intentionally not awaited — job runs in the background inside this long-lived server process.
  void runJob(startedAt, evaluationOnly, runUid, opts);

  return { started: true };
}

async function runJob(
  startedAt: string,
  evaluationOnly: boolean,
  runUid: string,
  opts: { foldCount?: number; evaluationOnly?: boolean },
): Promise<void> {
  try {
    const result = await runWalkForwardEvaluation(opts);
    const rowsWritten = await getHistoricalTestPredictionCount();

    await finalizeRunMarker(runUid, "done", {
      evaluationOnly,
      foldsRun: result.foldsRun,
      skippedNoEligibleMatches: result.skippedNoEligibleMatches,
      rowsWritten,
      fallbackRate: result.fallbackRate,
      warnings: result.warnings,
    });

    currentJob = {
      state: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      evaluationOnly,
      result,
      runUid,
    };
    logger.info({ foldsRun: result.foldsRun }, "Walk-forward job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Walk-forward job failed");
    await finalizeRunMarker(runUid, "error", { evaluationOnly, error: message });
    currentJob = {
      state: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      evaluationOnly,
      error: message,
      runUid,
    };
  }
}
