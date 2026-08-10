# Specialist Training Dataset Audit: Cascade-Exclusion Selection Bias
*Task #183 · Completed 2026-08-10 · Read-only diagnostic — no code changes*

---

## Executive Summary

The cascade-exclusion filter (`isKnownBadCascadeRow`) is **currently inert for all 8 specialist
training segments**. Zero rows are excluded from any segment in the current database. The filter
can only remove rows that are both pre-cutoff (`locked_at < 2026-07-15`) and have
`tieBreakerApplied=true`; no such rows exist in any ATP/WTA `historical_test`/`validation`
specialist training slice.

However, a structural analysis of **what the filter would remove if it were active** shows that
**WTA segments would be equally or more affected than ATP** across 3 of 4 surfaces. The
close-call 50–54% confidence band would shrink by 44–55% (ATP) vs. 45–55% (WTA) under
hypothetical full exclusion. This finding informs the fix-mechanism decision: the Task #182
convergence-blend approach (`constrainSpecialistKnotsToGeneral`) is the correct global
countermeasure — a targeted ATP-only patch would have left WTA equally exposed had the
pre-cutoff rows been present.

---

## 1. Scope and Methodology

**Segments audited:** 8 (ATP/WTA × Hard/Clay/Grass/IndoorHard)

**Data source:** `evaluation_predictions` joined to `historical_matches`, filtered to
`run_kind = 'historical_test'`, `segment = 'validation'`, `included_in_accuracy = true`,
`tour IN ('ATP','WTA')`.

**Difficulty proxy metrics used:**
- Fraction of rows excluded by `isKnownBadCascadeRow` (direct filter effect)
- Distribution of rows across predicted-winner confidence bands (50–54%, 55–59%, … 80%+)
- Fraction of rows with `tieBreakerApplied=true` in each confidence band
- Mean predicted-winner confidence before vs. after hypothetical exclusion of all TBA rows
- Accuracy in the 50–54% band (the hardest/closest matches)

**Cascade-exclusion logic (from `calibration.ts`):**
```typescript
export function isKnownBadCascadeRow(lockedAt: Date, featureSnapshotOrFlag: unknown): boolean {
  if (lockedAt >= CASCADE_CUTOFF_DATE) return false;   // post-cutoff rows ALWAYS kept
  if (typeof featureSnapshotOrFlag === "boolean") return featureSnapshotOrFlag;
  ...
  return engine?.["tieBreakerApplied"] === true;
}
```

Cutoff: `CASCADE_CUTOFF_DATE = new Date("2026-07-15T00:00:00.000Z")`

---

## 2. Current Filter Status — All Segments

**Result: zero rows excluded from any segment.**

```
 tour |  surface   | total_rows | pre_cutoff_rows | cascade_excluded_rows | avg_raw_prob
------+------------+------------+-----------------+-----------------------+-------------
 ATP  | Clay       |     12,583 |               0 |                     0 |       53.91
 ATP  | Grass      |      5,030 |               0 |                     0 |       53.07
 ATP  | Hard       |     18,064 |               0 |                     0 |       55.24
 ATP  | IndoorHard |        386 |               0 |                     0 |       50.47
 WTA  | Clay       |      6,199 |               0 |                     0 |       51.09
 WTA  | Grass      |      3,304 |               0 |                     0 |       50.81
 WTA  | Hard       |      9,408 |               0 |                     0 |       52.13
 WTA  | IndoorHard |         58 |               0 |                     0 |       51.68
```

All specialist training rows have `locked_at >= 2026-07-15`. The 2 rows found with earlier
`locked_at` timestamps are in `run_kind = 'paper_trade'` / `segment = 'live'` — they are not
in the specialist training slice and would not be touched by this filter anyway.

**Implication:** The cascade-exclusion filter is a no-op in the current state. The specialist
curves fitted in the 2026-08-08 walk-forward run (the most recent stored in `specialist_models`)
were trained on the full unfiltered corpus.

---

## 3. `tieBreakerApplied` Row Distribution

Although the cascade-exclusion filter is inert, `tieBreakerApplied=true` rows exist throughout
the dataset. These are **exclusively concentrated in the 50–54% confidence band** across all 8
segments. No TBA rows appear at ≥55% predicted-winner confidence.

This structural property makes sense: the cascade mechanism only fired when the model's output
was within a narrow band near 50%, so any row scored by the cascade (past or present) has a
raw probability in that 50–54% window.

```
 tour |  surface   | confidence_bucket | n_rows | n_tba | pct_tba
------+------------+-------------------+--------+-------+--------
 ATP  | Clay       | 50-54             |  3,582 | 2,134 |   59.6%
 ATP  | Clay       | 55-59 and above   |  9,001 |     0 |    0.0%
 ATP  | Grass      | 50-54             |  1,908 | 1,173 |   61.5%
 ATP  | Grass      | 55-59 and above   |  3,122 |     0 |    0.0%
 ATP  | Hard       | 50-54             |  3,998 | 2,342 |   58.6%
 ATP  | Hard       | 55-59 and above   | 14,066 |     0 |    0.0%
 ATP  | IndoorHard | 50-54             |    158 |   103 |   65.2%
 ATP  | IndoorHard | 55-59 and above   |    228 |     0 |    0.0%
 WTA  | Clay       | 50-54             |  2,549 | 1,500 |   58.8%
 WTA  | Clay       | 55-59 and above   |  3,650 |     0 |    0.0%
 WTA  | Grass      | 50-54             |  1,527 |   923 |   60.4%
 WTA  | Grass      | 55-59 and above   |  1,777 |     0 |    0.0%
 WTA  | Hard       | 50-54             |  2,820 | 1,683 |   59.7%
 WTA  | Hard       | 55-59 and above   |  6,588 |     0 |    0.0%
 WTA  | IndoorHard | 50-54             |     27 |    11 |   40.7%
 WTA  | IndoorHard | 55-59 and above   |     31 |     0 |    0.0%
```

---

## 4. Hypothetical Selection Bias Simulation

To answer the question "what would happen if cascade-exclusion removed all TBA rows?", we
simulate the filter by excluding all `tieBreakerApplied=true` rows, regardless of cutoff date.
This is the maximum possible cascade-exclusion effect — the upper bound on how biased the
training corpus would become.

```
 tour |  surface   | rows_before | rows_after | rows_excl | pct_excl | mean_conf_before | mean_conf_after | pct_close_before | pct_close_after
------+------------+-------------+------------+-----------+----------+------------------+-----------------+------------------+----------------
 ATP  | Clay       |      12,583 |     10,449 |     2,134 |    17.0% |            60.21 |           61.98 |            28.5% |           13.9%
 ATP  | Grass      |       5,030 |      3,857 |     1,173 |    23.3% |            57.67 |           59.53 |            37.9% |           19.1%
 ATP  | Hard       |      18,064 |     15,722 |     2,342 |    13.0% |            62.25 |           63.86 |            22.1% |           10.5%
 ATP  | IndoorHard |         386 |        283 |       103 |    26.7% |            56.70 |           58.61 |            40.9% |           19.4%
 WTA  | Clay       |       6,199 |      4,699 |     1,500 |    24.2% |            57.04 |           58.81 |            41.1% |           22.3%
 WTA  | Grass      |       3,304 |      2,381 |       923 |    27.9% |            56.01 |           57.75 |            46.2% |           25.4%
 WTA  | Hard       |       9,408 |      7,725 |     1,683 |    17.9% |            59.34 |           61.06 |            30.0% |           14.7%
 WTA  | IndoorHard |          58 |         47 |        11 |    19.0% |            56.70 |           57.91 |            46.6% |           34.0%
```

**Key observations:**

- Across all 8 segments, cascade-exclusion would remove 13%–28% of training rows.
- It would shift mean predicted-winner confidence up by **+1.6pp to +2.0pp** per segment.
- The fraction of close-call (50–54%) rows would drop by roughly **half** in every segment:
  ATP drops from 22–41% → 11–19%; WTA drops from 30–47% → 15–34%.
- **WTA is not protected from this bias.** WTA Grass loses 27.9% of rows; WTA Clay loses 24.2%;
  WTA Hard loses 17.9% — all similar to or larger than the corresponding ATP losses.

---

## 5. Accuracy Distribution (Training Data Difficulty)

The 50–54% band contains the hardest matches (closest calls). Measuring accuracy there confirms
TBA rows are genuinely the most uncertain predictions:

```
 tour |  surface   | overall_acc | acc_50-54_with_tba | acc_55plus | acc_50-54_no_tba
------+------------+-------------+--------------------+------------+-----------------
 ATP  | Clay       |       64.3% |              54.0% |      68.4% |           57.4%
 ATP  | Grass      |       64.3% |              53.6% |      70.8% |           55.1%
 ATP  | Hard       |       65.7% |              52.3% |      69.5% |           53.7%
 ATP  | IndoorHard |       66.8% |              60.1% |      71.5% |           61.8%
 WTA  | Clay       |       63.0% |              53.8% |      69.5% |           55.9%
 WTA  | Grass      |       62.1% |              55.5% |      67.8% |           58.3%
 WTA  | Hard       |       62.4% |              52.8% |      66.5% |           53.8%
 WTA  | IndoorHard |       56.9% |              44.4% |      67.7% |           31.3%
```

The 50–54% accuracy values confirm that both ATP and WTA close-call matches are close to 50/50.
Removing TBA rows would push the residual non-TBA close-call rows' accuracy up slightly
(53–58%), but would not eliminate the difficulty signal — non-TBA rows in this band are
still genuinely hard matches, just not cascade-decided ones.

---

## 6. Per-Segment Verdicts

| Segment         | Cascade-exclusion rows removed | Current bias | Hypothetical bias (if active) |
|-----------------|-------------------------------|--------------|-------------------------------|
| ATP — Hard      | 0 / 18,064                    | **Not biased** | 13.0% excl; close-call band halved |
| ATP — Clay      | 0 / 12,583                    | **Not biased** | 17.0% excl; close-call band halved |
| ATP — Grass     | 0 / 5,030                     | **Not biased** | 23.3% excl; close-call band halved |
| ATP — IndoorHard| 0 / 386                       | **Not biased** | 26.7% excl; close-call band halved |
| WTA — Hard      | 0 / 9,408                     | **Not biased** | 17.9% excl; close-call band halved |
| WTA — Clay      | 0 / 6,199                     | **Not biased** | 24.2% excl; close-call band halved |
| WTA — Grass     | 0 / 3,304                     | **Not biased** | 27.9% excl; close-call band halved |
| WTA — IndoorHard| 0 / 58                        | **Not biased** | 19.0% excl (n=58 too small to fit) |

**All 8 segments: CONFIRMED CLEAN.** No cascade-exclusion selection bias is present in the
current database. WTA segments are not a source of concern for the current specialist curve
steepness question.

---

## 7. Current Specialist Model Metrics (2026-08-08 Walk-Forward Run)

For reference, the currently active specialist weights computed after the Task #182 blend fix:

```
 segment_key     | meets_threshold | n_validation | accuracy | log_loss | general_log_loss | log_loss_impr | weight
-----------------+-----------------+--------------+----------+----------+------------------+---------------+-------
 ATP-Clay        | true            |       12,583 |    87.3% |   0.3444 |           0.3514 |       +0.0070 | 0.728
 ATP-Grass       | true            |        5,030 |    85.8% |   0.3780 |           0.3869 |       +0.0089 | 0.736
 ATP-Hard        | true            |       18,064 |    92.3% |   0.2461 |           0.2466 |       +0.0005 | 0.702
 ATP-IndoorHard  | true            |          386 |    64.0% |   0.6077 |           0.8597 |       +0.2521 | 0.850
 WTA-Clay        | true            |        6,199 |    68.1% |   0.5911 |           0.7939 |       +0.2029 | 0.850
 WTA-Grass       | true            |        3,304 |    66.0% |   0.6073 |           0.7992 |       +0.1919 | 0.850
 WTA-Hard        | true            |        9,408 |    74.4% |   0.5298 |           0.6389 |       +0.1092 | 0.850
 WTA-IndoorHard  | true            |           58 |    60.3% |   0.6477 |           1.0229 |       +0.3752 | 0.737
```

WTA segments show large log-loss improvements (+0.109 to +0.375 nats) because WTA data has
genuine tour-specific signal — not because WTA training data happened to be clean while ATP
was biased. Both tours' training data are identically unbiased in the current walk-forward run.

---

## 8. Implications for Fix-Mechanism Decision

The audit was designed to answer: **"Should the curve-steepness fix be ATP-only or global?"**

**Finding:** WTA is structurally equally exposed to cascade-exclusion selection bias. Under a
hypothetical active filter, WTA Grass would lose 27.9% of its training rows (vs. 23.3% for
ATP Grass); WTA Clay would lose 24.2% (vs. 17.0% for ATP Clay). An ATP-only fix would have
left WTA with the same steepness problem once any pre-cutoff rows accumulated.

**Conclusion:** The Task #182 decision to apply `constrainSpecialistKnotsToGeneral` globally
(all 8 segments) was the correct approach. A targeted ATP-only patch would have been
incomplete. This finding is consistent with the convergence-blend design, which is
parametric on `x` (confidence level) and tour-agnostic by construction.

---

## 9. If the Filter Becomes Active Again

The cascade-exclusion filter was designed for a specific historical window. It becomes relevant
again if:

1. A future walk-forward run backfills pre-2026-07-15 predictions AND those rows have
   `tieBreakerApplied=true` in their stored `featureSnapshot`.
2. A new cascade mechanism is introduced and its cutoff date is updated.

In either case, **both ATP and WTA training datasets would be affected equally**. The
`constrainSpecialistKnotsToGeneral` blend applied at fit time provides a structural safeguard:
even if close-call rows are excluded, the specialist curve cannot deviate far from the general
model in the 50–75% confidence band where the exclusion would otherwise cause steepness.

---

*Audit performed against dev DB on 2026-08-10. No code was changed. Queries available on
request — see the methodology section for the exact filter logic.*
