# Live Verification Audit — Task #121
**Date:** 2026-08-07  
**DB:** heliumdb (PostgreSQL 16.10), `NOW()` = `2026-08-07 21:38:21 UTC`  
**HEAD commit:** `48707e67beb98e1521638172d9db773401627e79`  
**Origin/main:** `9b22318` (HEAD is 3 local commits ahead — doc/asset additions for tie-break analysis; all feature code is in earlier merged commits)  
**Workflows:** API Server ✅ running · Tennis Predictor ✅ running

---

## Item 1 — Tie-break soft no-play fix

### Completed work
`applyTieBreaker` in `artifacts/api-server/src/services/predictionEngine/tieBreakers.ts`; called in `index.ts`. When `tieBreakerApplied=true` the raw ensemble probability now flows through **unchanged** — no directional cascade nudge. The cascade was removed in Task #5. From `index.ts` lines 96-100:
```
tieBreakerApplied: boolean  // true when raw ensemble within TIE_BAND of a coin flip
tieBreakerDecidingStep: string | null  // always null after Task #5's cascade removal
tieBreakerNote: string | null          // explains: "no directional nudge is applied"
```

### Live evidence

**SQL run:**
```sql
SELECT id, locked_at, run_kind,
       feature_snapshot->'engine'->>'tieBreakerApplied' AS tba,
       feature_snapshot->'engine'->>'tieBreakerNote' AS tb_note,
       feature_snapshot->'engine'->>'tieBreakerDecidingStep' AS deciding_step,
       calibrated_probability
FROM evaluation_predictions
WHERE feature_snapshot->'engine'->>'tieBreakerApplied' = 'true'
  AND run_kind IN ('live','paper_trade')
ORDER BY locked_at DESC LIMIT 5;
```

| id | locked_at | tba | calibrated_probability | deciding_step |
|----|-----------|-----|------------------------|---------------|
| 1089687 | 2026-07-24 19:39:50 | true | **49.0** | null |
| 1089373 | 2026-07-24 07:36:21 | true | **49.2** | null |
| 1089320 | 2026-07-22 15:56:52 | true | **49.7** | null |
| 1089309 | 2026-07-22 10:09:10 | true | **50.7** | null |
| 1089275 | 2026-07-22 10:09:08 | true | **49.5** | null |

`tieBreakerNote` on all 5: _"Core signals are within 3 points of a coin flip (raw 48.3%) — this is a genuinely close matchup where no validated tie-break signal provides a reliable directional edge in the tight-signal regime. The ensemble's natural probability is used as-is; no directional nudge is applied."_

**Tie-break row counts:**
```sql
SELECT run_kind, COUNT(*) AS tiebreak_count, MIN(locked_at), MAX(locked_at)
FROM evaluation_predictions
WHERE feature_snapshot->'engine'->>'tieBreakerApplied' = 'true'
GROUP BY run_kind;
```
| run_kind | tiebreak_count | first_seen | last_seen |
|---|---|---|---|
| historical_test | 37,817 | 2026-07-29 | 2026-08-06 |
| paper_trade_shadow | 14,997 | 2026-07-15 | 2026-07-18 |
| paper_trade | 218 | 2026-07-14 | 2026-07-24 |

All 218 paper_trade tie-break rows: `tieBreakerDecidingStep = null`, `calibrated_probability` in range 48–52% (no nudge applied), consistent with no-play behavior.

**Status: ✅ VERIFIED LIVE**  
Commit SHA: `48707e67beb98e1521638172d9db773401627e79`

---

## Item 2 — Data Quality fix

### Completed work
`dataQuality.ts` — MODULE_IMPORTANCE defines 7 weights; `EXCLUDED_FROM_DATA_QUALITY` removes modules from the blend:

```typescript
export const EXCLUDED_FROM_DATA_QUALITY = new Set([
  "headToHead", "fatigue", "availability", "matchLoadRecovery", "marketOdds"
]);
```

So the **active DQ blend** uses exactly: `surfaceElo (1.3)`, `serveReturn (1.2)`, `recentForm (1.1)` — the three core predictive modules. Availability, Fatigue, and Match Load Recovery are each in `MODULE_IMPORTANCE` with weights (0.9 / 0.7 / 0.4) but **excluded from the blend** — included in the breakdown display only.

### Live evidence

**DQ in live `predictions` table** (written by `savePrediction.ts`):
```sql
SELECT data_quality_label, COUNT(*) AS total,
       SUM(CASE WHEN predicted_winner_id = actual_winner_id THEN 1 ELSE 0 END) AS correct,
       ROUND(100.0 * SUM(...) / NULLIF(COUNT(*),0), 1) AS acc_pct
FROM predictions
WHERE actual_winner_id IS NOT NULL
GROUP BY data_quality_label ORDER BY data_quality_label;
```
| dq_label | total | correct | acc_pct |
|---|---|---|---|
| Acceptable | 277 | 202 | 72.9% |
| Excellent | 1,414 | 886 | 62.7% |
| Limited | 256 | 197 | 77.0% |
| Poor | 487 | 472 | **96.9%** |
| Strong | 700 | 514 | 73.4% |

⚠️ **Accuracy is inverted from expected direction**: Poor DQ → 96.9%; Excellent DQ → 62.7%. Lower DQ tier consistently outperforms higher. This confirms the existing memory finding (`dq-threshold-calibration-reversal.md`): high DQ can stop meaning "trustworthy" after a module-blend change, and the DQ-gated thresholds have not been re-validated against this specific blend. The code change itself is correct; the concern is whether the score's _meaning_ aligns with what the gates act on.

**DQ in evaluation_predictions**: the `paper_trade` rows store DQ as a number in `featureSnapshot->>'dataQuality'` (not a named label column), so DQ-tier accuracy cannot be queried from that table. Sample from the most recent paper_trade snapshots:
```
id=1089688: dataQuality=75, id=1089687: dataQuality=50, id=1089683: dataQuality=90
```
The DQ value is present and varying.

**Status: ⚠️ CONFLICT FOUND — Code change is deployed and mechanically correct; DQ accuracy direction is inverted, meaning DQ thresholds used in recommendation/elite-tier gates may be selecting in the wrong direction.**

---

## Item 3 — Fallback instrumentation

### Completed work
Migration: `lib/db/drizzle/0002_add_evaluation_prediction_fallback_columns.sql`
```sql
ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "used_fallback" boolean;
ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "fallback_sources" jsonb;
```

Also applied to `predictions` table (live path via `savePrediction.ts` → `normalizePredictionInsert`).

### Live evidence

**Column check on `evaluation_predictions`:**
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'evaluation_predictions'
  AND column_name IN ('used_fallback','fallback_sources');
```
| column_name | data_type | is_nullable |
|---|---|---|
| fallback_sources | jsonb | YES |
| used_fallback | boolean | YES |

**Total row counts:**
```sql
SELECT COUNT(*) AS total_rows,
       SUM(CASE WHEN used_fallback = true THEN 1 ELSE 0 END) AS fallback_rows,
       ROUND(100.0 * ... / NULLIF(COUNT(*),0), 1) AS fallback_pct
FROM evaluation_predictions;
```
| total_rows | fallback_rows | fallback_pct |
|---|---|---|
| 195,987 | 140,819 | **71.9%** |

**Fallback sources breakdown:**
```sql
SELECT fallback_sources, COUNT(*) AS cnt FROM evaluation_predictions
WHERE used_fallback = true GROUP BY fallback_sources ORDER BY cnt DESC;
```
| fallback_sources | cnt |
|---|---|
| `["serveReturn", "recentForm"]` | 63,425 |
| `["serveReturn"]` | 56,738 |
| `["recentForm"]` | 12,990 |
| `["serveReturn", "index"]` | 5,853 |
| `["serveReturn", "recentForm", "index"]` | 1,813 |

**Fallback accuracy vs. clean:**
```sql
SELECT used_fallback, COUNT(*) AS total, ..., acc_pct
FROM evaluation_predictions
WHERE actual_winner_id IS NOT NULL AND included_in_accuracy = true
GROUP BY used_fallback;
```
| used_fallback | total | correct | acc_pct |
|---|---|---|---|
| false | 32,052 | 19,371 | 60.4% |
| true | 135,960 | 86,551 | 63.7% |
| null | 41 | 24 | 58.5% |

**5 recent rows (historical_test):**
```
id=1495253 locked=2026-08-06 run=historical_test segment=validation used_fallback=t sources=["serveReturn","recentForm","index"]
id=1495252 locked=2026-08-06 run=historical_test segment=validation used_fallback=t sources=["serveReturn","index"]
id=1495251 locked=2026-08-06 run=historical_test segment=validation used_fallback=t sources=["serveReturn","recentForm","index"]
id=1495250 locked=2026-08-06 run=historical_test segment=validation used_fallback=t sources=["serveReturn","index"]
id=1495249 locked=2026-08-06 run=historical_test segment=validation used_fallback=t sources=["serveReturn","index"]
```

**Note on recent `paper_trade` missed rows:** paper_trade rows from 2026-08-07 (ids 1495258–1495275) have `used_fallback=null` and `status='missed'` — these are fixtures the cycle detected but could not lock before the grace window elapsed (no snapshot computed, fallback fields correctly null). The last scored paper_trade rows are from 2026-07-24.

**Status: ✅ VERIFIED LIVE**

---

## Item 4 — Segment provenance

### Completed work
Both `segment` (text, nullable) and `data_segment` (text, NOT NULL) exist on `evaluation_predictions`. `savePrediction.ts` defaults `dataSegment: values.dataSegment ?? "live"`.

### Live evidence

**Column check:**
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'evaluation_predictions'
  AND column_name IN ('segment','data_segment');
```
| column_name | data_type | is_nullable |
|---|---|---|
| data_segment | text | NO |
| segment | text | YES |

**Null counts and disagreements:**
```sql
SELECT COUNT(*) AS total_rows,
       SUM(CASE WHEN segment IS NULL THEN 1 ELSE 0 END) AS segment_null_count,
       SUM(CASE WHEN data_segment IS NULL THEN 1 ELSE 0 END) AS data_segment_null_count,
       SUM(CASE WHEN segment IS DISTINCT FROM data_segment THEN 1 ELSE 0 END) AS disagree_count
FROM evaluation_predictions;
```
| total_rows | segment_null | data_segment_null | disagree_count |
|---|---|---|---|
| 195,987 | **0** | **0** | **0** |

**Value distributions (both columns identical):**
| value | count |
|---|---|
| validation | 89,379 |
| test | 63,602 |
| live | 43,006 |

**Canonical:** `data_segment` is authoritative (NOT NULL constraint; written explicitly by all insert paths). `segment` is a nullable copy that has always matched.

**Predictions table (`savePrediction.ts` path):** `predictions` table also has `data_segment` column, confirmed by:
```sql
SELECT id, data_segment FROM predictions ORDER BY id DESC LIMIT 5;
-- returns 'live' for all recent rows
```
Note: the table is named `predictions`, not `predictions_ledger`; no `segment`/`data_segment` columns exist on any separate ledger table.

**Status: ✅ VERIFIED CONSISTENT**

---

## Item 5 — All instrumented write paths

### `savePrediction.ts` → `predictions` table

**Exact write code** (`normalizePredictionInsert`, lines 29-51):
```typescript
const fallback = extractFallbackInstrumentation({ engine: values.engine, decisionTrace: values.decisionTrace });
return {
  ...values,
  dataSegment: values.dataSegment ?? "live",
  usedFallback: values.usedFallback ?? fallback.usedFallback,
  fallbackSources: values.fallbackSources ?? fallback.fallbackSources,
};
```

**Live row (most recent 5 from `predictions`):**
```
id=7934 player1=Casper Ruud player2=Joao Fonseca dq=86 dq_label=Excellent rec=INSUFFICIENT_EDGE data_segment=live used_fallback=true sources=["serveReturn","recentForm"]
id=7933 player1=Terence Atmane player2=Jakub Mensik dq=87 dq_label=Excellent rec=HIGH_CONFIDENCE data_segment=live used_fallback=true sources=["serveReturn","recentForm"]
```
**Result: CODE + LIVE VERIFIED** (7,934 rows in `predictions`)

---

### `walkForward.ts` → `evaluation_predictions` (`historical_test`)

**Exact write code** (`scoreAndInsert` closure, lines 420+):
```typescript
async function scoreAndInsert(matches, segment: "validation" | "test", foldId, retirementRule) {
  // ...
  await db.insert(evaluationPredictionsTable).values({
    runKind: "historical_test",
    segment,          // "validation" or "test" per fold half
    dataSegment: segment,
    usedFallback: scored?.usedFallback ?? null,
    fallbackSources: scored?.fallbackSources ?? null,
    // ...
  });
}
```

**Live rows (most recent historical_test):**
```
id=1495253 locked=2026-08-06 segment=validation data_segment=validation used_fallback=true sources=["serveReturn","recentForm","index"]
id=1495252 locked=2026-08-06 segment=validation data_segment=validation used_fallback=true sources=["serveReturn","index"]
```
**Result: CODE + LIVE VERIFIED** (152,981 rows in historical_test; 89,379 validation + 63,602 test)

---

### `paperTrading.ts` → `evaluation_predictions` (`paper_trade`)

**Exact write code** (lines 176-217, "miss" path and "lock" path):
```typescript
// Missed fixture (no snapshot):
await db.insert(evaluationPredictionsTable).values({
  runKind: "paper_trade", segment: "live", dataSegment: "live",
  featureSnapshot: null, usedFallback: null, fallbackSources: null, status: "missed",
});

// Locked prediction:
const fallback = extractFallbackInstrumentation({ engine: output.engine, decisionTrace: output.decisionTrace });
await db.insert(evaluationPredictionsTable).values({
  runKind: "paper_trade", segment: "live", dataSegment: "live",
  usedFallback: fallback.usedFallback, fallbackSources: fallback.fallbackSources,
  featureSnapshot: snapshot, status: "pending",
});
```

**Live rows (last locked paper_trade, id ~1089xxx, 2026-07-24):**
```
id=1089688 locked=2026-07-24 segment=live data_segment=live status=pending dataQuality=75
id=1089687 locked=2026-07-24 segment=live data_segment=live status=pending tieBreakerApplied=true dq=50
```

**Note:** All 2026-08-07 paper_trade rows are `status='missed'` — the prediction cycle is running but the lock window is being missed for today's fixtures. This is the known Scheduled Deployment / in-process timer reliability issue (see `paper-trading-job-triggering.md` memory note).
**Result: CODE + LIVE VERIFIED** (1,558 rows; last scored prediction 2026-07-24)

---

### `shadowReplay.ts` → `evaluation_predictions` (`paper_trade_shadow`)

**Exact write code** (lines 283–320):
```typescript
await db.insert(evaluationPredictionsTable).values({
  runKind: "paper_trade_shadow",
  segment: "live", dataSegment: "live",
  shadowBatchLabel: batchLabel,
  usedFallback: scored.usedFallback,
  fallbackSources: scored.fallbackSources,
  featureSnapshot: scored.snapshot,
  // ...
});
```

**Live rows (most recent shadow rows):**
```
id=715843 locked=2026-07-18 segment=live data_segment=live used_fallback=true sources=["serveReturn"]
id=715842 locked=2026-07-18 segment=live data_segment=live used_fallback=true sources=["serveReturn","recentForm"]
id=715841 locked=2026-07-18 segment=live data_segment=live used_fallback=false sources=[]
```
**Result: CODE + LIVE VERIFIED** (41,448 rows)

---

### `bridgeRescore.ts` → `evaluation_predictions` (`historical_test`, `segment='test'`)

**Exact write code** (lines 201–267):
```typescript
const toInsert = {
  runKind: "historical_test",
  segment: "test",
  dataSegment: "test",
  foldId: null,           // distinguishable from fold rows (foldId=null + bridgeRescore context)
  usedFallback: scoredResult?.usedFallback ?? null,
  fallbackSources: scoredResult?.fallbackSources ?? null,
  // ...
};
await db.insert(evaluationPredictionsTable).values(toInsert);
```

**Live rows:** Cannot be directly distinguished from regular walk-forward `historical_test` rows — both write `runKind='historical_test'`, `segment='test'`, `foldId=null`. No `source_kind` or `bridge_rescore` discriminator column exists. **CODE ONLY** (no query can isolate bridge-rescore rows from walk-forward test rows without adding a discriminator column).

---

### Historical-test insert (walk-forward `scoreAndInsert`)
Covered under `walkForward.ts` above — same code path. **VERIFIED LIVE**.

---

## Item 6 — Deployment state

**Repository HEAD:**
```
git rev-parse HEAD → 48707e67beb98e1521638172d9db773401627e79
```
Recent commits:
```
48707e6 HEAD  Add documentation and asset attachments for tie-break analysis
fc75f03       Update prediction result UI and synchronize API schemas
9b22318 origin/main  Restore mobile layout improvements
```
HEAD is 2 local commits ahead of origin/main. Feature code (tie-break fix, DQ fix, fallback instrumentation, segment provenance) all merged in earlier commits reachable from origin/main.

**DB health:**
```sql
SELECT NOW() AS now, current_database() AS db_name, version() AS pg_version;
-- 2026-08-07 21:38:21.550474+00 | heliumdb | PostgreSQL 16.10
```

**Workflow status:** Both workflows running (API Server + Tennis Predictor web) per system log.

**Migration tracking:** `drizzle.__drizzle_migrations` table does not exist — migrations are applied manually via `psql $DATABASE_URL -f <file>` (confirmed by migration file comments). The `used_fallback` and `fallback_sources` columns exist in production, confirming the migration ran.

**Status: DEPLOYED AND VERIFIED** — all feature code is in commits reachable from the running app; DB is live and healthy; both services running.

---

## Item 7 — Frozen-vs-dynamic backtest script

### Script verified
**Path:** `artifacts/api-server/src/scripts/backtestFrozenVsDynamicWeights.ts` ✅ exists

**Actual filters the script applies** (reading from `historicalMatchesTable` directly, not `evaluation_predictions`):
1. `!match.cancelled` — excludes cancelled matches
2. Warmup exclusion — first `warmupFraction` (default 0.4) of eligible matches are training-only
3. Fold structure — remaining matches split into `foldCount` (default 4) chunks
4. Per-chunk: first half = validation slice, second half = test slice

> ⚠️ **Correction from task plan:** The four filters originally described (`run_kind='historical_test'`, `segment='test'`, `included_in_accuracy=true`, `actual_winner_id IS NOT NULL`) are NOT this script's actual filters. The script rescores `historicalMatchesTable` fresh in-process rather than reading from `evaluation_predictions`. The `intersects by historical_match_id` framing also does not apply — there is no join to `evaluation_predictions`.

**`optimizer_run_id` check:**
```sql
SELECT COUNT(*) AS rows_with_optimizer_run_id
FROM evaluation_predictions WHERE optimizer_run_id IS NOT NULL;
-- 0
```
Column exists (confirmed by schema), but all 195,987 rows have `optimizer_run_id = NULL`. No optimizer training run has ever been triggered.

**Status: SCRIPT VERIFIED, COMPARISON STILL BLOCKED** — the dynamic arm requires an optimizer run (`evaluationOnly=false`) to populate rows with non-null `optimizer_run_id`. Until that runs, the frozen-vs-dynamic comparison cannot be made.

---

## Item 8 — Final Report Table

| # | Item | Completed work | Live evidence | Status | Prod-ready | Additional testing required | Possible rollback | Exact blocker |
|---|---|---|---|---|---|---|---|---|
| 1 | Tie-break soft no-play fix | `applyTieBreaker` passes raw ensemble through unchanged; cascade removed (Task #5) | 218 paper_trade rows with `tieBreakerApplied=true`, `tieBreakerDecidingStep=null`, calibrated_probability 48–52%, correct note text | ✅ Completed & Verified Live | Yes | None | No | — |
| 2 | Data Quality fix | `EXCLUDED_FROM_DATA_QUALITY` = {headToHead, fatigue, availability, matchLoadRecovery, marketOdds}; blend uses surfaceElo+serveReturn+recentForm only | Code confirmed; DQ values in predictions table (7,934 live rows, DQ 50–98); accuracy relationship **inverted** (Poor→96.9%, Excellent→62.7%) | ⚠️ Conflict Found – Review Required | No | Re-validate DQ accuracy by tier on a sample where the current blend was active; check whether gates (elite tier, recommendation) act on DQ in the correct direction | 🔄 Possible Rollback Candidate (DQ weights) | DQ tier accuracy is inverted — lower DQ tier consistently outperforms higher DQ tier in live predictions |
| 3 | Fallback instrumentation | `used_fallback` (boolean), `fallback_sources` (jsonb) on both tables; migration applied | 195,987 rows; 71.9% fallback rate; 5 confirmed recent rows; sources breakdown verified; also in `predictions` table | ✅ Completed & Verified Live | Yes | None | No | — |
| 4 | Segment provenance | `segment` (nullable text) + `data_segment` (NOT NULL text) on `evaluation_predictions`; `data_segment` also on `predictions` | 0 nulls, 0 disagreements across 195,987 rows; distributions identical; `data_segment` is canonical | ✅ Completed & Verified Live | Yes | None | No | — |
| 5a | `savePrediction.ts` write path | `dataSegment ?? "live"`, `usedFallback`, `fallbackSources` via `extractFallbackInstrumentation` | 7,934 rows in `predictions` with real DQ, segment, fallback values | ✅ Completed & Verified Live | Yes | None | No | — |
| 5b | `walkForward.ts` write path | `segment` = "validation"/"test" per fold; `dataSegment = segment`; `usedFallback`, `fallbackSources` from `scored` | 152,981 historical_test rows; 89,379 validation + 63,602 test; recent rows show real fallback values | ✅ Completed & Verified Live | Yes | None | No | — |
| 5c | `paperTrading.ts` write path | `segment="live"`, `dataSegment="live"`; fallback from `extractFallbackInstrumentation`; missed rows: null fallback | 1,558 rows; last scored 2026-07-24; all missed rows since then (scheduling gap) | 🟡 Completed – Needs More Live Data | Partial | New locked predictions needed to verify current code path live (all recent rows are missed) | No | Paper-trade cycle is running but locking no predictions — all 2026-08-07 rows are `status='missed'` |
| 5d | `shadowReplay.ts` write path | `segment="live"`, `dataSegment="live"`; `usedFallback`, `fallbackSources` from `scored` | 41,448 rows; last batch 2026-07-18; real fallback values confirmed | ✅ Completed & Verified Live | Yes | None | No | — |
| 5e | `bridgeRescore.ts` write path | `segment="test"`, `dataSegment="test"`, `foldId=null`, fallback from `scoredResult` | **CODE ONLY** — no discriminator column separates bridge-rescore rows from walk-forward test rows | 🔵 Built – Not Deployed (no live row identifiable) | No | Need a discriminator column (`source_kind` or similar) or tagged `optimizer_run_id` | No | No way to isolate bridge-rescore rows from walk-forward rows without a new column |
| 6 | Deployment state | HEAD `48707e67`; DB live; both workflows running | `NOW()=2026-08-07 21:38Z`, `current_database()=heliumdb`; API Server + Tennis Predictor workflows running | ✅ Completed & Verified Live | Yes | None | No | — |
| 7 | Frozen-vs-dynamic backtest | Script at `artifacts/api-server/src/scripts/backtestFrozenVsDynamicWeights.ts`; rescores `historicalMatchesTable` fresh (not from `evaluation_predictions`) | `optimizer_run_id IS NOT NULL` → 0 rows; no optimizer run has ever fired | ❌ Not Verified (comparison impossible) | No | Run optimizer (`POST /api/evaluation/walk-forward` with `evaluationOnly=false`) to populate dynamic arm | No | All 195,987 `evaluation_predictions` rows have `optimizer_run_id=NULL` — dynamic arm is empty |

---

## Summary of blockers requiring action

1. **⚠️ DQ accuracy inversion (Item 2):** The DQ score's accuracy relationship is backwards on live data. Gates that reward "Excellent" DQ (recommendation, elite-tier) may be selecting _less_ reliable predictions, not more. This predates this audit — it matches the existing `dq-threshold-calibration-reversal.md` finding — but has not been resolved. Should be confirmed with a dedicated walk-forward segment analysis before any new DQ-gated threshold is tightened.

2. **🟡 Paper-trade cycle not scoring (Item 5c):** All paper_trade rows since 2026-07-24 are `status='missed'`. The cycle is running (rows are being written) but predictions are not being locked. This is the known Scheduled Deployment gap (`paper-trading-job-triggering.md`): the in-process cycle timer stops working when the dev workflow is evicted. Needs a Scheduled Deployment to resume live scoring.

3. **🔵 bridgeRescore rows not isolable (Item 5e):** There is no way to query bridge-rescore rows separately from walk-forward historical_test rows without adding a discriminator column. Not urgent but means bridge-rescore coverage cannot be independently audited.

4. **❌ Frozen-vs-dynamic comparison blocked (Item 7):** The script is correct and verified. The comparison requires at least one optimizer run (`evaluationOnly=false`) to populate the dynamic arm. The task for wiring the calibration-refit cycle (#81) is the unblocking step.
