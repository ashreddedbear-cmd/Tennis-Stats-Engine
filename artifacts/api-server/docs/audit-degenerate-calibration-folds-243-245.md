# Known-Degenerate Evaluation Rows: Folds 243–245

**Date identified:** 2026-08-08  
**Action taken:** documented only — cleanup not possible (see below)

---

## What

`evaluation_predictions` rows in folds 243, 244, and 245 have `calibrated_probability = 100.00`
for every single row — 9,103 rows per fold, 27,309 total.

```sql
SELECT fold_id, run_kind, COUNT(*) AS cnt,
       MIN(calibrated_probability) AS min_cp, MAX(calibrated_probability) AS max_cp
FROM evaluation_predictions
WHERE fold_id IN (243, 244, 245)
GROUP BY fold_id, run_kind;
-- fold_id | run_kind       | cnt  | min_cp | max_cp
-- 243     | historical_test| 9103 | 100    | 100
-- 244     | historical_test| 9103 | 100    | 100
-- 245     | historical_test| 9103 | 100    | 100
```

## Why

These folds were generated during an early walk-forward run (Task #711 era) when the per-fold
calibration model had fewer than 100 holdout points. A per-fold isotonic regression with <100
holdout points collapses to a degenerate constant model (y = 1.0 everywhere). The guard that
skips degenerate per-fold calibration (holdoutSampleSize check in `walkForward.ts`) was added
**after** these folds were scored, so the collapse was stored rather than detected and skipped.

These rows do **not** affect the aggregate walk-forward result that #711 reported — the aggregate
calibration metric uses the active global calibration model applied to holdout rows, not the
per-fold stored `calibrated_probability`. The degenerate values are in the stored column only.

## Why cleanup isn't possible

All 27,309 rows are graded (`actual_winner_id IS NOT NULL`) and therefore protected by the
`evaluation_predictions_immutable_after_settle` trigger (BEFORE UPDATE, fires on any column
change to a settled row). Any attempt to UPDATE `calibrated_probability` on these rows will
be blocked by the trigger, which is correct behaviour — the settle-once constraint exists to
preserve walk-forward integrity.

Deleting these rows would also be incorrect: walk-forward runs are append-only by design, and
the fold structure in `evaluation_runs` still references fold IDs 243–245. Deleting would
leave orphan `evaluation_runs` rows and would silently change future fold-count queries.

## What to do if you query these rows directly

Filter to rows where `calibrated_probability < 100` for any accuracy or calibration query, or
exclude fold IDs 243–245 explicitly:

```sql
-- Safe accuracy query — excludes degenerate folds
SELECT ...
FROM evaluation_predictions
WHERE run_kind = 'historical_test'
  AND fold_id NOT IN (243, 244, 245)
  AND status = 'graded'
  AND included_in_accuracy = true
```

The monitoring dashboard and walk-forward accuracy reports already use `included_in_accuracy`
as their primary filter, which excludes the degenerate rows correctly via the post-fold
accuracy-inclusion logic.
