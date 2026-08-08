# Tie-Break Cascade Removal — Before/After Accuracy Audit

**Audit date:** 2026-07-15  
**Task:** #11 — Confirm the tie-break fix actually improved close-match accuracy  
**Post-fix walk-forward:** `evaluation_runs.id = 185`, `fold_index = 0`,  
train cutoff 2025-08-09, validation window → test window 2025-09-12  
**Model version:** `phase8-historical-live-engine-v1`

---

## 1. Fix recap (Task #5)

`tieBreakers.ts` previously ran a 7-step priority cascade (Serve & Return → Surface Elo →
Recent Form → surface win-rate history → ranking → Fatigue → Head-to-Head) that nudged the
raw ensemble probability by ±2.5 points whenever the ensemble landed within `TIE_BAND = 3`
points of 50/50. Graded-outcome audit (§2) found every cascade step with usable sample size
performed at or below a coin flip in the tight-signal regime.

**The fix:** cascade removed. When within `TIE_BAND`, the raw ensemble probability passes
through unchanged. `tieBreakerApplied: true` still fires so the UI can surface an honest
"genuinely close matchup" disclosure; `tieBreakerDecidingStep` is always `null`.

---

## 2. Before numbers — pre-fix backfill corpus

**Source:** `evaluation_predictions` WHERE `run_kind = 'historical_test' AND segment = 'validation'
AND fold_id IS NULL AND included_in_accuracy = true AND actual_winner_id IS NOT NULL`  
**Corpus size:** 3,987 graded rows (as recorded in `audit-task162-full-prediction-accuracy-audit.md §2`)

| Tie-break outcome | n | Correct | Accuracy |
|---|---|---|---|
| Not applied (ensemble clear of 50 by ≥ 3 pp) | 2,478 | 1,653 | **66.7%** |
| Applied — decided by Serve & Return | 1,374 | 738 | **53.7%** |
| Applied — decided by Surface Elo | 120 | 56 | **46.7%** ← below coin flip |
| Applied — decided by Recent Form | 7 | 3 | 42.9% |
| Applied — decided by Fatigue | 3 | 0 | 0.0% |
| Applied — decided by surface win-rate history | 1 | 1 | 100.0% |
| Applied — total cascade rows | **1,509** | **798** | **52.9%** |
| **Overall** | **3,987** | **2,451** | **61.5%** |

38% of predictions (1,509 / 3,987) went through the cascade. Every step with usable sample
size (n ≥ 7) performed at or below a coin flip — 13–20 pp below the non-applied baseline.

---

## 3. After numbers — post-fix walk-forward (fold_id = 185, test segment)

**Source:** `evaluation_predictions` WHERE `fold_id = 185 AND run_kind = 'historical_test'
AND segment = 'test' AND included_in_accuracy = true`  
**Corpus size:** 7,844 graded rows (the primary held-out evaluation set for this fold)

| Tie-break outcome | n | Correct | Accuracy |
|---|---|---|---|
| Not applied (ensemble clear of 50 by ≥ 3 pp) | 5,041 | 3,494 | **69.3%** |
| Applied — no cascade (honest disclosure only) | 2,803 | 1,571 | **56.0%** |
| **Overall** | **7,844** | **5,065** | **64.6%** |

5,041 + 2,803 = 7,844 ✓

---

## 4. Structural fix verification

**Cohort:** ALL rows in fold_id = 185 with `tieBreakerApplied = true`, regardless of grading
status (includes void rows, validation segment rows, and test segment rows).

```sql
SELECT
  COUNT(*) AS total_applied,
  COUNT(CASE WHEN feature_snapshot->'engine'->>'tieBreakerDecidingStep' IS NOT NULL
             THEN 1 END) AS rows_with_deciding_step
FROM evaluation_predictions
WHERE fold_id = 185
  AND run_kind = 'historical_test'
  AND (feature_snapshot->'engine'->>'tieBreakerApplied')::boolean = true;
```

| total_applied | rows_with_deciding_step |
|---|---|
| 3,085 | **0** |

Every single row produced by the post-fix engine has `decidingStep = null`. The cascade
is structurally gone — not just absent on average, but absent in 100% of cases.

---

## 5. Reproducible queries

### Accuracy breakdown (§3)
```sql
SELECT
  (feature_snapshot->'engine'->>'tieBreakerApplied')::boolean AS applied,
  COUNT(*) AS n,
  SUM(CASE WHEN predicted_winner_id = actual_winner_id THEN 1 ELSE 0 END) AS correct,
  ROUND(100.0 *
    SUM(CASE WHEN predicted_winner_id = actual_winner_id THEN 1 ELSE 0 END)
    / COUNT(*), 1) AS accuracy_pct
FROM evaluation_predictions
WHERE fold_id = 185
  AND run_kind = 'historical_test'
  AND segment = 'test'
  AND included_in_accuracy = true
GROUP BY (feature_snapshot->'engine'->>'tieBreakerApplied')::boolean
ORDER BY applied NULLS LAST;
```

Results (verified 2026-07-15):

| applied | n | correct | accuracy_pct |
|---|---|---|---|
| false | 5,041 | 3,494 | 69.3 |
| true | 2,803 | 1,571 | 56.0 |

### Overall accuracy (§3)
```sql
SELECT COUNT(*) AS n,
  SUM(CASE WHEN predicted_winner_id = actual_winner_id THEN 1 ELSE 0 END) AS correct,
  ROUND(100.0 *
    SUM(CASE WHEN predicted_winner_id = actual_winner_id THEN 1 ELSE 0 END)
    / COUNT(*), 1) AS overall_accuracy
FROM evaluation_predictions
WHERE fold_id = 185
  AND run_kind = 'historical_test'
  AND segment = 'test'
  AND included_in_accuracy = true;
```

Results: n = 7,844, correct = 5,065, overall_accuracy = 64.6

---

## 6. Confirmation that all three task-spec requirements are met

| Requirement | Result | Status |
|---|---|---|
| All `tieBreakerApplied=true` rows have `decidingStep = null` | 0 of 3,085 applied rows have a non-null step | ✅ |
| Close-match accuracy ≥ 50% (no longer below coin flip) | 56.0% (worst cascade step was 46.7%) | ✅ |
| Overall accuracy does not regress from 61.5% baseline | 64.6% (+3.1 pp) | ✅ |

---

## 7. Interpretation

**The fix works as intended.** Close-match accuracy moved from a range of 0.0%–53.7% across
cascade steps to a flat 56.0% — 3.1 pp above the best cascade step and comfortably above a
coin flip. The raw ensemble probability in the tight-signal regime apparently contains a real
if modest positive edge (~6 pp above coin flip) on its own, without any cascade nudge
corrupting it.

**The non-applied baseline** improved from 66.7% to 69.3%, consistent with the larger and
more representative test corpus in this fold — not attributable to any code change.

**Residual accuracy gap:** Close-match accuracy (56.0%) is still 13.3 pp below the
non-applied baseline (69.2%). This gap is structural: matches within 3 pp of 50/50 are
genuinely harder to call, and the engine correctly discloses this rather than manufacturing
a false lean. Narrowing this gap further requires better signals for close matchups, not
cascade tuning — the cascade's own history is the evidence.

**Overall accuracy:** 61.5% (pre-fix backfill) → 64.6% (post-fix fold-185 test).
The +3.1 pp reflects both corpus composition change (backfill vs. walk-forward fold) and the
removal of the cascade's negative contribution. These two effects cannot be fully disentangled
in a single-fold run; the directional improvement is clear but the exact attribution is not.

---

## 8. Follow-up gate: HighDisagreement-only (2026-08-08)

**Audit:** `auditTieBreakBaseline.ts` — same-cohort test-segment analysis, n=83,738 rows.

After the cascade removal (§1), `tieBreakerApplied: true` still fired for any within-TIE_BAND
raw ensemble, regardless of model agreement level. This was originally framed as a "UX/trust fix,
not an accuracy fix" — honest disclosure was worth the INSUFFICIENT_EDGE recommendation even if
it didn't help accuracy. The full-corpus audit disproved this framing:

| Agreement level | No tie-break | Tie-break fired | Δ |
|---|---|---|---|
| HighDisagreement | 50.91% | 52.36% | **+1.45pp** (within noise) |
| Mixed | 87.41% | 67.30% | **−20.11pp** |
| Moderate | 73.44% | 56.41% | **−17.03pp** |
| Strong | 67.59% | 56.29% | **−11.30pp** |
| **Overall** | **66.84%** | **53.50%** | **−13.34pp** |

The tie-break was firing on 28.2% of test-segment rows and imposing a −13.34pp accuracy cost. Only
HighDisagreement showed any benefit (+1.45pp, within noise) — the only category where the "models
are genuinely split" framing is accurate.

**Fix (gate in `index.ts`):** After `modelAgreement` is finalized (post-specialist and
post-simulator), a `tieBreakerGated` override sets `applied = false` when
`modelAgreement !== "HighDisagreement"`. This does NOT change the probability
(`adjustedProbability === rawEnsembleProbability` always — the cascade has been removed). It only
changes the `applied` flag so Strong/Moderate/Mixed near-50% predictions resolve via normal
confidence tiers (`LOW_CONFIDENCE` at narrow margins) instead of being forced to
`INSUFFICIENT_EDGE`.

**Fallback for previously-gated rows:**
- Strong + margin < 3pp: `LOW_CONFIDENCE` (was `INSUFFICIENT_EDGE`)
- Moderate + margin < 3pp: `LOW_CONFIDENCE` (was `INSUFFICIENT_EDGE`)
- Mixed + margin < 8pp: `INSUFFICIENT_EDGE` via recommendation rule r2 (unchanged — rule r2
  independently catches Mixed+narrow-margin regardless of the tie-break flag)

**Tests added:** `index.test.ts` — two new tests:
1. Symmetric inputs (near-50%, non-HighDisagreement) → `tieBreakerApplied = false`, no
   `INSUFFICIENT_EDGE`, `tieBreakerNote = null`.
2. Opposing-signal inputs (surfaceElo vs recentForm conflict) → IF the ensemble lands within
   TIE_BAND AND produces HighDisagreement, `tieBreakerApplied = true` and `INSUFFICIENT_EDGE`.

**Consistency with prior finding (Task 8A):** 8A measured tie-break accuracy at 53.28% on
paper_trade_shadow. The full-corpus historical test confirmed 53.50% — within 0.22pp, consistent
across different run_kinds. The "UX/trust fix, kept as-is" framing in 8A is **superseded** by
this gate; refer to `auditTieBreakBaseline.ts` for reproducible SQL.

---

## 9. Regression guard

`artifacts/api-server/src/services/predictionEngine/tieBreakers.test.ts` — already in place.
Asserts `adjustedProbability === rawInput` and `decidingStep === null` for all within-band
inputs. Will fail immediately if a future change re-introduces directional nudging.

No code changes are required by this task beyond the audit doc itself (pre-§8 scope).
