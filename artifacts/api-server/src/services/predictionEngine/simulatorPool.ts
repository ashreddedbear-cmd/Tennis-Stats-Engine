/**
 * Task #154: persistent worker-thread pool for the Monte Carlo simulation.
 *
 * Maintains a single long-lived Worker that runs runMatchSimulation() off the main event loop.
 * Requests are queued and dispatched serially to the worker; in-flight promises are resolved
 * as responses arrive.
 *
 * Fallback: when the compiled worker file is not present (e.g. running under tsx directly in
 * tests / scripts), `runMatchSimulationAsync` falls back to the synchronous implementation
 * without error — it just runs on the main thread as before.
 */

import path from "path";
import { existsSync } from "fs";
import { Worker } from "worker_threads";
import { runMatchSimulation } from "./simulator.js";
import type { ServicePointEstimate, RunSimulationOptions, MatchSimulationResult } from "./simulator.js";
import type { MatchFormat } from "../tennisData/types.js";
import type { SimulatorWorkerRequest, SimulatorWorkerResponse } from "./simulatorWorker.js";

// -----------------------------------------------------------------------
// Worker path resolution
// -----------------------------------------------------------------------
// When compiled by esbuild, the banner injects `globalThis.__dirname` as
// the directory of the compiled bundle (e.g. .../dist/).  The worker is
// compiled as a separate entry point to .../dist/simulatorWorker.mjs.
// When running under tsx (tests / scripts), __dirname is not injected, so
// workerPath is null and we fall back to the synchronous implementation.
// -----------------------------------------------------------------------

function resolveWorkerPath(): string | null {
  // esbuild banner sets globalThis.__dirname; tsx does not.
  // The main bundle is compiled to dist/index.mjs, so __dirname is the dist/ directory.
  // The simulator worker is compiled as a separate entry point to
  // dist/services/predictionEngine/simulatorWorker.mjs — use that subdirectory path.
  const dir = (globalThis as Record<string, unknown>).__dirname;
  if (typeof dir !== "string") return null;
  const candidate = path.join(dir, "services", "predictionEngine", "simulatorWorker.mjs");
  return existsSync(candidate) ? candidate : null;
}

const workerPath = resolveWorkerPath();

let _worker: Worker | null = null;
let _nextId = 1;
const _pending = new Map<number, { resolve: (r: MatchSimulationResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (_worker) return _worker;

  if (!workerPath) {
    throw new Error("Simulator worker path is not available — this should never be called in fallback mode");
  }

  _worker = new Worker(workerPath);

  _worker.on("message", (response: SimulatorWorkerResponse) => {
    const pending = _pending.get(response.id);
    if (pending) {
      _pending.delete(response.id);
      pending.resolve(response.result);
    }
  });

  _worker.on("error", (err: unknown) => {
    // Reject all pending promises and tear down so the next call spawns a fresh worker.
    const msg = err instanceof Error ? err.message : String(err);
    for (const [id, { reject }] of _pending) {
      _pending.delete(id);
      reject(new Error(`Simulator worker error (request ${id}): ${msg}`));
    }
    _worker = null;
  });

  _worker.on("exit", (code) => {
    if (code !== 0) {
      for (const [id, { reject }] of _pending) {
        _pending.delete(id);
        reject(new Error(`Simulator worker exited with code ${code} (request ${id})`));
      }
    }
    _worker = null;
  });

  return _worker;
}

/**
 * Runs runMatchSimulation() in a persistent worker thread so the event loop stays responsive
 * during the 20,000-iteration Monte Carlo simulation.
 *
 * Falls back to the synchronous implementation when the compiled worker is not available
 * (tsx tests / scripts / fresh build environment).
 */
export async function runMatchSimulationAsync(
  servicePointEstimate: ServicePointEstimate,
  matchFormat: MatchFormat,
  options: RunSimulationOptions = {},
): Promise<MatchSimulationResult> {
  // Synchronous fallback for tsx / test environments.
  if (!workerPath) {
    return runMatchSimulation(servicePointEstimate, matchFormat, options);
  }

  const id = _nextId++;
  const req: SimulatorWorkerRequest = { id, servicePointEstimate, matchFormat, options };

  return new Promise<MatchSimulationResult>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(req);
    } catch (err) {
      _pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Gracefully terminates the persistent worker. Call on server shutdown if desired. */
export function terminateSimulatorWorker(): Promise<number> {
  if (!_worker) return Promise.resolve(0);
  const w = _worker;
  _worker = null;
  return w.terminate();
}
