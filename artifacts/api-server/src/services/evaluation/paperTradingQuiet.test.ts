/**
 * Unit tests for the pipeline-quiet alert logic (Task #110).
 * Pure function — no DB access required.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPipelineQuiet, PAPER_TRADE_QUIET_WINDOW_HOURS } from "./paperTradingQuiet";

const WINDOW = PAPER_TRADE_QUIET_WINDOW_HOURS;

test("isPipelineQuiet: null lastRunAt (never run) is always quiet", () => {
  assert.equal(isPipelineQuiet(null, WINDOW), true);
});

test("isPipelineQuiet: fires when last run is older than the quiet window", () => {
  const pastWindow = new Date(Date.now() - (WINDOW + 1) * 60 * 60 * 1000);
  assert.equal(isPipelineQuiet(pastWindow, WINDOW), true);
});

test("isPipelineQuiet: does NOT fire when last run is within the quiet window", () => {
  const withinWindow = new Date(Date.now() - (WINDOW - 1) * 60 * 60 * 1000);
  assert.equal(isPipelineQuiet(withinWindow, WINDOW), false);
});

test("isPipelineQuiet: does NOT fire for a very recent run (seconds ago)", () => {
  const justNow = new Date(Date.now() - 30_000); // 30 seconds ago
  assert.equal(isPipelineQuiet(justNow, WINDOW), false);
});

test("isPipelineQuiet: respects a custom quietWindowHours parameter", () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  assert.equal(isPipelineQuiet(oneHourAgo, 0.5), true,  "0.5h window: 1h-old run should be quiet");
  assert.equal(isPipelineQuiet(oneHourAgo, 2),   false, "2h window:   1h-old run should NOT be quiet");
});

test("isPipelineQuiet: exactly at the boundary is NOT quiet (strict greater-than)", () => {
  const exact = new Date(Date.now() - WINDOW * 60 * 60 * 1000);
  // hoursSince === WINDOW → NOT quiet (we use > not >=)
  assert.equal(isPipelineQuiet(exact, WINDOW), false);
});
