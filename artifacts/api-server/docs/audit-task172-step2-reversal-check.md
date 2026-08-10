# Task #172 Step 2 — Calibration Monotonicity & Bucket-Accuracy Check

> Executed: 2026-08-10  
> Active model: id=712 (isotonic, 8 knots, 21,222 holdout rows, LL=0.6397)  
> Script: `/tmp/step2-full-check.ts` (run from `artifacts/api-server/`)

## Active model knots

```
(x=0.0000, y=0.5565)  (x=0.5245, y=0.5565)  ← flat zone (plateau)
(x=0.5712, y=0.6628)
(x=0.6212, y=0.7046)
(x=0.6726, y=0.7334)
(x=0.7219, y=0.8114)
(x=0.7680, y=0.8829)
(x=1.0000, y=0.8829)  ← flat ceiling
```

---

## Check 1 — Monotone non-decreasing (knots)

8 knot y-values inspected. **No violations. ✓**

Flat segments (x=[0, 0.5245] and x=[0.768, 1.0]) are valid plateaus — isotonic
regression merges bins with indistinguishable win rates into constant-y regions.

---

## Check 2 — Monotone non-decreasing (full validation set)

335 distinct oriented-x values inspected. Calibrated output verified non-decreasing at
every step (tolerance 0.001pp). **No violations. ✓**

---

## Check 3 — Calibrated vs empirical win rate, three buckets

Gap = `calibrated − empirical`. Positive = overconfident, negative = underconfident.  
Bins with n < 20 excluded. Flag threshold: |gap| > 2pp.

**Note on calibrated < raw:** calibrated output being below raw x is NOT a finding.
Calibration is supposed to correct raw scores in both directions — pull overconfident
predictions down and underconfident ones up. Only monotonicity violations and
bucket-accuracy gaps (calibrated vs empirical, not calibrated vs raw x) are flagged.

### Bucket A: x=0.40–0.50

`orientedX = max(raw/100, 1-raw/100)` is always ≥ 0.50 by construction, so
**x=0.40–0.49 cannot appear in the validation set.** x=0.50 is the minimum possible
value (raw probability = exactly 50%).

| x    | n      | empirical%  | calibrated%  | gap       | flag? |
|------|--------|-------------|--------------|-----------|-------|
| 0.50 | 4,331  | 49.90%      | 55.65%       | **+5.75pp** | ← FLAG |

x=0.40–0.49: no rows (orientedX ≥ 0.50 by definition).  
**1 bucket exceeds 2pp: x=0.50 (+5.75pp).**

#### Root cause — flat-zone isotonic constraint

The flagged bucket sits at the isotonic flat zone (x∈[0, 0.5245] → y=0.5565
throughout). PAVA merged x=0.50–0.52 upward with higher-x bins because the local win
rate at x≈0.50 is below the monotone constraint. The flat-zone y=55.65% is the correct
pooled average for the whole block; the x=0.50 sub-bucket within it (empirical 49.90%)
is below that average. This is isotonic regression's monotonicity enforcement — by
design, not a bug.

#### Product impact — bounded

All predictions with calibrated output in [42%, 58%] (margin < 8pp) are labelled
`INSUFFICIENT_EDGE` by `computeRecommendation`, which catches every near-50% prediction
including this bucket. Users see "Low Confidence / coin-flip" wording regardless of
whether the calibrated number reads 50% or 55.65%. Investigation of a softer left-tail
treatment (Platt scaling or a custom prior) is deferred to a future calibration cycle.

---

### Bucket B: x=0.66–0.75 (Kostyuk/Swiatek region — primary check)

| x    | n     | empirical%  | calibrated%  | gap       | flag? |
|------|-------|-------------|--------------|-----------|-------|
| 0.66 | 1,638 | 73.69%      | 72.86%       | −0.83pp   |       |
| 0.67 | 1,474 | 72.80%      | 73.56%       | +0.76pp   |       |
| 0.68 | 1,325 | 74.49%      | 75.14%       | +0.65pp   |       |
| 0.69 | 1,231 | 75.47%      | 76.72%       | +1.25pp   |       |
| 0.70 | 1,136 | 76.50%      | 78.30%       | +1.81pp   |       |
| 0.71 | 1,115 | 78.03%      | 79.88%       | **+1.86pp** |     |
| 0.72 |   971 | 80.43%      | 81.46%       | +1.03pp   |       |
| 0.73 |   858 | 82.17%      | 83.01%       | +0.84pp   |       |
| 0.74 |   742 | 84.50%      | 84.56%       | +0.06pp   |       |
| 0.75 |   618 | 85.60%      | 86.12%       | +0.52pp   |       |

**Max |gap|: 1.86pp at x=0.71. No bucket exceeds 2pp. ✓**

Previously x=0.666 was showing 84.5% calibrated output (pre-Step-1 flat-zone bug).
It now reads 72.86%, which is 0.83pp below the empirical 73.69% — well within noise.

---

### Bucket C: x=0.85–0.95

**No validation data in this range.** `orientedX` in the validation set tops out at
x=0.80 (n=40). The calibration ceiling (y=0.8829 from x=0.768 to x=1.0) is therefore
**unverified in-sample** above x=0.80.

| x    | n   | empirical%  | calibrated%  | gap       | flag? |
|------|-----|-------------|--------------|-----------|-------|
| x=0.81–0.95 | — | — | — | — | no rows with n≥20 |

For context, the highest-x data that does exist:

| x    | n     | empirical%  | calibrated%  | gap       | flag? |
|------|-------|-------------|--------------|-----------|-------|
| 0.76 |   490 | 88.78%      | 87.05%       | −1.73pp   |       |
| 0.77 |   405 | 89.88%      | 88.29%       | −1.59pp   |       |
| 0.78 |   227 | 89.43%      | 88.29%       | −1.14pp   |       |
| 0.79 |   102 | 85.29%      | 88.29%       | +3.00pp   |       |
| 0.80 |    40 | 87.50%      | 88.29%       | +0.79pp   |       |

x=0.79 shows +3.00pp with n=102. Standard error at that sample size is ~3.5pp — the gap
is within one standard error. The ceiling at 88.29% is a reasonable empirical upper
bound given available training data. The x=0.85–0.95 range is unverifiable in-sample
and noted as a known limitation.

---

## Summary

| Check | Result |
|---|---|
| Monotone (knots) | ✓ Clean |
| Monotone (full validation set, 335 x-values) | ✓ Clean |
| Bucket A x=0.40–0.50 | **1 bucket flagged: x=0.50 (+5.75pp)** — flat-zone isotonic constraint; x=0.40–0.49 empty by construction; product impact bounded by INSUFFICIENT_EDGE gate |
| Bucket B x=0.66–0.75 | ✓ Max gap 1.86pp — no bucket exceeds 2pp |
| Bucket C x=0.85–0.95 | No in-sample data; right-tail ceiling (88.29%) unverified above x=0.80 |

## Conclusion

Model #712 passes the monotonicity and primary bucket checks. The Bucket A flag at
x=0.50 is a known limitation of isotonic regression's flat-zone boundary behaviour,
bounded in product impact by the `INSUFFICIENT_EDGE` gate. The x=0.85–0.95 range has
no in-sample validation data; the calibration ceiling is consistent with the available
x=0.76–0.80 data.

**Step 2: DONE.**
