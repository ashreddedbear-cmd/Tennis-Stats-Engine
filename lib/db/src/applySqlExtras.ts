import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Applies raw SQL that drizzle-kit's schema-diff push cannot express (functions,
 * triggers, concurrent indexes). Idempotent -- every file here is safe to re-run on
 * every push. Run automatically after `drizzle-kit push` via the `push`/`push-force`
 * scripts.
 *
 * Files listed in `regularFiles` are applied as a single pool.query() call each.
 *
 * Files listed in `concurrentIndexFiles` are split on `;` and each non-empty
 * statement is applied as its own pool.query() call, because CREATE INDEX CONCURRENTLY
 * cannot run inside a transaction block.
 */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }

  const dir = path.dirname(fileURLToPath(import.meta.url));

  // Standard files — applied as single pool.query() each (safe inside auto-transaction).
  const regularFiles = [
    "sql/immutability-trigger.sql",
    "sql/predictions-forward-compat.sql",
  ];

  // Files whose statements must run one-by-one outside any transaction block.
  // Used for CREATE INDEX CONCURRENTLY which Postgres forbids inside a transaction.
  const concurrentIndexFiles = [
    "sql/perf-indexes-concurrent.sql",
  ];

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const file of regularFiles) {
      const sql = readFileSync(path.join(dir, file), "utf-8");
      console.log(`Applying ${file}...`);
      await pool.query(sql);
    }

    for (const file of concurrentIndexFiles) {
      const sql = readFileSync(path.join(dir, file), "utf-8");
      // Split on `;`, strip comment-only lines and blank lines, run each statement separately.
      const statements = sql
        .split(";")
        .map((s) => s.replace(/--[^\n]*/g, "").trim())
        .filter((s) => s.length > 0);

      console.log(`Applying ${file} (${statements.length} statements individually)...`);
      for (const stmt of statements) {
        await pool.query(stmt);
      }
    }

    console.log("SQL extras applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
