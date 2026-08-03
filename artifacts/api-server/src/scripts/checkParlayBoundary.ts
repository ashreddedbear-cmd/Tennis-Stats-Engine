#!/usr/bin/env tsx
/**
 * checkParlayBoundary.ts — Task #111
 *
 * Enforces the architectural separation between the Parlay Builder and the
 * Prediction Engine. The Parlay Builder (src/services/parlayBuilder/) must NEVER
 * import from the Prediction Engine (src/services/predictionEngine/) or reference
 * its DB tables (evaluation_predictions, calibration_models, saved_cards,
 * evaluation_runs).  This prevents the "independent validation" guarantee from
 * being silently broken by future edits, including AI-assisted ones.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/checkParlayBoundary.ts
 *
 * Exit code 0 = clean, exit code 1 = violations found.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PARLAY_DIR = join(__dirname, "../services/parlayBuilder");

// Patterns that must NOT appear in non-comment, non-test lines inside parlayBuilder/.
// Each entry is [pattern, humanReadableReason].
const FORBIDDEN: Array<[RegExp, string]> = [
  [/from\s+['"].*predictionEngine['"]/,          "import from predictionEngine/"],
  [/from\s+['"].*\/predictionEngine\//,          "import from predictionEngine/"],
  [/require\(['"].*predictionEngine['"]\)/,       "require() from predictionEngine/"],
  [/evaluationPredictionsTable/,                 "direct reference to evaluationPredictionsTable"],
  [/calibrationModelsTable/,                     "direct reference to calibrationModelsTable"],
  [/historicalMatchesTable/,                     "direct reference to historicalMatchesTable"],
  [/savedCardsTable/,                            "direct reference to savedCardsTable"],
  [/evaluationRunsTable/,                        "direct reference to evaluationRunsTable"],
];

function getAllTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...getAllTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations: string[] = [];

for (const file of getAllTsFiles(PARLAY_DIR)) {
  const rel = relative(process.cwd(), file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // Skip pure comment lines (single-line // or block * comments)
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // Skip strings that mention predictionEngine only as a doc reference inside a comment
    const commentStart = line.indexOf("//");
    const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;

    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(codePart)) {
        violations.push(`  ${rel}:${i + 1}  (${reason})\n    ${line.trim()}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("❌  Parlay Builder import-boundary violations:");
  console.error(violations.join("\n\n"));
  console.error(`\n${violations.length} violation(s) detected. Fix before committing.`);
  process.exit(1);
}

console.log("✓  Parlay Builder import boundary is clean — no predictionEngine imports or DB table references found.");
process.exit(0);
