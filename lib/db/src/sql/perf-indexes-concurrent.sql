-- Task #154: Performance indexes on historical_matches
--
-- These indexes cover the two query shapes that were full-table scans:
--   1. H2H lookup: WHERE (player1_id = $1 AND player2_id = $2) OR reversed
--   2. Surface-filtered recent form: WHERE player1_id = $1 AND surface = $2 ORDER BY scheduled_start_at
--
-- Using CREATE INDEX CONCURRENTLY so the table is never locked during deployment.
-- IF NOT EXISTS makes every statement idempotent — safe to re-run on every push.
--
-- NOTE: CONCURRENTLY cannot run inside a transaction block.
-- applySqlExtras.ts therefore runs each semicolon-delimited statement in its own
-- pool.query() call (not in a single multi-statement query).

CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p1_p2_surface_idx
  ON historical_matches (player1_id, player2_id, surface);

CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p2_p1_surface_idx
  ON historical_matches (player2_id, player1_id, surface);

CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p1_surface_date_idx
  ON historical_matches (player1_id, surface, scheduled_start_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS historical_matches_p2_surface_date_idx
  ON historical_matches (player2_id, surface, scheduled_start_at);
