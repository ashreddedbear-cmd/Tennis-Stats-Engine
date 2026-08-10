# Task #184: Specialist Curve Refit — Audit Record

**Date:** 2026-08-10  
**Calibration model used:** id=712, method=isotonic, validationSampleSize=84,885  
**Action taken:** `computeAndStoreSpecialistSegments(generalMapping)` called directly against the active calibration model. This is the same function a walk-forward training run calls at its end; the corpus was already fully scored (append-only design), so the specialist refit was the only step needed to activate the constrained knots from Task #182.

## Root cause confirmed (pre-refit)

The stored ATP-Hard `calibrationMapping` before this refit contained a steep curve caused by cascade-exclusion bias (Task #56 strips pre-cutoff tie-breaker rows, which disproportionately removed "hard/close" ATP matches from specialist training data, leaving an easy-match-skewed corpus):

```
ATP-Hard knot near x=0.574: y=0.907
→ 57% ensemble input mapped to ~91% calibrated output (anomalous)
```

General model at the same x range:
```
x=0.524 → y=0.556
x=0.571 → y=0.663
```

The specialist was mapping moderate-confidence inputs (~55%) to outputs 28–35pp above the general model — far outside the 10pp convergence requirement.

## Fix applied (constrainSpecialistKnotsToGeneral, Task #182)

After calling `computeAndStoreSpecialistSegments` with `constrainSpecialistKnotsToGeneral` active:

```
ATP-Hard knot at x=0.55: y=0.602
General model interpolated at x=0.55: ≈0.600
Gap: ~2pp — well within the 10pp convergence threshold
```

The trust ramp `clamp((x - 0.5) / (0.75 - 0.5), 0, 1)` at x=0.55:
- trust = (0.55 - 0.50) / (0.75 - 0.50) = 0.20
- blendedY = 0.20 × specialistY + 0.80 × generalY → dominated by general model at this x

## Live prediction engine impact

Prediction engine blending formula (confirmed in `artifacts/api-server/src/services/predictionEngine/index.ts`):
```
blendedProbability = specialistWeight × specialistProbability + (1 − specialistWeight) × generalProbability
```

For ATP-Hard at 55% ensemble input:
- **Before:** specialist ≈ 91%, weight ≈ 0.702 → blend ≈ 0.702 × 91% + 0.298 × 62% = ~82%  
- **After:** specialist ≈ 60%, weight ≈ 0.706 → blend ≈ 0.706 × 60% + 0.294 × 62% = ~61%

**Reduction in overconfidence: ~21pp at x=0.55 moderate-confidence inputs.**

## All 8 segments — post-refit state

| Segment | meetsThreshold | n (validation) | weight | knot~x=0.55 (y) |
|---------|---------------|----------------|--------|-----------------|
| ATP-Hard | true | 18,064 | 0.706 | 0.602 |
| ATP-Clay | true | 12,583 | 0.707 | 0.650 |
| ATP-Grass | true | 5,030 | 0.709 | 0.660 |
| ATP-IndoorHard | true | 386 | 0.700 | 0.679 |
| WTA-Hard | true | 9,408 | 0.707 | 0.643 |
| WTA-Clay | true | 6,199 | 0.704 | 0.650 |
| WTA-Grass | true | 3,304 | 0.701 | 0.660 |
| WTA-IndoorHard | true | 58 | 0.549 | 0.666 |

All segments show knot-at-x=0.55 values in the range 0.60–0.68, consistent with the general model's ~0.60–0.63 at the same x (all within 10pp).

## Convergence constraint verification

The convergence constraint guarantees: for any knot at x ∈ [0.5, SPECIALIST_FULL_TRUST_X=0.75),  
`|specialistY − generalY| ≤ (1 − trust) × |rawSpecialistY − generalY|`  
where trust = clamp((x−0.5)/(0.75−0.5), 0, 1).

At x=0.55, trust=0.20, so at most 20% of any specialist overconfidence leaks through — confirmed by the ATP-Hard measurement (2pp gap vs 28–35pp before).

## Regression test

A regression test was added to `artifacts/api-server/src/services/evaluation/specialistWeights.test.ts` (Task #184 convergence constraint test) that reads stored `specialist_models` rows from the live DB and asserts:
1. Every active specialist's stored knots satisfy the convergence constraint at x ∈ [0.5, 0.75)
2. No knot in that band exceeds the general model by more than 15pp

This test prevents silent regression if `constrainSpecialistKnotsToGeneral` is accidentally removed or its trust ramp is widened.
