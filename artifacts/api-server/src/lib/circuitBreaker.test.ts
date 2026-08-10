/**
 * Circuit-breaker invariant tests — #98
 *
 * Proves that the generic CircuitBreaker:
 *   1. Stays CLOSED while failures are below threshold
 *   2. Opens after failureThreshold failures
 *   3. Fast-fails (never calls the backend fn) once OPEN — this is the critical
 *      property that prevents MatchStat timeouts from cascading when the provider
 *      is down.  Before the circuit breaker existed, every call would wait out the
 *      full HTTP timeout; the breaker short-circuits this after the threshold.
 *   4. Each instance has independent state (breakers don't bleed into each other)
 *
 * No mocking needed — CircuitBreaker is a pure in-process class.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";

// Helper: fire n failures through a breaker without surfacing the errors.
async function driveFailures(cb: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      await cb.execute(async () => { throw new Error("simulated provider failure"); });
    } catch {
      // expected
    }
  }
}

describe("CircuitBreaker — state transitions and fast-fail", () => {
  it("stays CLOSED while failures are below the threshold", async () => {
    const cb = new CircuitBreaker("test-below-threshold", {
      failureThreshold: 3,
      openDurationMs: 60_000,
      windowMs: 60_000,
    });

    await driveFailures(cb, 2); // threshold is 3 — stays closed

    assert.strictEqual(
      cb.currentState,
      "CLOSED",
      "Breaker must remain CLOSED when failure count has not reached failureThreshold",
    );
  });

  it("transitions to OPEN after exactly failureThreshold failures", async () => {
    const cb = new CircuitBreaker("test-opens-at-threshold", {
      failureThreshold: 3,
      openDurationMs: 60_000,
      windowMs: 60_000,
    });

    await driveFailures(cb, 3);

    assert.strictEqual(
      cb.currentState,
      "OPEN",
      "Breaker must be OPEN after failureThreshold (3) consecutive failures",
    );
  });

  it("fast-fails without invoking the backend function once OPEN", async () => {
    // This is the core invariant: once the breaker is open, the backend is never
    // called — the caller gets a CircuitOpenError immediately.  This is what
    // prevents MatchStat 12 s timeouts from stacking when the provider is down.
    const cb = new CircuitBreaker("test-fast-fail", {
      failureThreshold: 3,
      openDurationMs: 60_000,
      windowMs: 60_000,
    });

    await driveFailures(cb, 3);
    assert.strictEqual(cb.currentState, "OPEN");

    let backendInvoked = false;
    let thrownError: unknown;

    try {
      await cb.execute(async () => {
        backendInvoked = true;
        return "should-never-be-reached";
      });
    } catch (err) {
      thrownError = err;
    }

    assert.strictEqual(
      backendInvoked,
      false,
      "Backend function must NOT be called when the circuit breaker is OPEN — " +
      "calling it would defeat the purpose of the breaker and re-expose the timeout",
    );
    assert.ok(
      thrownError instanceof CircuitOpenError,
      `Expected CircuitOpenError to be thrown, got: ${String(thrownError)}`,
    );
    assert.ok(
      (thrownError as CircuitOpenError).message.includes("test-fast-fail"),
      "CircuitOpenError message should identify the breaker by name so callers can log it",
    );
  });

  it("each CircuitBreaker instance maintains independent state", async () => {
    // Regression guard: the module-level registry must not let one breaker's
    // open state bleed into another.  This matters because matchstat uses its
    // own named instance while api-tennis-live and api-tennis-bulk each have
    // their own (Task #API-Tennis split circuit breaker).
    const cbA = new CircuitBreaker("test-isolated-a", { failureThreshold: 3 });
    const cbB = new CircuitBreaker("test-isolated-b", { failureThreshold: 3 });

    await driveFailures(cbA, 3); // open A

    assert.strictEqual(cbA.currentState, "OPEN");
    assert.strictEqual(
      cbB.currentState,
      "CLOSED",
      "Opening cbA must not affect cbB — breaker instances are independent",
    );
  });

  it("a successful call after opening resets the breaker to CLOSED via HALF_OPEN", async () => {
    // Verify the recovery path: after openDurationMs elapses the breaker probes
    // once (HALF_OPEN), a successful probe closes it again.
    // openDurationMs=0 means tick() transitions OPEN→HALF_OPEN immediately, so
    // we do not assert the OPEN state here (that's covered by the test above) —
    // we drive failures, then issue one successful execute() and confirm CLOSED.
    const cb = new CircuitBreaker("test-half-open-recovery", {
      failureThreshold: 2,
      openDurationMs: 0, // instant transition to HALF_OPEN for test speed
      windowMs: 60_000,
    });

    await driveFailures(cb, 2);
    // With openDurationMs=0, the next execute() call finds the breaker in
    // HALF_OPEN (tick() transitions it on entry) — a successful probe closes it.
    const result = await cb.execute(async () => "probe-success");
    assert.strictEqual(result, "probe-success");
    assert.strictEqual(
      cb.currentState,
      "CLOSED",
      "Successful probe in HALF_OPEN state must close the breaker",
    );
  });
});
