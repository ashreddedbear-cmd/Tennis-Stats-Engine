/**
 * Task #154: persistent Monte Carlo simulator worker thread.
 *
 * Receives { servicePointEstimate, matchFormat, options } via parentPort.postMessage(),
 * runs runMatchSimulation() synchronously on the worker thread (off the main event loop),
 * and posts the MatchSimulationResult back.  One worker is kept alive for the entire server
 * process lifetime so there is no per-request spawn overhead.
 *
 * This file is compiled as a separate esbuild entry point (see build.mjs) so the main bundle
 * can reference it by path using __dirname (set by the esbuild banner).
 */

import { parentPort } from "worker_threads";
import { runMatchSimulation } from "./simulator.js";
import type { ServicePointEstimate, RunSimulationOptions } from "./simulator.js";
import type { MatchFormat } from "../tennisData/types.js";

if (!parentPort) {
  throw new Error("simulatorWorker must be run as a worker_threads Worker, not as a standalone process");
}

export interface SimulatorWorkerRequest {
  id: number;
  servicePointEstimate: ServicePointEstimate;
  matchFormat: MatchFormat;
  options: RunSimulationOptions;
}

export interface SimulatorWorkerResponse {
  id: number;
  result: ReturnType<typeof runMatchSimulation>;
}

parentPort.on("message", (req: SimulatorWorkerRequest) => {
  const result = runMatchSimulation(req.servicePointEstimate, req.matchFormat, req.options);
  const response: SimulatorWorkerResponse = { id: req.id, result };
  parentPort!.postMessage(response);
});
