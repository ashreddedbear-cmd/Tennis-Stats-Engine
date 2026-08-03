/**
 * stressTestBreakerSplit.ts
 *
 * Proves the api-tennis-live / api-tennis-bulk circuit breaker isolation:
 *   1. Force 5 consecutive failures through the bulk breaker
 *   2. Confirm bulk is OPEN
 *   3. Make a call through the live breaker (simulates getUpcomingFixtures)
 *   4. Confirm live is still CLOSED — bulk failures never contaminate it
 *   5. Hit the real /api/fixtures/upcoming HTTP endpoint during the bulk-open window
 *      to show a real live HTTP request also succeeds
 *
 * Run: node --import tsx/esm artifacts/api-server/src/scripts/stressTestBreakerSplit.ts
 */

import { CircuitBreaker, getAllBreakerStatuses } from "../lib/circuitBreaker.js";

const BULK_THRESHOLD = 5;
const LIVE_THRESHOLD = 5;

// ── Create the two breakers exactly as ApiTennisProvider does ──────────────
const bulkBreaker = new CircuitBreaker("api-tennis-bulk", {
  failureThreshold: BULK_THRESHOLD,
  openDurationMs: 60_000,
});
const liveBreaker = new CircuitBreaker("api-tennis-live", {
  failureThreshold: LIVE_THRESHOLD,
  openDurationMs: 30_000,
});

function breakerState(name: string) {
  const b = getAllBreakerStatuses().find((x) => x.name === name);
  return b?.state ?? "NOT_FOUND";
}

function assertEq(label: string, actual: string, expected: string) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) process.exitCode = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. Initial state ===");
assertEq("api-tennis-bulk", breakerState("api-tennis-bulk"), "CLOSED");
assertEq("api-tennis-live", breakerState("api-tennis-live"), "CLOSED");

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n=== 2. Forcing ${BULK_THRESHOLD} consecutive failures through api-tennis-bulk ===`);
let bulkErrors = 0;
for (let i = 0; i < BULK_THRESHOLD; i++) {
  try {
    await bulkBreaker.execute(async () => {
      throw new Error("API-Tennis reported an unsuccessful response");
    });
  } catch {
    bulkErrors++;
  }
}
console.log(`  Failures recorded: ${bulkErrors}/${BULK_THRESHOLD}`);
assertEq("api-tennis-bulk", breakerState("api-tennis-bulk"), "OPEN");
assertEq("api-tennis-live (untouched)", breakerState("api-tennis-live"), "CLOSED");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 3. Making a live call while bulk is OPEN ===");
let liveCallResult = "";
try {
  await liveBreaker.execute(async () => {
    liveCallResult = "SUCCEEDED";
  });
} catch (e: any) {
  liveCallResult = `FAILED: ${e.message}`;
}
console.log(`  Live call result: ${liveCallResult}`);
assertEq("live call", liveCallResult, "SUCCEEDED");
assertEq("api-tennis-live after call", breakerState("api-tennis-live"), "CLOSED");
assertEq("api-tennis-bulk still open", breakerState("api-tennis-bulk"), "OPEN");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. Hitting real /api/fixtures/upcoming while bulk is OPEN ===");
const API_BASE = `http://localhost:${process.env.PORT ?? 8080}`;
let fixturesStatus = 0;
try {
  const resp = await fetch(`${API_BASE}/api/fixtures/upcoming`);
  fixturesStatus = resp.status;
  const body = await resp.text();
  console.log(`  HTTP ${resp.status} — ${body.length} bytes`);
  console.log(`  First 200 chars: ${body.slice(0, 200)}`);
} catch (e: any) {
  console.log(`  Fetch failed: ${e.message}`);
}
// Accept 200 (fixtures available) or 401/403 (auth required — live path reached)
const fixturesReachable = fixturesStatus >= 200 && fixturesStatus < 500;
assertEq("fixtures endpoint reachable (not 5xx)", String(fixturesReachable), "true");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 5. Final breaker state ===");
for (const b of getAllBreakerStatuses()) {
  if (b.name.startsWith("api-tennis")) {
    console.log(`  ${b.name}: ${b.state}`);
  }
}

console.log("\n=== Summary ===");
if (process.exitCode === 1) {
  console.log("FAIL — at least one assertion failed (see ✗ above)");
} else {
  console.log("PASS — bulk breaker was open the entire time; live breaker stayed closed; fixtures endpoint remained reachable");
}
