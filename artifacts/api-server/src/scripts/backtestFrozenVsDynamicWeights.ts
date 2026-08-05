/**
 * Compare frozen-weight vs dynamic-weight accuracy on
 * the same historical test cohort.
 *
 * Data source:
 * evaluation_predictions where
 *   run_kind='historical_test'
 *   segment='test'
 *   included_in_accuracy=true
 *   actual_winner_id is not null
 *
 * Cohort split:
 *   frozen-weight  = optimizer_run_id IS NULL
 *   dynamic-weight = optimizer_run_id IS NOT NULL
 *
 * To keep an apples-to-apples comparison, the script
 * intersects by historical_match_id and
 * keeps one latest row per cohort per match before
 * joining.
 *
 * Usage:
 * pnpm --filter @workspace/api-server exec tsx src/scripts/backtestFrozenVsDynamicWeights.ts
 */

import { pool } from "@workspace/db";

interface JoinedRow {
  historical_match_id: number;
  actual_winner_id: string;
  frozen_predicted_winner_id: string;
  dynamic_predicted_winner_id: string;
}

interface CountRow {
  frozen_rows: string;
  dynamic_rows: string;
  frozen_distinct_matches: string;
  dynamic_distinct_matches: string;
  intersected_matches: string;
}

async function main(): Promise<void> {
  const countsSql = `
WITH base AS (
  SELECT
    id,
    historical_match_id,
    predicted_winner_id,
    actual_winner_id,
    locked_at,
    optimizer_run_id
  FROM evaluation_predictions
  WHERE run_kind = 'historical_test'
    AND segment = 'test'
    AND included_in_accuracy = true
    AND actual_winner_id IS NOT NULL
    AND historical_match_id IS NOT NULL
    AND predicted_winner_id IS NOT NULL
),
frozen_latest AS (
  SELECT *
  FROM (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.historical_match_id
        ORDER BY b.locked_at DESC, b.id DESC
      ) AS rn
    FROM base b
    WHERE b.optimizer_run_id IS NULL
  ) ranked
  WHERE rn = 1
),
dynamic_latest AS (
  SELECT *
  FROM (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.historical_match_id
        ORDER BY b.locked_at DESC, b.id DESC
      ) AS rn
    FROM base b
    WHERE b.optimizer_run_id IS NOT NULL
  ) ranked
  WHERE rn = 1
)
SELECT
  (SELECT COUNT(*)::text
     FROM base
    WHERE optimizer_run_id IS NULL) AS frozen_rows,

  (SELECT COUNT(*)::text
     FROM base
    WHERE optimizer_run_id IS NOT NULL) AS dynamic_rows,

  (SELECT COUNT(DISTINCT historical_match_id)::text
     FROM base
    WHERE optimizer_run_id IS NULL) AS frozen_distinct_matches,

  (SELECT COUNT(DISTINCT historical_match_id)::text
     FROM base
    WHERE optimizer_run_id IS NOT NULL) AS dynamic_distinct_matches,

  (SELECT COUNT(*)::text
     FROM frozen_latest f
     INNER JOIN dynamic_latest d
       USING (historical_match_id)) AS intersected_matches;
`;

  const rowsSql = `
WITH base AS (
  SELECT
    id,
    historical_match_id,
    predicted_winner_id,
    actual_winner_id,
    locked_at,
    optimizer_run_id
  FROM evaluation_predictions
  WHERE run_kind = 'historical_test'
    AND segment = 'test'
    AND included_in_accuracy = true
    AND actual_winner_id IS NOT NULL
    AND historical_match_id IS NOT NULL
    AND predicted_winner_id IS NOT NULL
),
frozen_latest AS (
  SELECT *
  FROM (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.historical_match_id
        ORDER BY b.locked_at DESC, b.id DESC
      ) AS rn
    FROM base b
    WHERE b.optimizer_run_id IS NULL
  ) ranked
  WHERE rn = 1
),
dynamic_latest AS (
  SELECT *
  FROM (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.historical_match_id
        ORDER BY b.locked_at DESC, b.id DESC
      ) AS rn
    FROM base b
    WHERE b.optimizer_run_id IS NOT NULL
  ) ranked
  WHERE rn = 1
)
SELECT
  f.historical_match_id,
  f.actual_winner_id,
  f.predicted_winner_id AS frozen_predicted_winner_id,
  d.predicted_winner_id AS dynamic_predicted_winner_id
FROM frozen_latest f
INNER JOIN dynamic_latest d
  USING (historical_match_id)
ORDER BY f.historical_match_id ASC;
`;

  const countsRes = await pool.query<CountRow>(countsSql);
  const joinedRes = await pool.query<JoinedRow>(rowsSql);

  const counts = countsRes.rows[0];
  const joinedRows = joinedRes.rows;

  const sampleN = joinedRows.length;

  const frozenCorrect = joinedRows.filter(
    (r) => r.frozen_predicted_winner_id === r.actual_winner_id
  ).length;

  const dynamicCorrect = joinedRows.filter(
    (r) => r.dynamic_predicted_winner_id === r.actual_winner_id
  ).length;

  const frozenAccuracy =
    sampleN > 0 ? (frozenCorrect / sampleN) * 100 : null;

  const dynamicAccuracy =
    sampleN > 0 ? (dynamicCorrect / sampleN) * 100 : null;

  const delta =
    frozenAccuracy !== null && dynamicAccuracy !== null
      ? dynamicAccuracy - frozenAccuracy
      : null;

  console.log(
    "=== Frozen vs Dynamic Weight Backtest (evaluation_predictions) ==="
  );

  console.log(
    "filters=run_kind:historical_test, segment:test, included_in_accuracy:true, actual_winner_id:not_null"
  );

  console.log(`frozen_rows=${counts?.frozen_rows ?? "0"}`);
  console.log(`dynamic_rows=${counts?.dynamic_rows ?? "0"}`);
  console.log(
    `frozen_distinct_matches=${counts?.frozen_distinct_matches ?? "0"}`
  );
  console.log(
    `dynamic_distinct_matches=${counts?.dynamic_distinct_matches ?? "0"}`
  );
  console.log(
    `intersected_matches=${counts?.intersected_matches ?? "0"}`
  );

  console.log(`frozen_sample_count=${sampleN}`);
  console.log(`dynamic_sample_count=${sampleN}`);

  console.log(
    `frozen_accuracy=${
      frozenAccuracy === null ? "null" : frozenAccuracy.toFixed(2)
    }`
  );

  console.log(
    `dynamic_accuracy=${
      dynamicAccuracy === null ? "null" : dynamicAccuracy.toFixed(2)
    }`
  );

  console.log(
    `delta_pp=${delta === null ? "null" : delta.toFixed(2)}`
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});