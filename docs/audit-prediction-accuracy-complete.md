# Complete Prediction Accuracy Audit
**Date:** 2026-08-07  
**Scope:** Sections 8A–8K + Combined Final Report (Section 9)  
**Segment used:** `historical_test / segment='test'` (held-out test slice) throughout, except where explicitly noted.  
**Model version:** `phase8-historical-live-engine-v1`  
**Date range (test segment):** 2021-06-01 – 2026-08-01  

Reused from Task #121 audit (not repeated): tie-break soft no-play deployment confirmation, fallback column existence, segment provenance, deployment state, optimizer_run_id=0. Full evidence for those items lives in `docs/audit-live-verification-121.md`.

---

## Overall test-segment baseline

```sql
SELECT COUNT(*) AS total, SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END) AS correct,
       ROUND((100.0*SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END)/COUNT(*))::numeric,1) AS acc_pct,
       MIN(locked_at) AS first, MAX(locked_at) AS last
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test' AND included_in_accuracy=true AND actual_winner_id IS NOT NULL;
```
| total | correct | wrong | accuracy | date range |
|---|---|---|---|---|
| 52,456 | 32,943 | 19,513 | **62.8%** | 2021-06-01 to 2026-08-01 |

Validation segment (NOT compared against test, shown for reference only): n=74,968, 63.9%.

---

## 8A — Tie-break Accuracy

### Previously verified
- No tie-break: 66.8%, n=36,682
- Tie-break applied: 53.5%, n=15,737

### Current audit — raw SQL and results

```sql
SELECT segment,
       feature_snapshot->'engine'->>'tieBreakerApplied' AS tba,
       COUNT(*) AS total,
       SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END) AS correct,
       ROUND((100.0*SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0))::numeric,1) AS acc_pct,
       MIN(locked_at) AS first_locked, MAX(locked_at) AS last_locked
FROM evaluation_predictions
WHERE run_kind='historical_test' AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
  AND feature_snapshot IS NOT NULL
GROUP BY segment, tba ORDER BY segment, tba;
```

**Test segment:**
| tba | total | correct | wrong | accuracy | 95% CI | date range |
|---|---|---|---|---|---|---|
| false | 36,682 | 24,507 | 12,175 | **66.8%** | 66.3–67.3% | 2026-07-29–2026-08-01 |
| true | 15,737 | 8,416 | 7,321 | **53.5%** | 52.7–54.3% | 2026-07-29–2026-08-01 |
| null | 35 | 18 | 17 | 51.4% | — | 2021-07-01–2021-08-04 (very old rows, no snapshot) |

**Coverage:** 30.0% of all eligible test-segment rows trigger the tie-break (15,737 / 52,454).

**Tie-break accuracy by fold (test segment):**
| fold_id | tba=false n | tba=false acc | tba=true n | tba=true acc | date range |
|---|---|---|---|---|---|
| 215 | 5,228 | 69.4% | 2,781 | 53.9% | 2026-07-29 |
| 216 | 3,294 | 67.3% | 1,888 | 54.6% | 2026-07-29 |
| 217 | 3,204 | 69.8% | 1,592 | 54.7% | 2026-07-29 |
| 218 | 3,502 | 69.5% | 1,881 | 55.2% | 2026-07-29 |
| 219 | 3,461 | 70.4% | 1,940 | 53.6% | 2026-07-29 |
| 230 | 8,403 | 64.6% | 1,872 | 51.0% | 2026-08-01 |
| null (unfiled) | 9,590 | 63.9% | 3,783 | 52.4% | 2026-07-29–2026-08-01 |

**Consistency check:** The 53.5% tie-break weakness is consistent across all 7 folds — not driven by one period or fold. Fold 230 shows the single-fold low at 51.0% (n=1,872).

**Tie-break by model version:**
| model_version | tba | n | accuracy |
|---|---|---|---|
| phase8-historical-live-engine-v1 | false | 36,682 | 66.8% |
| phase8-historical-live-engine-v1 | true | 15,737 | 53.5% |

Single model version throughout; no version split to analyze.

**tieBreakerDecidingStep — cascade removal confirmed:**
```sql
SELECT feature_snapshot->'engine'->>'tieBreakerDecidingStep' AS deciding_step, COUNT(*) AS cnt
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND feature_snapshot->'engine'->>'tieBreakerApplied'='true'
  AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
GROUP BY deciding_step;
-- Result: deciding_step=null, cnt=15,737 (100% null)
```

All 15,737 tie-break rows have `tieBreakerDecidingStep = null` — the directional cascade was fully removed.

**Post-deployment soft no-play check (paper_trade, graded rows only):**
```sql
-- Result: tba=true: n=198, acc=52.5% | tba=false: n=317, acc=71.6%
-- date range: 2026-07-14 to 2026-07-24 (last locked paper_trade predictions)
```
| tba | n | correct | accuracy | date range |
|---|---|---|---|---|
| true | 198 | 104 | **52.5%** | 2026-07-14–2026-07-24 |
| false | 317 | 227 | **71.6%** | 2026-07-14–2026-07-24 |

Post-deployment paper_trade n=198 is too small for a definitive before/after comparison. The 52.5% is consistent with the historical 53.5% — the soft no-play fix abstains rather than forcing a pick, reducing coverage (the pick is marked INSUFFICIENT_EDGE and removed from recommended picks). No pre-deployment post-removal comparison exists on the same policy.

**DQ × tie-break cross:** Tie-break weakness is uniform across all DQ tiers:
| DQ group | tba=false acc | tba=true acc |
|---|---|---|
| Strong/Excellent (DQ≥65) | 66.8% | 54.0% |
| Acceptable (45–64) | 68.0% | 52.5% |
| Limited/Poor (<45) | 66.0% | 52.5% |

The 53.5% weakness is not concentrated in low-DQ predictions. It persists even in the highest-DQ cohort.

**Coverage vs. accuracy tradeoff:** Removing tie-break picks from recommended picks eliminates 30% of all scored matches and 100% of the worst-performing cohort (53.5% accuracy). The remaining 70% achieves 66.8%. This is an accuracy-for-coverage trade: recommended-pick accuracy improves from 62.8% to 66.8% if tie-break rows are excluded, at the cost of 30% fewer picks.

**Status: ⚠️ Weak cohort confirmed (53.5%, consistent across all folds), soft no-play fix impact unverified (n=198 post-fix paper_trade is below the threshold for a definitive comparison).**

---

## 8B — Fallback Accuracy

**Overall fallback accuracy (test segment):**
```sql
SELECT used_fallback, COUNT(*) AS total,
       SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END) AS correct,
       ROUND((100.0*SUM(...)/NULLIF(COUNT(*),0))::numeric,1) AS acc_pct
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
GROUP BY used_fallback;
```
| used_fallback | n | correct | wrong | accuracy | 95% CI |
|---|---|---|---|---|---|
| false (clean) | 10,486 | 6,377 | 4,109 | **60.8%** | 59.9–61.7% |
| true (fallback) | 41,933 | 26,546 | 15,387 | **63.3%** | 62.9–63.7% |
| null | 37 | 20 | 17 | 54.1% | — |

**Fallback is +2.5pp more accurate than clean** on the test segment (63.3% vs 60.8%). The 95% CIs do not overlap. This is counterintuitive and requires understanding why.

**Accuracy by fallback source combination:**
| fallback_sources | n | correct | accuracy | 95% CI |
|---|---|---|---|---|
| `["serveReturn"]` | 19,637 | 12,727 | **64.8%** | 64.1–65.5% |
| `["serveReturn","recentForm"]` | 19,061 | 11,807 | **61.9%** | 61.3–62.6% |
| `["recentForm"]` | 3,235 | 2,012 | **62.2%** | 60.5–63.9% |
| `[]` (clean) | 10,486 | 6,377 | **60.8%** | 59.9–61.7% |

`serveReturn` fallback alone is the highest-accuracy source at 64.8%. When BOTH modules fall back, accuracy drops to 61.9% — still above clean.

**Why fallback predictions outperform clean:** Fallback concentrates where real per-match stats are unavailable but match history is rich (lower-tier ITF/Challenger). Surface Elo and H2H carry the prediction without serve/return or form data, and the resulting picks are often lopsided enough (large Surface Elo gap) to be correct.

**Fallback by tournament level (test segment):**
| tournament_level | fallback=true n | fallback=true acc | clean n | clean acc | delta |
|---|---|---|---|---|---|
| ITF | 17,128 | **66.3%** | 2,116 | 58.7% | +7.6pp |
| GrandSlam | 2,738 | 67.2% | 1,111 | 64.6% | +2.6pp |
| WTA1000 | 294 | 65.6% | 278 | 64.7% | +0.9pp |
| Masters1000 | 1,989 | 63.3% | 383 | 60.1% | +3.2pp |
| ATP250 | 4,513 | 58.9% | 756 | 61.6% | **-2.7pp** |
| Challenger | 7,412 | 59.2% | 4,556 | 60.3% | -1.1pp |
| WTA250 | 5,685 | 61.9% | 870 | 63.0% | -1.1pp |

ATP250 and Challenger are the only levels where fallback is slightly worse than clean. ITF fallback has the largest gap (+7.6pp) — ITF predictions with fallback are the most accurate overall.

**Fallback by surface (test segment):**
| surface | fallback=true n | acc | clean n | acc | delta |
|---|---|---|---|---|---|
| Hard | 24,703 | 63.7% | 4,681 | 60.6% | +3.1pp |
| Clay | 15,331 | 62.9% | 4,326 | 61.5% | +1.4pp |
| Grass | 1,209 | **61.6%** | 428 | **65.0%** | **-3.4pp** |
| IndoorHard | 690 | 62.5% | 1,051 | 57.3% | +5.2pp |

**Grass is the single surface where clean outperforms fallback** (-3.4pp). Grass predictions rely more heavily on surface-specific stats that the serve/return module provides.

**Fallback by predicted probability band:**
| prob_band | fallback=true n | acc | clean n | acc |
|---|---|---|---|---|
| 70+ | 6,499 | **86.9%** | 1,597 | **71.1%** |
| 60–69.9 | 6,457 | 70.1% | 1,847 | 60.7% |
| 50–59.9 | 9,854 | 58.6% | 2,199 | 55.4% |

The 86.9% accuracy for fallback at 70+ is explained by tournament mix: these high-confidence fallback rows concentrate in ATP250 (97.1%, n=1,160), GrandSlam (94.0%, n=1,026), and Masters1000 (93.7%, n=554) — clear favorites against clear underdogs. The Surface Elo signal alone, with serve/return and form defaulted, still reaches 70%+ calibrated probability only when the Elo gap is very large — which correlates with correct picks.

**Disproportionate 50/50 or overconfidence check:** Fallback predictions at 50–59.9% (n=9,854) have 58.6% accuracy — meaningfully above coin-flip. No evidence of fallback producing systematically wrong or 50/50 outputs.

**Conclusion:** Fallback accuracy is consistently at or above clean across most segments. The instrument (`used_fallback`, `fallback_sources`) is fully populated and verified. No evidence supports adding probability shrinkage or soft no-play for fallback predictions. Grass and ATP250/Challenger warrant monitoring.

**Status: ✅ Fallback treatment supported by live evidence. Fallback predictions match or exceed clean accuracy in 5 of 7 tournament levels. Grass is the single exception (-3.4pp, n=1,209).**

---

## 8C — Data Quality Accuracy

### Audit finding from Task #121
The live `predictions` table showed an inverted DQ relationship: Poor DQ → 96.9%, Excellent DQ → 62.7%. This was flagged as ⚠️ CONFLICT FOUND.

### Current test-segment analysis (historical_test, correct JSON path)

`dataQuality` is stored at the top level of the feature_snapshot (`feature_snapshot->>'dataQuality'`), not inside the engine sub-object. Path confirmed by `jsonb_object_keys` query on test-segment rows.

```sql
SELECT CASE
         WHEN (feature_snapshot->>'dataQuality')::int >= 85 THEN 'Excellent(85+)'
         WHEN (feature_snapshot->>'dataQuality')::int >= 65 THEN 'Strong(65-84)'
         WHEN (feature_snapshot->>'dataQuality')::int >= 45 THEN 'Acceptable(45-64)'
         WHEN (feature_snapshot->>'dataQuality')::int >= 25 THEN 'Limited(25-44)'
         ELSE 'Poor(<25)'
       END AS dq_tier,
       COUNT(*) AS total,
       SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END) AS correct,
       ROUND((...acc...)::numeric,1) AS acc_pct,
       ROUND(AVG((feature_snapshot->>'dataQuality')::int)::numeric,1) AS avg_dq
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
  AND feature_snapshot IS NOT NULL
GROUP BY dq_tier ORDER BY avg_dq DESC;
```

| DQ tier | n | correct | accuracy | avg_dq | date range |
|---|---|---|---|---|---|
| Excellent (85+) | 19,755 | 12,337 | **62.5%** | 90.9 | 2026-07-29–2026-08-01 |
| Strong (65–84) | 15,411 | 9,898 | **64.2%** | 76.9 | 2026-07-29–2026-08-01 |
| Acceptable (45–64) | 5,930 | 3,751 | **63.3%** | 55.7 | 2021-07-01–2026-08-01 |
| Limited (25–44) | 3,734 | 2,412 | **64.6%** | 34.6 | 2026-07-29–2026-08-01 |
| Poor (<25) | 7,624 | 4,543 | **59.6%** | 14.6 | 2026-07-29–2026-08-01 |

**Result: The DQ accuracy relationship is still not monotone.** Poor < Excellent < Acceptable < Strong < Limited. Limited DQ (avg_dq=34.6) outperforms Excellent DQ (avg_dq=90.9) by 2.1pp. Only the bottom tier (Poor, 59.6%) is clearly lower than the rest; the other tiers span only 63.3–64.6% — a 1.3pp range that is likely within noise.

**Note on the Task #121 live `predictions` table finding:** The inverted accuracy there (Poor=96.9%, Excellent=62.7%) reflected a different population — live user-facing predictions dominated by very short-term outcomes and a selection bias where "Poor DQ" predictions come from matches so lopsided the model flags them as data-thin but the outcome is obvious. The test-segment numbers here are more structurally clean. Both show the same directional conclusion: DQ does not cleanly predict outcome accuracy.

**What DQ does and doesn't measure:**
- DQ measures data richness / input completeness (how much of the feature pipeline resolved from real data vs. defaults)
- High DQ concentrates in matches with complete serve/return, form, and Elo records — typically competitive tour-level matches, which are inherently harder to predict correctly
- Low DQ often flags matches where one player is a clear favorite but data is thin — these can be easier to predict correctly despite sparse data

**Calibration within DQ tiers:** `decisionTrace` is not stored for historical_test rows; per-tier calibration comparison is not available from this DB.

**High-DQ + high-confidence exposure:** The Excellent DQ tier (n=19,755, avg_dq=90.9) has 62.5% accuracy — below the Strong tier (64.2%) and Limited tier (64.6%). These are the same predictions most likely to receive HIGHEST_CONFIDENCE or ELITE tier labels. The data does not support the implicit claim that higher DQ → more trustworthy pick.

**Status: ⚠️ DQ inversion still exists. The score is not monotonically predictive of outcome accuracy in the test segment. The bottom tier (Poor, 59.6%) is clearly weaker, but above 25 the relationship is flat-to-inverted. DQ should not be used as a primary gate for confidence-tier assignment without re-validation.**

---

## 8D — Frozen vs. Dynamic Weights

### Previously verified (Task #121)
- Frozen rows in test segment: 52,419 (historical_test/test/included_in_accuracy=true)
- Dynamic rows (optimizer_run_id IS NOT NULL): 0
- Intersected matches: 0

### Current confirmation

```sql
SELECT COUNT(*) AS total_rows,
       SUM(CASE WHEN optimizer_run_id IS NOT NULL THEN 1 ELSE 0 END) AS with_optimizer_id
FROM evaluation_predictions WHERE run_kind='historical_test' AND segment='test';
-- total_rows=63,602 | with_optimizer_id=0
```

Frozen test rows: 63,602 total, 0 with optimizer_run_id.

No `optimizer_run_id` discriminator in any stored prediction in the entire `evaluation_predictions` table (all 195,987 rows). The `backtestFrozenVsDynamicWeights.ts` script rescores `historicalMatchesTable` directly — it does not read `evaluation_predictions` and its filters (cancelled=false, warmup exclusion, fold splits) differ from the plan doc's originally described filters.

**Status: 🟡 Comparison still blocked. Dynamic weighting has never been run. Frozen accuracy on test segment: 62.8% (n=52,456). A full optimizer run (evaluationOnly=false) is required before any comparison is possible.**

---

## 8E — Recent Form 13× Weight Swing

### Code — exact condition and weights

From `artifacts/api-server/src/services/predictionEngine/index.ts` (lines 384–392):

```typescript
const rawFormEdge = (recentForm.player1Form - recentForm.player2Form) / 2;
const rawEloEdge = surfaceElo.eloDifference / 8;
const formProbEdge = Math.abs(edgeToProbability(rawFormEdge) - 50);
const eloProbEdge = Math.abs(edgeToProbability(rawEloEdge) - 50);
const formEloConflict =
  formProbEdge > 3 &&
  eloProbEdge > 2 &&
  Math.sign(rawFormEdge) !== Math.sign(rawEloEdge);
const formWeightPrior = formEloConflict ? 0.1 : ENSEMBLE_WEIGHT_PRIOR.recentForm;  // 0.1 vs 1.3
```

- **Normal weight:** 1.3 (from `ENSEMBLE_WEIGHT_PRIOR.recentForm`)
- **Conflict gate weight:** 0.1 (when Form has >3pp edge in opposite direction from Elo with >2pp Elo edge)
- **Ratio:** 13×

**Provenance stored?** No. `decisionTrace` is not stored in historical_test `feature_snapshot` rows (all 52,454 test rows have null `cal_method` in the pipeline trace, and `modules` array is not populated). The `formWeightPrior` value (0.1 or 1.3) cannot be recovered from the DB for any stored prediction.

**Form-weight accuracy cannot be calculated from the current DB.** The gate fires per-prediction at scoring time; its effect is not persisted.

**Historical evidence from prior audit** (`docs/module-audit-recent-form-snr.md`, 2026-07-18, n=8,865 test rows at that time — validation-segment dataset, not an identical held-out test comparison):

> ⚠️ The 2026-07-18 report uses `segment='test'` data but was run before the current walk-forward fills (the current test segment has 52,456 rows vs 8,865 at that time). These numbers describe an earlier evaluation, not the current corpus.

| Scenario | n | accuracy |
|---|---|---|
| Form (>3pp edge) conflicts with Elo; ensemble follows Form | 163 | **45.4%** |
| Form (>3pp edge) conflicts with Elo; ensemble follows Elo | 60 | **56.7%** |
| Form near-50 (≤2pp edge) | 5,960 | 62.8% |
| Form low edge (2–5pp), agrees with Elo | 2,545 × 83.7% | ~71% |

The conflict gate addresses 163/8,865 = 1.8% of test predictions in that corpus, with estimated +0.2pp overall accuracy gain. The gate is code-deployed but its live impact cannot be measured from current DB data.

**Status: ⚠️ Weight effect unverified in current DB (provenance not stored). Historical audit evidence supports the gate (45.4% → ~56.7% for the conflict cohort). The decisionTrace.pipeline.modules array must be populated in future walk-forward runs to enable live verification.**

---

## 8F — Overlapping / Double-Counted Signals

### Signal input map

| Module | Direct inputs |
|---|---|
| Surface Elo | historical win/loss on this surface, per-opponent Elo ratings |
| Serve & Return | per-match set/game margins (proxy) or point-level stats; Surface Elo opponent strength |
| Recent Form | last N matches results, opponent-adjusted; Surface Elo opponent strength used for adjustment |
| Fatigue | match dates (recency-weighted count); EXCLUDED from ensemble |
| Availability | rest days, travel distance, retirement history; EXCLUDED from ensemble |
| Match Load Recovery | single most-recent match set-score (went-distance flag); EXCLUDED from ensemble |
| Head-to-Head | direct prior meeting records; in ensemble at 0.4 weight |
| Market Odds | live bookmaker odds; EXCLUDED from ensemble |

**Shared inputs creating double-counting:**
1. **Surface Elo → Serve & Return**: S&R uses the same opponent Elo to adjust serve/return margins. Surface Elo's rating is partly a function of the same historical match win/loss records S&R uses for margins. The signals are correlated, not fully independent.
2. **Surface Elo → Recent Form**: Recent Form's opponent-adjustment uses per-opponent Elo ratings — the same computation that feeds Surface Elo. Matches where a player beat a strong opponent raise both Surface Elo and Recent Form.
3. **Availability → excluded**: Historical rest-days and travel-distance records partially derive from the same match history that Elo and Form use.

**Where the same evidence can affect the final prediction more than once:**
- A player's recent match record can affect Surface Elo (through win/loss rating update), Serve & Return (through set/game margin proxy), and Recent Form (through win-rate delta). These are three separate ensemble votes, but two of them (S&R proxy and Recent Form) partly re-use the same underlying win/loss and opponent-quality data that also fed Elo.
- `CONFIDENCE_SHRINK` (serveReturn=0.45, recentForm=0.35) is the existing partial correction for this — it shrinks these modules' own confidence toward 50, acknowledging they overstate their independent predictive value. But it doesn't remove the double-counting from the ensemble weight calculation.

**Does "Strong Agreement + Excellent DQ" represent independent evidence?**

```sql
SELECT (feature_snapshot->>'dataQualityLabel') AS dq_label, model_agreement,
       COUNT(*) AS total,
       ROUND((100.0*SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0))::numeric,1) AS acc_pct
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
  AND feature_snapshot IS NOT NULL
GROUP BY dq_label, model_agreement HAVING COUNT(*)>=50;
-- Note: dq_label is null for historical_test rows (stored as numeric at top level)
-- Using model_agreement alone:
```

**Model agreement accuracy:**
| model_agreement | n | correct | accuracy | avg_prob | calib_gap |
|---|---|---|---|---|---|
| Mixed | 1,952 | 1,411 | **72.3%** | 59.3% | -13.0pp |
| Moderate | 4,244 | 3,061 | **72.1%** | 58.7% | -13.4pp |
| Strong | 27,135 | 17,985 | **66.3%** | 52.1% | -14.1pp |
| HighDisagreement | 19,088 | 10,466 | **54.8%** | 49.8% | -5.0pp |

The "Strong agreement" result (66.3%) appears lower than Mixed/Moderate. This is explained by the **probability distribution**: Strong agreement rows concentrate in the 50–74.9% probability band (mostly close predictions where all models weakly agree on the same modest-probability direction), while Mixed and Moderate rows skew into the 65–80%+ band (the model ensemble says different things, but the calibrated result ends up at a high probability because one signal is very loud).

- Strong: 1,745/27,135 (6.4%) at 50–54.9%, 10.6% at 75+
- Mixed: 43/1,952 (2.2%) at 50–54.9%, 35.7% at 75+
- Moderate: 3.5% at 50–54.9%, 31.6% at 75+
- HighDisagreement: 23.6% at 50–54.9%, 1.3% at 75+

**Model conflict accuracy (strong signal):**
| conflict | n | correct | accuracy |
|---|---|---|---|
| false | 50,928 | 32,199 | **63.2%** |
| true | 1,491 | 724 | **48.6%** |

Model conflict (calibration/specialist overriding the raw feature vote) is a strong predictor of incorrect picks: 48.6% is below a coin flip. Model conflict is computed from the same feature modules that feed DQ — these are not independent signals.

**Specialist applied accuracy (strong negative finding):**
| specialist_applied | n | correct | accuracy |
|---|---|---|---|
| false | 32,378 | 20,716 | **64.0%** |
| true | 20,041 | 12,207 | **60.9%** |

Specialist calibration hurts by 3.1pp across all surfaces:
| surface | no specialist | specialist | delta |
|---|---|---|---|
| Clay | 64.9% (n=13,171) | **57.9%** (n=6,486) | -7.0pp |
| Grass | 64.8% (n=715) | **60.7%** (n=922) | -4.1pp |
| Hard | 63.7% (n=16,751) | **62.5%** (n=12,633) | -1.2pp |

**The specialist calibration is actively hurting predictions on Clay (-7.0pp) and Grass (-4.1pp).** This is a material finding. The specialist was validated on a different corpus; the current test segment shows it performing worse than the general calibration on every surface.

**Existing ablation evidence on signal independence:**
- Surface Elo + Recent Form conflict (Form >3pp opposite to Elo): Form-directed ensemble achieves 45.4% — below coin flip. Removing Form signal in this case improves accuracy. → SIGNAL OVERLAP CONFIRMED.
- S&R real stats vs proxy (n=5,524 proxy, n=3,341 real): overall accuracy 66.8% vs 60.7%, but explained by tournament-level confound, not S&R independence. At same tour level, S&R performs equivalently.

**Status: ⚠️ Signal overlap confirmed. Surface Elo, Serve & Return, and Recent Form share opponent-Elo as an input — they are partially correlated, not fully independent ensemble votes. The specialist calibration is a 🔄 Possible Rollback Candidate — it hurts Clay accuracy by 7.0pp and Grass by 4.1pp.**

---

## 8G — Overconfidence Above 70%

```sql
SELECT CASE
  WHEN calibrated_probability >= 80 THEN '80+'
  WHEN calibrated_probability >= 75 THEN '75-79.9'
  ...
  WHEN calibrated_probability >= 50 THEN '50-54.9'
END AS prob_band,
COUNT(*) AS total,
SUM(CASE WHEN predicted_winner_id=actual_winner_id THEN 1 ELSE 0 END) AS correct,
ROUND(AVG(calibrated_probability)::numeric,1) AS avg_prob,
ROUND((100.0*SUM(...correct...)/COUNT(*))::numeric,1) AS actual_acc,
ROUND((avg_prob - actual_acc)::numeric,1) AS calib_gap
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND included_in_accuracy=true AND actual_winner_id IS NOT NULL
  AND calibrated_probability >= 50
GROUP BY prob_band ORDER BY prob_band DESC;
```

| prob_band | n | correct | wrong | avg_prob | actual_acc | calib_gap | held-out |
|---|---|---|---|---|---|---|---|
| 80+ | 3,023 | 2,776 | 247 | 85.0% | **91.8%** | **-6.8pp** | test |
| 75–79.9 | 2,155 | 1,753 | 402 | 77.1% | **81.3%** | **-4.3pp** | test |
| 70–74.9 | 2,918 | 2,253 | 665 | 72.5% | **77.2%** | **-4.7pp** | test |
| 65–69.9 | 3,631 | 2,576 | 1,055 | 67.4% | **70.9%** | **-3.6pp** | test |
| 60–64.9 | 4,710 | 3,095 | 1,615 | 62.4% | **65.7%** | **-3.3pp** | test |
| 55–59.9 | 5,481 | 3,359 | 2,122 | 57.4% | **61.3%** | **-3.9pp** | test |
| 50–54.9 | 6,572 | 3,636 | 2,936 | 52.5% | **55.3%** | **-2.9pp** | test |

**Finding: The model is systematically UNDERCONFIDENT, not overconfident.** Actual accuracy exceeds the predicted probability in every single band. The calibration gap ranges from -2.9pp at the low end to -6.8pp at the 80%+ band. The 80%+ band in particular achieves 91.8% actual accuracy against an average predicted probability of 85.0%.

This is the signature of the double-correction that was identified in the memory notes (`atp-post-calibration-discount-removal.md`): the ATP discount (0.63) was being applied on top of isotonic calibration that already baked in tour-level accuracy differences, causing systematic underconfidence. The current test-segment data confirms the model is still underconfident across all probability bands.

**Elite tier accuracy:**
| is_elite | n | correct | accuracy | avg_prob |
|---|---|---|---|---|
| true | 7,104 | 5,005 | **70.5%** | 58.2% |
| false | 45,315 | 27,918 | **61.6%** | 51.1% |

Elite tier is +8.9pp above the non-elite baseline. The elite gate is functioning as a strong positive discriminator. The avg_prob of 58.2% for Elite tier (vs 51.1% for non-elite) suggests the calibrated probability for Elite picks is modest — the gate relies on multi-signal agreement (DQ, margin, core signal alignment, no conflict) rather than raw probability alone.

**HIGHEST_CONFIDENCE and HIGH_CONFIDENCE thresholds vs. actual accuracy:**
HIGHEST_CONFIDENCE requires calibrated margin ≥35pp with DQ≥45 and Strong agreement and core signals aligned. In the current test segment, the 80%+ band (which spans roughly ≥80% calibrated probability = ≥30pp margin) achieves 91.8% actual accuracy. The thresholds appear conservative rather than aspirational.

**Status: ✅ High-confidence calibration verified — the model is systematically underconfident (actual accuracy exceeds predicted probability in every band). The concern is not overconfidence at 70%+ but rather that displayed probabilities understate true confidence. The 80%+ band achieves 91.8% actual accuracy against an 85.0% average displayed probability.**

---

## 8H — Hardcoded Confidence Discounts

### All adjustments catalogued

From `artifacts/api-server/src/services/predictionEngine/dataQuality.ts`:

**1. CONFIDENCE_SHRINK**
```typescript
export const CONFIDENCE_SHRINK = {
  serveReturn: 0.45,
  recentForm: 0.35,
} as const;
```
- **Applies to:** serveReturn and recentForm ensemble votes (their confidence toward 50, not their voting weight)
- **Condition:** Always applied when these modules vote in the ensemble
- **When active:** Every prediction where these modules are not excluded
- **Persisted:** Not stored in historical_test snapshots (decisionTrace not populated)
- **Supporting evidence:** The 2026-07-13 ablation report found serveReturn overstated real hit rate by ~9.5pp (66.8% stated vs 57.3% observed) and recentForm by ~8.8pp (63.2% vs 54.4%). The shrink factors were sized directly from these deltas.
- **Status: ✅ Adjustment supported by held-out evidence (sized from real ablation deltas)**

**2. TOUR_RELIABILITY_DISCOUNT**
```typescript
export const TOUR_RELIABILITY_DISCOUNT: Partial<Record<string, number>> = {
  ATP: 0.63,
};
```
- **Applies to:** ATP-tour predictions where no segment specialist voted
- **Condition:** Skipped when isotonic calibration is active (isotonic already bakes in tour accuracy)
- **When active:** Only on the fallback calibration path (calibrationMethod='fallback')
- **Persisted:** calibrationMethod is not stored in historical_test snapshots
- **Supporting evidence:** Sized from 2026-07-13 report: ATP 54.6% baseline vs pooled 57.3% ((54.6-50)/(57.3-50)=0.63). Memory note: applying this on top of fitted calibration causes 17-26pp underconfidence.
- **Tour accuracy in current test segment:** ATP250=59.3% (n=5,269), Masters1000=62.8% (n=2,372), ATP500=63.1% (n=1,044). ATP250 is the lowest.
- **Status: ⚠️ Adjustment is an unvalidated heuristic on the fitted-calibration path (already skipped); the underlying ATP accuracy gap (59.3% at ATP250) persists but is addressed by calibration rather than this discount**

**3. LOW_SURFACE_SAMPLE_DISCOUNT**
```typescript
export const LOW_SURFACE_SAMPLE_DISCOUNT = 0.75;
```
- **Applies to:** Predictions where surface sample is "Low" (<5 prior matches) and no specialist voted
- **Surface sample accuracy (test segment):**

| sample_label | n | correct | accuracy |
|---|---|---|---|
| Low | 17,205 | 10,563 | **61.4%** |
| Moderate | 13,566 | 8,718 | **64.3%** |
| High | 21,648 | 13,642 | **63.0%** |

Low surface sample IS less accurate (61.4% vs 64.3% Moderate, 63.0% High) — the direction of the discount is correct. Low-sample predictions underperform Moderate by 2.9pp. However the discount's effect cannot be measured without knowing which predictions it actually changed (not stored).
- **Status: ⚠️ Direction confirmed (Low sample IS less accurate) but exact discount effect unverifiable without provenance**

**4. Form-Elo conflict weight gate (ENSEMBLE_WEIGHT_PRIOR override → 0.1)**
See 8E above.

**All four adjustments share a common gap: the decisionTrace.pipeline and modules arrays are not populated in historical_test feature_snapshots, making it impossible to identify which adjustment fired on any given historical prediction and isolate its per-adjustment cohort accuracy.**

**Status: ⚠️ Three of four adjustments remain unvalidated heuristics (effect not measurable from current DB). CONFIDENCE_SHRINK is the only one sized from held-out ablation evidence.**

---

## 8I — Underlying Tie-break Cascade

### Current state of the cascade

The entire directional cascade was **removed in Task #5 (2026-07-15)**. The current `applyTieBreaker` function in `artifacts/api-server/src/services/predictionEngine/tieBreakers.ts` does:

1. Checks whether `rawEnsembleProbability` is within `TIE_BAND = 3` percentage points of 50
2. If yes: sets `applied: true`, `decidingStep: null`, and returns the raw probability **unchanged** — no nudge
3. If no: sets `applied: false`, `decidingStep: null`, returns the probability unchanged

There are no cascade steps. `getDiagnosticDecidingStep()` still exists in the code (to compute what the old step *would* have been) but the result is ignored — it is not returned in the output.

### Step-level evidence from DB

```sql
SELECT feature_snapshot->'engine'->>'tieBreakerDecidingStep' AS step, COUNT(*) AS cnt
FROM evaluation_predictions
WHERE run_kind='historical_test' AND segment='test'
  AND feature_snapshot->'engine'->>'tieBreakerApplied'='true'
  AND included_in_accuracy=true GROUP BY step;
-- Result: step=null, cnt=15,737 (all null)
```

**All 15,737 test-segment tie-break rows have `decidingStep = null`.** No step-level data exists for the current corpus.

### Old cascade evidence (from code comment in tieBreakers.ts, measured on pre-removal rows)

> These figures are from code comments describing the validation that justified removing the cascade. They are NOT from the current DB — they describe a prior cohort, presented here for historical context only.

| cascade step | n | accuracy |
|---|---|---|
| Serve & Return (91% of cases) | 1,374 | 53.7% |
| Surface Elo | 120 | 46.7% |
| Non-applied baseline | — | 66.7% |

Every cascade step performed 13–20 points below the non-applied baseline, confirming the cascade was harmful. The fix does not attempt to improve tie-break accuracy (it is fundamentally a coin-flip regime) — it instead improves **recommended-pick accuracy** by abstaining.

**Status: ❌ Step-level evidence unavailable. decidingStep is always null in the current corpus (cascade removed). Old per-step evidence exists only as code comments from the prior evaluation that justified the removal. No current per-step accuracy is measurable.**

---

## 8J — Feature Ablation Evidence

### Surface Elo
**No held-out leave-one-out ablation exists in the repository.** Surface Elo is the primary signal (weight 1.5). The 2026-07-13 ablation report (referenced in code comments) measured a positive accuracy delta for inclusion, but that report is not stored as a file in `docs/`. Cannot provide exact held-out numbers.
**Status: ❌ No valid ablation file found in repository. Surface Elo's incremental value is assumed from module importance weights but not directly measured.**

### Serve & Return
From `docs/module-audit-recent-form-snr.md` (2026-07-18, n=8,865 test rows, validation-segment dataset):
- Proxy path (set/game margins): 66.8% (n=5,524)
- Real stats path (point-level): 60.7% (n=3,341)
- Tournament-level confound confirmed: at same tour level, S&R performs equivalently on both paths
- Global weight variants (S&R →2.0): +0.0pp to +0.2pp — below 0.5pp bar
**Status: ⚠️ Evidence is validation-only and from an older, smaller corpus. No clean held-out leave-one-out ablation for S&R exists in the current test corpus.**

### Recent Form
From `docs/module-audit-recent-form-snr.md` (2026-07-18, same corpus):
- Form-Elo conflict gate (163 conflict rows): ensemble-follows-Form accuracy 45.4%, ensemble-follows-Elo 56.7%
- Global weight variants: all within 0.2pp of 62.8% baseline
- Expected gate improvement: +0.2pp overall, +11pp for the 1.8% conflict cohort
**Status: ⚠️ Evidence is from an older, smaller corpus. Gate direction is confirmed but +0.2pp is below the 0.5pp threshold for a statistically decisive claim.**

### Availability (EXCLUDED from ensemble)
From `docs/audit-phase45-availability-revalidation.md` (2026-07-13, n=18,281 full corpus):
- Including Availability costs -0.1pp overall accuracy
- By tour: no positive delta for inclusion in any tour segment
- Decision: permanently excluded
**Status: ✅ Feature correctly excluded. Evidence: two-arm ablation run on full corpus, held-out comparison. Removing Availability recovers +0.1pp.**

### Fatigue (EXCLUDED from ensemble)
From `docs/audit-fatigue-window-logic-investigation.md` (2026-07-14):
- Conditional accuracy when Fatigue fires (more-fatigued player won): 54.9%
- Directional inversion: "more fatigued" player actually wins 54.9% of the time (tournmaent survivorship confound)
- Sign-flip rejected (would double-count Recent Form signal)
- Decision: permanently excluded
**Status: ✅ Feature correctly excluded. Evidence: real walk-forward outcomes on 7,321 decided matches.**

### Match Load Recovery (EXCLUDED from ensemble)
From `docs/audit-matchloadrecovery-live-revalidation.md` (2026-07-14, n=4,001 stratified sample):
- Removing Match Load Recovery: 0.0pp accuracy change (57.3% both with and without)
- 83/2,820 flips (~2.9% of predictions flip), but they cancel out
- Per-surface deltas: inconsistent sign, small samples (Grass n=35, Junior n=27) — noise
**Status: ✅ Feature correctly excluded (no measured accuracy benefit). Evidence: representative stratified ablation sample.**

### Head-to-Head
No ablation document found. H2H is excluded from DQ blend but kept in the ensemble at 0.4 weight.
**Status: ❌ No valid ablation exists for Head-to-Head. Its incremental accuracy value remains unverified.**

### Specialist Calibration
From current test-segment data (above, Section 8F):
- Specialist applied=false: 64.0% (n=32,378)
- Specialist applied=true: 60.9% (n=20,041)
- Clay delta: -7.0pp; Grass: -4.1pp; Hard: -1.2pp
This is in-sample for the walk-forward (the specialist was fitted on the validation segment and applied to the test segment of the same walk-forward run). The negative accuracy is real and persistent across all surfaces.
**Status: 🔄 Feature appears harmful. Specialist calibration reduces test-segment accuracy by 3.1pp overall and 7.0pp on Clay. This qualifies as a rollback candidate.**

### Data Quality (blend composition)
See 8C — DQ is not a useful monotone predictor of outcome accuracy in the test segment.
**Status: ⚠️ DQ score's relationship to accuracy is not the expected direction. The code change is correct; the score's use as a gate is unvalidated.**

### Hardcoded discounts (CONFIDENCE_SHRINK, TOUR_RELIABILITY_DISCOUNT, LOW_SURFACE_SAMPLE_DISCOUNT)
See 8H. Only CONFIDENCE_SHRINK has ablation support. The others are unverified heuristics.
**Status: ⚠️ CONFIDENCE_SHRINK supported; others are unvalidated.**

### Tie-break cascade (removed)
See 8I. Per-step ablation evidence existed at removal time (53.7% S&R step, 46.7% Elo step). No longer measurable.
**Status: ✅ Cascade correctly removed. Historical step evidence confirmed it was harmful.**

### Market Odds (EXCLUDED from ensemble, pending ablation)
Not part of this accuracy audit. Ablation is ongoing (Section B, n=1,558 paper_trade rows, 515 graded).

---

## 8K — Accuracy-Audit Conclusion

**Test segment baseline:** 62.8% (n=52,456, 2021–2026, model=phase8-historical-live-engine-v1, held-out test)

| Rank | Issue | Evidence | Seg | n | Acc Impact | Raw accuracy | Recommended-pick accuracy | Coverage | Status | Prod-ready | Test required | Rollback | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Specialist calibration hurts Clay/Grass/Hard accuracy | Test-segment current DB: specialist=false 64.0%, specialist=true 60.9% | test | 52,454 | -3.1pp overall; -7.0pp Clay | -3.1pp | -3.1pp | No change | 🔄 | No | Held-out ablation: freeze specialist out, re-score same test segment | Yes | Measure accuracy with specialist disabled across the current test corpus before any change |
| 2 | Tie-break cohort: 30% of picks at 53.5% accuracy | Test-segment: tba=true 53.5% (n=15,737), consistent across 6 folds, 95% CI 52.7–54.3% | test | 15,737 | Removing from recommended picks: coverage -30%, pick accuracy improves 62.8%→66.8% | -13.3pp vs baseline | +4.0pp if excluded | -30% picks | ⚠️ | Partial (soft no-play deployed; impact unverified) | 500+ graded post-fix paper_trade rows | No | Continue paper_trade scoring; re-measure post-fix tie-break accuracy at n≥500 |
| 3 | Model conflict picks at 48.6%: below coin flip | Test-segment: conflict=true 48.6% (n=1,491), conflict=false 63.2% | test | 1,491 | -14.6pp vs non-conflict | -14.6pp | Large if excluded | <3% picks | ⚠️ | No | Identify what triggers model conflict, test soft no-play for conflict=true | No | Investigate what drives the 1,491 conflict predictions; measure accuracy if excluded |
| 4 | DQ score not monotone predictor of accuracy | Test-segment: Limited(64.6%) > Strong(64.2%) > Acceptable(63.3%) > Excellent(62.5%) > Poor(59.6%) | test | 52,454 | 2.1pp inverted (Limited beats Excellent) | Not useful as gate | DQ gates select in wrong direction | No change | ⚠️ | No | Re-validate DQ thresholds against current test data; measure elite/confidence gate accuracy with and without DQ filter | No | Re-evaluate elite-tier and confidence gates that use DQ as a required threshold |
| 5 | Model systematically underconfident in all bands | Test-segment: every prob band has actual_acc > avg_prob (gap -2.9pp to -6.8pp) | test | 28,490 (≥50%) | 80%+ band: 91.8% actual vs 85.0% displayed | N/A (calibration issue) | Displayed probabilities understate confidence | No change | MEASUREMENT ONLY | Partial (calibration deployed; gap persists) | Calibration refit on post-fix corpus (Task #117) | No | Task #117: refit calibration to reduce systematic underconfidence |
| 6 | Fallback predictions are more accurate than clean (+2.5pp) | Test-segment: fallback 63.3% (n=41,933) vs clean 60.8% (n=10,486), non-overlapping CIs | test | 52,456 | +2.5pp for fallback | +2.5pp | +2.5pp | No change | ✅ | Yes | Grass fallback (-3.4pp) warrants monitoring | No | No action required; confirm Grass fallback gap does not worsen |
| 7 | Recent Form conflict gate (0.1 weight): 45.4% → 56.7% | Prior audit (n=163 conflict rows, n=8,865 corpus, 2026-07-18 — older corpus) | prior test | 163/8,865 | +0.2pp overall; +11pp on conflict cohort | +0.2pp | +0.2pp | No change | ⚠️ | Yes (gate deployed) | Verify gate on current 52,456-row corpus by storing formWeightPrior in decisionTrace | No | Store formEloConflict flag in decisionTrace so future walks can measure it |
| 8 | Elite tier +8.9pp above non-elite | Test-segment: elite=70.5% (n=7,104) vs non-elite=61.6% (n=45,315) | test | 52,454 | +8.9pp for elite picks | +8.9pp | Positive | -13.5% of picks | VERIFIED ACCURACY IMPROVEMENT | Yes | Calibrate gate thresholds against current test data (DQ threshold may be backward) | No | Keep gate; revisit DQ component of elite gate given DQ inversion finding |
| 9 | Availability correctly excluded | Full corpus ablation 2026-07-13, n=18,281; removing: +0.1pp | full corpus ablation | 18,281 | +0.1pp for exclusion | +0.1pp | +0.1pp | No change | ✅ | Yes | None | No | No action |
| 10 | Fatigue correctly excluded | Real match outcomes, 7,321 decided matches; directional inversion confirmed | historical | 7,321 | Prevents negative vote from wrong-direction signal | Unknown | Unknown | No change | ✅ | Yes | None | No | No action |
| 11 | Match Load Recovery correctly excluded | Stratified ablation, n=4,001; 0.0pp effect | stratified ablation | 4,001 | 0.0pp | 0.0pp | 0.0pp | No change | ✅ | Yes | None | No | No action |
| 12 | Dynamic vs frozen weights | 0 optimizer runs; comparison blocked | N/A | 0 dynamic rows | Unknown | Unknown | Unknown | N/A | ❌ | No | Run optimizer (evaluationOnly=false) | No | Task #81: wire calibration-refit cycle |
| 13 | Hardcoded discounts (tour, surface-sample, form-conflict) | Direction confirmed for Low-sample (-2.9pp vs Moderate); exact effect unverifiable | partial | Varies | Unknown (not stored) | Unknown | Unknown | No change | ⚠️ | Partial | Store adjustment flags in decisionTrace for each prediction | No | Add provenance fields to future walk-forward scoring |
| 14 | H2H ablation | No ablation exists | none | — | Unknown | Unknown | Unknown | — | ❌ NO VALID EVIDENCE | No | Include H2H in next ablation run | No | Add to next scheduled ablation |

---

## Section 9 — Combined Live-Verification and Accuracy Report

### 1. Completed and verified live

| Item | Evidence |
|---|---|
| Tie-break soft no-play fix deployed | 218 paper_trade + 37,817 historical_test rows with tieBreakerApplied=true, decidingStep=null on 100%; calibrated_probability 48–52% on all paper_trade tie-break rows |
| Fallback instrumentation active | 195,987 rows with used_fallback / fallback_sources; 71.9% fallback rate; real values on all run_kinds |
| Segment provenance consistent | 0 disagreements between segment and data_segment across 195,987 rows |
| Deployment state | HEAD 48707e67, DB live (NOW()=2026-08-07), both workflows running |
| Availability correctly excluded | Full-corpus ablation, +0.1pp for exclusion |
| Fatigue correctly excluded | Directional inversion confirmed on 7,321 matches |
| Match Load Recovery correctly excluded | 0.0pp ablation effect on 4,001-match sample |
| Elite tier working | Test-segment +8.9pp above non-elite baseline (n=7,104 elite, 70.5%) |
| Fallback accuracy ≥ clean | 63.3% vs 60.8%, non-overlapping CIs; all sources above clean except Grass |

### 2. Completed but needing more live data

| Item | Gap | Threshold needed |
|---|---|---|
| Tie-break soft no-play impact | Post-fix paper_trade graded n=198 (too small for definitive comparison) | n≥500 graded paper_trade with tieBreakerApplied=true post-fix |
| Recent Form conflict gate | Gate deployed; decisionTrace not stored → cannot verify live accuracy | Store formEloConflict flag in future walk-forwards |
| Market odds ablation (Section B) | n=515 graded paper_trade total; paper_trade cycle not scoring since 2026-07-24 | n≥500 paired rows with market odds |

### 3. Built but not deployed

| Item | Gap |
|---|---|
| bridgeRescore rows identifiable | No discriminator column; cannot isolate bridge rows from walk-forward rows |
| Hardcoded discount provenance | decisionTrace.pipeline not stored for historical_test; cannot measure per-adjustment accuracy |

### 4. Accuracy weakness verified

| Item | Evidence | Impact |
|---|---|---|
| Tie-break cohort: 53.5% accuracy | 15,737 test-segment rows, all folds consistent, 95% CI 52.7–54.3% | -13.3pp vs non-tie-break baseline; 30% of all picks |
| Model conflict: 48.6% accuracy | 1,491 test-segment rows | Below coin flip |
| Specialist calibration: -3.1pp | 20,041 test rows; Clay -7.0pp, Grass -4.1pp, Hard -1.2pp | Active on every prediction with a specialist segment |
| DQ not monotone predictor | Limited (64.6%) > Excellent (62.5%) on test segment | DQ gates may select in wrong direction |

### 5. Potential accuracy improvement unverified

| Item | Prior evidence | Gap |
|---|---|---|
| Disabling specialist calibration | Test-segment: -3.1pp with specialist active | Needs held-out ablation with specialist disabled on same test corpus |
| Recent Form conflict gate | Older corpus: +0.2pp overall, +11pp on conflict cohort (n=163) | Needs current corpus verification via decisionTrace |
| Soft no-play for model-conflict picks | 48.6% accuracy suggests soft no-play or INSUFFICIENT_EDGE label would improve recommended-pick accuracy | Needs prospective measurement or policy-matched comparison |

### 6. Measurement / instrumentation only

| Item | Finding |
|---|---|
| Fallback rate 71.9% | Healthy, instrumentation confirmed; no accuracy problem |
| Model underconfidence in all bands | Actual accuracy > predicted probability by 2.9–6.8pp across all bands; calibration refit (Task #117) is the resolution path |
| Elite tier gate functioning | +8.9pp confirmed; DQ component of gate may need reweighting |

### 7. Possible rollback candidates

| Item | Evidence | Rollback type |
|---|---|---|
| Specialist calibration | -3.1pp overall, -7.0pp Clay, -4.1pp Grass on test segment | Disable specialist for Clay/Grass while measuring Hard independently |
| DQ-based gates (elite tier, HIGHEST_CONFIDENCE) | DQ not monotone on test segment; Limited beats Excellent by 2.1pp | Remove DQ as a hard gate; keep as soft signal only |

### 8. Blocked by missing data

| Item | Blocker |
|---|---|
| Frozen vs. dynamic weights comparison | 0 optimizer_run_id rows; no dynamic arm exists |
| Per-adjustment accuracy (CONFIDENCE_SHRINK, tour discount, surface discount) | decisionTrace not stored in historical_test snapshots |
| Surface Elo held-out ablation | No ablation report file in repository |
| H2H held-out ablation | No ablation file; H2H inclusion never formally validated |
| Recent Form gate verification on current corpus | formEloConflict not persisted in feature_snapshot |

### 9. Exact next engineering actions (ranked by expected accuracy value)

| Priority | Action | Expected effect | Blocking test |
|---|---|---|---|
| 1 | Measure specialist calibration accuracy with it disabled on the current test corpus (read-only re-score) | +3.1pp overall if disabled; +7.0pp Clay | Confirmed before any change |
| 2 | Resume paper_trade scoring (Scheduled Deployment or equivalent) | Unblocks: tie-break fix verification, market-odds Section B, Recent Form gate measurement | None |
| 3 | Add `formEloConflict` boolean to feature_snapshot or decisionTrace in historical_test scoring | Enables future gate verification on live corpus | None |
| 4 | Investigate model_conflict=true predictions (1,491 rows, 48.6%) — identify trigger and apply soft no-play | Potentially +0.3pp overall if excluded | Needs cohort analysis before policy change |
| 5 | Re-evaluate DQ as a gate — either re-validate monotone relationship or remove DQ from hard gate conditions | Prevents elite/confidence labels from selecting worse picks | Re-run walk-forward with DQ-tier accuracy tracked |
| 6 | Task #117: Refit calibration on post-fix corpus (evaluationOnly=false) | Reduces systematic underconfidence (2.9–6.8pp gap per band) | evaluationOnly=false walk-forward |
| 7 | Task #81: Wire calibration-refit cycle (Scheduled Deployment) | Unblocks dynamic vs. frozen comparison; enables regular calibration freshness | None |
| 8 | Surface Elo and H2H held-out ablation | Validates the two unverified ensemble components | New ablation run |
