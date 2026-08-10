import test from "node:test";
import assert from "node:assert/strict";
import { runBridgeRescoreJob, type BridgeRescoreJobPersistence } from "./bridgeRescoreJob";

function makePersistence() {
  const writes: Array<{ status: string; rowsRescored: number; errorMessage: string | null }> = [];
  const persistence: BridgeRescoreJobPersistence = {
    async createRun() {
      return 42;
    },
    async finishRun(_runId, update) {
      writes.push(update);
    },
  };
  return { persistence, writes };
}

test("bridge rescore job writes done state with the rescored row count", async () => {
  const { persistence, writes } = makePersistence();

  await runBridgeRescoreJob(
    [1, 2],
    async () => ({ scored: 2, failed: 0, notFound: 0 }),
    persistence,
  );

  assert.deepEqual(writes.map(({ status, rowsRescored, errorMessage }) => ({ status, rowsRescored, errorMessage })), [
    { status: "done", rowsRescored: 2, errorMessage: null },
  ]);
});

test("bridge rescore job writes error state when rescoring throws", async () => {
  const { persistence, writes } = makePersistence();

  await runBridgeRescoreJob(
    [1],
    async () => { throw new Error("rescore failed"); },
    persistence,
  );

  assert.deepEqual(writes.map(({ status, rowsRescored, errorMessage }) => ({ status, rowsRescored, errorMessage })), [
    { status: "error", rowsRescored: 0, errorMessage: "rescore failed" },
  ]);
});