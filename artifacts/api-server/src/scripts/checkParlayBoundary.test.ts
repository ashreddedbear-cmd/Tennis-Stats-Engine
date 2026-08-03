/**
 * Boundary check tests (Task #111).
 *
 * Verifies that checkParlayBoundary.ts:
 *   1. Passes cleanly on the actual codebase (no violations exist today).
 *   2. Catches a deliberate predictionEngine import injected for the test.
 *   3. Catches a deliberate DB table reference injected for the test.
 *
 * These tests write and immediately delete a temporary file inside
 * src/services/parlayBuilder/ for case 2 & 3 — cleanup runs in t.after()
 * so it is guaranteed even on assertion failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// api-server package root: src/scripts/ → src/ → api-server/ (2 levels up)
const API_SERVER_DIR = join(__dirname, "../..");
// tsx binary is in the api-server's own node_modules (not workspace root)
const TSX_BIN        = join(API_SERVER_DIR, "node_modules/.bin/tsx");
const PARLAY_DIR     = join(__dirname, "../services/parlayBuilder");

function runCheck(): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX_BIN, ["src/scripts/checkParlayBoundary.ts"], {
      cwd: API_SERVER_DIR,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("checkParlayBoundary: clean codebase passes with exit code 0", () => {
  const { ok, stdout } = runCheck();
  assert.equal(ok, true, `Expected boundary check to pass on the clean codebase. stdout: ${stdout}`);
  assert.ok(stdout.includes("✓"), "Expected ✓ in output for a clean check");
});

test("checkParlayBoundary: catches a deliberate predictionEngine import (Task #111 regression guard)", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_import.ts");
  writeFileSync(
    violatingFile,
    `// Deliberate violation for testing\nimport { computeRecommendation } from "../predictionEngine/recommendation";\n`,
  );
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when a predictionEngine import is present");
  const combined = stdout + stderr;
  assert.ok(
    combined.includes("predictionEngine") || combined.includes("violation"),
    `Expected output to mention the violation. Got: ${combined.slice(0, 400)}`,
  );
});

test("checkParlayBoundary: catches a deliberate evaluationPredictionsTable reference (Task #111 regression guard)", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_table.ts");
  writeFileSync(
    violatingFile,
    `// Deliberate table reference violation\nconst t = evaluationPredictionsTable.runKind;\n`,
  );
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when evaluationPredictionsTable is referenced");
});
