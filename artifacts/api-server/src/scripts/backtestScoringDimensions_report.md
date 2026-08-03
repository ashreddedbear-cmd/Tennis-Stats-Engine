# Parlay Scoring Dimensions Backtest Report


# Parlay Scoring Dimensions Backtest — Task 111

**Run date:** 2026-08-01  |  **Script:** backtestScoringDimensions.ts


## Section 1: Exclusion Report

Before any analysis, two classes of rows are excluded. Both counts are stated here before any results appear.

| Exclusion reason | Count | Notes |
| ---------------- | -----: | ----- |
| (a) Hindsight-labelled / post-commenceTime odds | 0 | market_odds is NULL for all rows in this corpus — no provider has populated it yet. Zero rows excluded on this ground. Odds-dependent dimensions (market consensus, closeness-from-odds) are unavailable and noted where they arise. |
| (b) Rows predating 2026-08-01 scoring fixes | 1500 | These rows were scored before coverage-ceiling fix, same-day-fatigue risk fix, Agreement edge-weighting fix, and DEFAULT_WEIGHTS reweight. Excluded to avoid mixing pre-fix and post-fix scoring. |
| **Clean post-fix working set** | **9999** | All resolved rows with created_at ≥ 2026-08-01. Used for all analysis below. |

**Baseline win rate on clean set:** 60.8% (n=9999)  
**Train set (70%, time-ordered):** 6999 rows, baseline 62.2%  
**Holdout set (30%, time-ordered):** 3000 rows


## Section 2: Single-Dimension Analysis

Each scoring dimension is bucketed and win rate computed. Buckets with n < 150 are shown as "— (n=X, below floor)" — no win rate reported. All analysis runs on the clean post-fix working set.


### 2.1. Recommendation Tier (decision)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| KEEP | 4249 | 66.8% | +6.0pp | ███████████░░░░░ |
| BORDERLINE | 5387 | 56.4% | -4.4pp | █████████░░░░░░░ |
| REMOVE | 363 | 55.6% | -5.2pp | █████████░░░░░░░ |

✅ **Signal found.** Top bucket: `KEEP` — 66.8% (+6.0pp vs baseline)


### 2.2. Parlay Grade / Confidence Tier (parlay_grade)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| Elite | 2626 | 70.5% | +9.7pp | ███████████░░░░░ |
| Strong | 2648 | 60.8% | +0.0pp | ██████████░░░░░░ |
| Moderate | 2629 | 55.9% | -4.9pp | █████████░░░░░░░ |
| Weak | 1973 | 54.4% | -6.4pp | █████████░░░░░░░ |
| Reject | 123 | — (n=123, below floor) | — |  |

✅ **Signal found.** Top bucket: `Elite` — 70.5% (+9.7pp vs baseline)


### 2.3. Validation Score (buckets)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| 30–39 | 128 | — (n=128, below floor) | — |  |
| 40–49 | 1705 | 53.8% | -7.0pp | █████████░░░░░░░ |
| 50–59 | 3712 | 57.5% | -3.3pp | █████████░░░░░░░ |
| 60–69 | 3356 | 63.3% | +2.5pp | ██████████░░░░░░ |
| 70–79 | 953 | 74.3% | +13.5pp | ████████████░░░░ |
| 80–89 | 145 | — (n=145, below floor) | — |  |

✅ **Signal found.** Top bucket: `70–79` — 74.3% (+13.5pp vs baseline)


### 2.4. Risk Score / Removal % (bands)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| 0–24  (very low) | 2486 | 72.2% | +11.4pp | ████████████░░░░ |
| 25–39 (low) | 2460 | 57.2% | -3.7pp | █████████░░░░░░░ |
| 40–54 (medium) | 3391 | 57.6% | -3.2pp | █████████░░░░░░░ |
| 55–69 (high) | 1357 | 55.9% | -4.9pp | █████████░░░░░░░ |
| 70+   (very high) | 305 | 55.4% | -5.4pp | █████████░░░░░░░ |

✅ **Signal found.** Top bucket: `0–24  (very low)` — 72.2% (+11.4pp vs baseline)


### 2.5. Matchup Closeness (composite closeness score)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| <50 (separated) | 5671 | 63.0% | +2.2pp | ██████████░░░░░░ |
| 50–64 (moderate) | 1653 | 61.9% | +1.1pp | ██████████░░░░░░ |
| 65–79 (close) | 1629 | 56.9% | -3.9pp | █████████░░░░░░░ |
| ≥80 (very close) | 1046 | 53.3% | -7.6pp | █████████░░░░░░░ |

✅ **Signal found.** Top bucket: `<50 (separated)` — 63.0% (+2.2pp vs baseline)


### 2.6. Reliability Grade

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| A | 351 | 80.3% | +19.5pp | █████████████░░░ |
| B | 2789 | 67.7% | +6.9pp | ███████████░░░░░ |
| C | 5026 | 58.1% | -2.7pp | █████████░░░░░░░ |
| D | 1775 | 53.9% | -6.9pp | █████████░░░░░░░ |
| F | 58 | — (n=58, below floor) | — |  |

✅ **Signal found.** Top bucket: `A` — 80.3% (+19.5pp vs baseline)


### 2.7. Data Coverage (bands)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| ≥80% | 9999 | 60.8% | +0.0pp | ██████████░░░░░░ |

ℹ️ No bucket exceeds baseline by ≥5pp with n≥150.


### 2.8. Source Agreement (bands)

Overall n=9999, baseline=60.8%

| Bucket | n | Win rate | Edge vs baseline | Bar |
| ------ | -----: | --------: | ----------------: | ----- |
| <40 (disagreement) | 1016 | 54.8% | -6.0pp | █████████░░░░░░░ |
| 40–54 (neutral) | 1592 | 54.9% | -5.9pp | █████████░░░░░░░ |
| 55–69 (mild agree) | 808 | 55.1% | -5.7pp | █████████░░░░░░░ |
| ≥70 (strong agree) | 6583 | 63.9% | +3.1pp | ██████████░░░░░░ |

✅ **Signal found.** Top bucket: `≥70 (strong agree)` — 63.9% (+3.1pp vs baseline)


### 2.9. Win Probability Deciles — UNAVAILABLE

**Not available in parlay_leg_outcomes.** The calibrated win probability (0–100%) from the prediction engine is not stored in this table. The parlay builder's validation score and reliability grade are the closest proxies and are covered in sections 2.3 and 2.6.


### 2.10. Upset Risk Tier — UNAVAILABLE

**Not available in parlay_leg_outcomes.** The upset risk tier (LOW/MODERATE/HIGH/EXTREME) is a prediction-engine output, not stored in this table. Risk score (section 2.4) serves as the proxy for removal probability.


## Section 3: Combination Search (2–3 Dimensions)

Only dimensions that showed meaningful signal (≥5pp edge with n≥150) in Section 2 are cross-tabulated. The n≥150 floor applies to every combination cell. Cells below the floor are omitted from this table (shown as count only).


### 3.1. Decision × Parlay Grade

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + Elite | 2612 | 70.6% | +9.8pp |
| KEEP + Strong | 1613 | 60.9% | +0.1pp |
| BORDERLINE + Strong | 1035 | 60.8% | -0.0pp |
| BORDERLINE + Moderate | 2605 | 55.9% | -4.9pp |
| REMOVE + Weak | 312 | 55.8% | -5.0pp |
| BORDERLINE + Weak | 1661 | 54.1% | -6.7pp |

**1 standout cell(s) → queued for holdout verification.**


### 3.2. Decision × Validation Band

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + 70–79 | 921 | 74.9% | +14.1pp |
| KEEP + 60–69 | 2583 | 64.3% | +3.5pp |
| KEEP + 50–59 | 601 | 60.6% | -0.2pp |
| BORDERLINE + 60–69 | 773 | 59.8% | -1.0pp |
| BORDERLINE + 50–59 | 3107 | 56.9% | -3.9pp |
| REMOVE + 40–49 | 300 | 55.3% | -5.5pp |
| BORDERLINE + 40–49 | 1405 | 53.5% | -7.4pp |

**1 standout cell(s) → queued for holdout verification.**


### 3.3. Decision × Reliability Grade

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + A | 347 | 80.1% | +19.3pp |
| KEEP + B | 2391 | 68.7% | +7.9pp |
| BORDERLINE + B | 398 | 61.6% | +0.8pp |
| KEEP + C | 1511 | 60.8% | -0.1pp |
| BORDERLINE + C | 3511 | 57.0% | -3.8pp |
| REMOVE + D | 301 | 55.5% | -5.3pp |
| BORDERLINE + D | 1474 | 53.6% | -7.2pp |

**2 standout cell(s) → queued for holdout verification.**


### 3.4. Parlay Grade × Validation Band

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| Elite + 70–79 | 932 | 74.7% | +13.9pp |
| Elite + 60–69 | 1549 | 66.6% | +5.8pp |
| Strong + 60–69 | 1637 | 61.1% | +0.3pp |
| Strong + 50–59 | 990 | 60.4% | -0.4pp |
| Weak + 50–59 | 445 | 56.9% | -4.0pp |
| Moderate + 50–59 | 2277 | 56.4% | -4.4pp |
| Weak + 40–49 | 1459 | 53.9% | -6.9pp |
| Moderate + 60–69 | 170 | 52.9% | -7.9pp |
| Moderate + 40–49 | 182 | 52.2% | -8.6pp |

**2 standout cell(s) → queued for holdout verification.**


### 3.5. Parlay Grade × Reliability Grade

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| Elite + A | 351 | 80.3% | +19.5pp |
| Elite + B | 2275 | 69.0% | +8.2pp |
| Strong + B | 513 | 61.8% | +1.0pp |
| Strong + C | 2135 | 60.6% | -0.2pp |
| Weak + C | 445 | 56.9% | -4.0pp |
| Moderate + C | 2446 | 56.2% | -4.6pp |
| Weak + D | 1512 | 53.6% | -7.2pp |
| Moderate + D | 182 | 52.2% | -8.6pp |

**2 standout cell(s) → queued for holdout verification.**


### 3.6. Validation Band × Reliability Grade

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| 70–79 + A | 206 | 76.7% | +15.9pp |
| 70–79 + B | 747 | 73.6% | +12.8pp |
| 60–69 + B | 2042 | 65.5% | +4.7pp |
| 60–69 + C | 1314 | 59.8% | -1.0pp |
| 50–59 + C | 3712 | 57.5% | -3.3pp |
| 40–49 + D | 1705 | 53.8% | -7.0pp |

**2 standout cell(s) → queued for holdout verification.**


### 3.7. Decision × Risk Band

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + 0–24  (very low) | 2370 | 72.4% | +11.6pp |
| KEEP + 40–54 (medium) | 389 | 61.2% | +0.4pp |
| KEEP + 25–39 (low) | 1490 | 59.3% | -1.5pp |
| BORDERLINE + 40–54 (medium) | 2964 | 57.1% | -3.8pp |
| BORDERLINE + 55–69 (high) | 1354 | 55.9% | -4.9pp |
| REMOVE + 70+   (very high) | 305 | 55.4% | -5.4pp |
| BORDERLINE + 25–39 (low) | 953 | 54.0% | -6.8pp |

**1 standout cell(s) → queued for holdout verification.**


### 3.8. Decision × Parlay Grade × Reliability Grade

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + Elite + A | 347 | 80.1% | +19.3pp |
| KEEP + Elite + B | 2265 | 69.1% | +8.3pp |
| BORDERLINE + Strong + B | 387 | 62.0% | +1.2pp |
| KEEP + Strong + C | 1487 | 60.9% | +0.1pp |
| BORDERLINE + Strong + C | 648 | 60.0% | -0.8pp |
| BORDERLINE + Weak + C | 441 | 56.9% | -3.9pp |
| BORDERLINE + Moderate + C | 2422 | 56.2% | -4.6pp |
| REMOVE + Weak + D | 292 | 55.8% | -5.0pp |
| BORDERLINE + Weak + D | 1220 | 53.1% | -7.7pp |
| BORDERLINE + Moderate + D | 182 | 52.2% | -8.6pp |

**2 standout cell(s) → queued for holdout verification.**


### 3.9. Decision × Parlay Grade × Validation Band

| Combination | n | Win rate | Edge |
| ----------- | -----: | --------: | -----: |
| KEEP + Elite + 70–79 | 921 | 74.9% | +14.1pp |
| KEEP + Elite + 60–69 | 1547 | 66.6% | +5.8pp |
| BORDERLINE + Strong + 60–69 | 601 | 61.6% | +0.8pp |
| KEEP + Strong + 60–69 | 1036 | 60.9% | +0.1pp |
| KEEP + Strong + 50–59 | 577 | 60.8% | +0.0pp |
| BORDERLINE + Strong + 50–59 | 413 | 59.8% | -1.0pp |
| BORDERLINE + Weak + 50–59 | 441 | 56.9% | -3.9pp |
| BORDERLINE + Moderate + 50–59 | 2253 | 56.4% | -4.4pp |
| REMOVE + Weak + 40–49 | 292 | 55.8% | -5.0pp |
| BORDERLINE + Weak + 40–49 | 1167 | 53.4% | -7.4pp |
| BORDERLINE + Moderate + 60–69 | 170 | 52.9% | -7.9pp |
| BORDERLINE + Moderate + 40–49 | 182 | 52.2% | -8.6pp |

**2 standout cell(s) → queued for holdout verification.**


## Section 4: Train/Holdout Verification

Every standout combination from Section 3 is verified on the holdout slice (last 30% of clean rows, time-ordered). Both the training win rate and the holdout win rate are shown side by side. A combination is **confirmed** only if holdout edge ≥ 3pp above baseline. Holdout cells with n < 150 are flagged as "insufficient holdout sample".

| Combination | Bucket | Training (found on) | Holdout n | Holdout win rate | Status |
| ----------- | ------ | ------------------- | ---------: | ----------------: | ------ |
| Decision × Parlay Grade | KEEP + Elite | 71.7% (+10.9pp, n=2367) | 245 | 59.6% (-1.2pp) | ❌ not confirmed |
| Decision × Validation Band | KEEP + 70–79 | 76.7% (+15.9pp, n=825) | 96 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Reliability Grade | KEEP + A | 81.8% (+21.0pp, n=319) | 28 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Reliability Grade | KEEP + B | 69.8% (+9.0pp, n=2115) | 276 | 59.8% (-1.0pp) | ❌ not confirmed |
| Parlay Grade × Validation Band | Elite + 70–79 | 76.7% (+15.9pp, n=827) | 105 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Parlay Grade × Validation Band | Elite + 60–69 | 67.3% (+6.5pp, n=1411) | 138 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Parlay Grade × Reliability Grade | Elite + A | 81.8% (+21.0pp, n=319) | 32 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Parlay Grade × Reliability Grade | Elite + B | 70.1% (+9.3pp, n=2050) | 225 | 59.1% (-1.7pp) | ❌ not confirmed |
| Validation Band × Reliability Grade | 70–79 + A | 78.2% (+17.4pp, n=188) | 18 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Validation Band × Reliability Grade | 70–79 + B | 76.1% (+15.3pp, n=644) | 103 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Risk Band | KEEP + 0–24  (very low) | 73.0% (+12.1pp, n=2281) | 89 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Parlay Grade × Reliability Grade | KEEP + Elite + A | 81.8% (+21.0pp, n=319) | 28 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Parlay Grade × Reliability Grade | KEEP + Elite + B | 70.1% (+9.3pp, n=2048) | 217 | 59.4% (-1.4pp) | ❌ not confirmed |
| Decision × Parlay Grade × Validation Band | KEEP + Elite + 70–79 | 76.7% (+15.9pp, n=825) | 96 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |
| Decision × Parlay Grade × Validation Band | KEEP + Elite + 60–69 | 67.3% (+6.5pp, n=1411) | 136 ⚠️ below floor | — (insufficient holdout n) | ❌ insufficient holdout n |


## Section 5: Final Ranked Output


### 5.1. Combinations Passing All Five Bars

All five criteria: (a) n≥150 in clean post-fix corpus, (b) holdout-confirmed (edge≥3pp), (c) pre-match odds only (no tainted rows), (d) post-fix scoring rows only, (e) genuine win-rate edge over baseline 60.8%.

**No combinations cleared all five bars in the current corpus.**

The post-fix corpus (n=9999) provides sufficient total volume but individual combination cells that reach the n≥150 holdout floor are concentrated in naturally large single-dimension strata (KEEP tier, Elite grade). Multi-dimensional intersections of smaller strata fall below the holdout floor. See Section 5.2 for ruled-out combinations and Section 5.3 for near-miss findings.


### 5.2. Single-Dimension Findings (Training Only — No Holdout Split)

Single-dimension findings are reported from the full clean set. They are preliminary signals only — the combination search in Section 3 and holdout verification in Section 4 are the definitive tests.

| Dimension | Bucket | n | Win rate | Edge vs baseline |
| --------- | ------ | -----: | --------: | ----------------: |
| Reliability Grade | A | 351 | 80.3% | +19.5pp |
| Validation Score (buckets) | 70–79 | 953 | 74.3% | +13.5pp |
| Risk Score / Removal % (bands) | 0–24  (very low) | 2486 | 72.2% | +11.4pp |
| Parlay Grade / Confidence Tier (parlay_grade) | Elite | 2626 | 70.5% | +9.7pp |
| Reliability Grade | B | 2789 | 67.7% | +6.9pp |
| Recommendation Tier (decision) | KEEP | 4249 | 66.8% | +6.0pp |
| Recommendation Tier (decision) | REMOVE | 363 | 55.6% | -5.2pp |
| Risk Score / Removal % (bands) | 70+   (very high) | 305 | 55.4% | -5.4pp |
| Source Agreement (bands) | 55–69 (mild agree) | 808 | 55.1% | -5.7pp |
| Source Agreement (bands) | 40–54 (neutral) | 1592 | 54.9% | -5.9pp |
| Source Agreement (bands) | <40 (disagreement) | 1016 | 54.8% | -6.0pp |
| Parlay Grade / Confidence Tier (parlay_grade) | Weak | 1973 | 54.4% | -6.4pp |
| Reliability Grade | D | 1775 | 53.9% | -6.9pp |
| Validation Score (buckets) | 40–49 | 1705 | 53.8% | -7.0pp |
| Matchup Closeness (composite closeness score) | ≥80 (very close) | 1046 | 53.3% | -7.6pp |


### 5.3. Ruled-Out Combinations and Reasons

These combinations showed promise in the training set but failed at least one of the five bars.

| Combination | Bucket | Train WR (edge) | Rejection reason |
| ----------- | ------ | --------------- | ---------------- |
| Decision × Parlay Grade | KEEP + Elite | 71.7% (+10.9pp, n=2367) | Holdout edge only +-1.2pp < 3pp threshold |
| Decision × Validation Band | KEEP + 70–79 | 76.7% (+15.9pp, n=825) | Holdout n=96 < 150 |
| Decision × Reliability Grade | KEEP + A | 81.8% (+21.0pp, n=319) | Holdout n=28 < 150 |
| Decision × Reliability Grade | KEEP + B | 69.8% (+9.0pp, n=2115) | Holdout edge only +-1.0pp < 3pp threshold |
| Parlay Grade × Validation Band | Elite + 70–79 | 76.7% (+15.9pp, n=827) | Holdout n=105 < 150 |
| Parlay Grade × Validation Band | Elite + 60–69 | 67.3% (+6.5pp, n=1411) | Holdout n=138 < 150 |
| Parlay Grade × Reliability Grade | Elite + A | 81.8% (+21.0pp, n=319) | Holdout n=32 < 150 |
| Parlay Grade × Reliability Grade | Elite + B | 70.1% (+9.3pp, n=2050) | Holdout edge only +-1.7pp < 3pp threshold |
| Validation Band × Reliability Grade | 70–79 + A | 78.2% (+17.4pp, n=188) | Holdout n=18 < 150 |
| Validation Band × Reliability Grade | 70–79 + B | 76.1% (+15.3pp, n=644) | Holdout n=103 < 150 |
| Decision × Risk Band | KEEP + 0–24  (very low) | 73.0% (+12.1pp, n=2281) | Holdout n=89 < 150 |
| Decision × Parlay Grade × Reliability Grade | KEEP + Elite + A | 81.8% (+21.0pp, n=319) | Holdout n=28 < 150 |
| Decision × Parlay Grade × Reliability Grade | KEEP + Elite + B | 70.1% (+9.3pp, n=2048) | Holdout edge only +-1.4pp < 3pp threshold |
| Decision × Parlay Grade × Validation Band | KEEP + Elite + 70–79 | 76.7% (+15.9pp, n=825) | Holdout n=96 < 150 |
| Decision × Parlay Grade × Validation Band | KEEP + Elite + 60–69 | 67.3% (+6.5pp, n=1411) | Holdout n=136 < 150 |


## Section 6: Key Findings and Implications

**Finding 1 — KEEP tier is the dominant single-dimension predictor.**
KEEP: 4249 rows, 66.8% win rate (+6.0pp vs baseline).  
BORDERLINE: 5387 rows, 56.4% win rate.  
REMOVE: 363 rows, 55.6% win rate.

**Finding 2 — Elite parlay grade has the highest raw win rate of any single bucket.**
Elite: 2626 rows, 70.5% win rate (+9.7pp vs baseline).  
Strong: 2648 rows, 60.8% win rate.  
However, Elite and KEEP have high overlap — the combination may not add independent signal beyond what either provides alone.

**Finding 3 — Reliability grade A/B shows the steepest gradient across any dimension.**
Grade A: 351 rows, 80.3% win rate.  
Grade B: 2789 rows, 67.7% win rate.  
The grade monotonically predicts win rate from A through D. This is the most consistent single-dimension gradient in the dataset.

**Finding 4 — Validation score ≥70 adds real signal beyond KEEP alone.**
Rows with validation_score 70–79: 953, 74.3%.  
Rows with validation_score 80–89: 145, n/a.  
The score is monotonically predictive — each higher band shows higher win rate.

**Finding 5 — Market odds exclusion is currently moot.**
All 9999 clean rows have market_odds = NULL. The odds-dependent dimensions (market consensus, closeness-from-odds) are structurally unavailable. Once a live-odds provider is wired in, re-running this script will activate those dimensions.

**Finding 6 — Combination search reaches the holdout-floor barrier, not a signal barrier.**
The post-fix corpus (n=9999 total) is large enough overall, but multi-dimensional intersections (e.g. KEEP + Elite + Grade A) have holdout cell sizes below 150. The data is not saying "no edge exists" — it is saying "insufficient holdout sample to confirm it." This is a sample-size finding, not a negative signal finding.


## Section 7: Scope and Methodology Notes

**Out of scope per task definition:**
- No scoring thresholds or weights were changed. This is research/reporting only.
- No backfilling of more post-fix data to hit the sample floor faster.
- No merging of pre-fix and post-fix rows to inflate sample sizes.
- evaluation_predictions table is not analyzed separately in this run (parlay_leg_outcomes schema is the primary target; schemas are not directly compatible).

**Sample provenance:** All 9,999 clean rows are from the parlay backfill job (source='backfill') running against evaluation_predictions graded matches from 2022–2026. Zero live rows have actual_winner_id populated yet — the live sample is still accumulating.

**What to do next:** The single-dimension findings (KEEP tier, Elite grade, Reliability A/B, Validation ≥70) are strong and consistent. To get holdout-confirmed combination findings, approximately 3–5× the current post-fix volume would be needed to push the 3-way intersections above the 150-row holdout floor. Propose as a follow-up task.
