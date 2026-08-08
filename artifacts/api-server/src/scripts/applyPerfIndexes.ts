/**
 * Task #154: apply performance indexes to historical_matches.
 * Run with: pnpm exec tsx src/scripts/applyPerfIndexes.ts
 */
import { pool } from "@workspace/db";

async function main() {
  const client = await pool.connect();
  try {
    const indexes = [
      {
        name: "historical_matches_p1_p2_surface_idx",
        sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p1_p2_surface_idx ON historical_matches (player1_id, player2_id, surface)",
      },
      {
        name: "historical_matches_p2_p1_surface_idx",
        sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p2_p1_surface_idx ON historical_matches (player2_id, player1_id, surface)",
      },
      {
        name: "historical_matches_p1_surface_date_idx",
        sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p1_surface_date_idx ON historical_matches (player1_id, surface, scheduled_start_at)",
      },
      {
        name: "historical_matches_p2_surface_date_idx",
        sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p2_surface_date_idx ON historical_matches (player2_id, surface, scheduled_start_at)",
      },
    ];

    for (const idx of indexes) {
      console.log(`Creating index: ${idx.name} ...`);
      await client.query(idx.sql);
      console.log(`✓ ${idx.name}`);
    }

    console.log("All indexes applied.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
