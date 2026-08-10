# Task #179 — Model Agreement Probability Space Audit

> Executed: 2026-08-10  
> Question: After the Task #175 orientation fix (`applyCalibrationOriented`), does model-agreement
> display use calibrated confidence rather than raw probabilities where it matters?

## Probability pipeline

```
rawEnsembleProbability          ← reliability-weighted blend of feature modules (raw)
  → ensembleProbability         ← after tie-breaker (still raw-space)
  → generalProbability          ← applyCalibrationOriented(activeCalibration, ensemble/100)  [CALIBRATED]
  → specialistProbability       ← applyCalibrationOriented(segment.calibrationMapping, ensemble/100)  [CALIBRATED]
  → blendedProbability          ← weighted blend of general + specialist  [CALIBRATED]
  → preSimulatorProbability     ← blended after reliability discounts  [CALIBRATED]
  → calibratedProbabilityRaw    ← optional simulator blend  [CALIBRATED]
  → calibratedProbability       ← clamped to [0.6, 99.4]  [FINAL CALIBRATED]
```

## Each consumer verified

| Usage | Probability used | File + line | Verdict |
|---|---|---|---|
| Feature-module `modelAgreement` (Strong/Moderate/Mixed/HighDisagreement) | Raw per-module `player1Probability` from `ensembleModuleEdges` | `index.ts:543`, `disagreement.ts:125` | ✓ Correct by design — measures signal consensus before blending and calibration |
| General vs Specialist disagreement | `generalProbability` + `specialistProbability` (both calibrated) | `index.ts:766–768` | ✓ |
| Pre-simulator vs Simulator disagreement | `preSimulatorProbability` (calibrated) vs `simulation.player1WinProbability` | `index.ts:783–784` | ✓ |
| `modelConflict` flag | `ensembleProbability` (raw) vs `calibratedProbability` (final) | `index.ts:844–846` | ✓ Intentional comparison — the flag IS "raw direction ≠ calibrated direction" |
| `margin` → recommendation tiers | `calibratedProbability` | `recommendation.ts:72` | ✓ |
| `margin` → upset risk scoring | `calibratedProbability` | `upsetRisk.ts:117` | ✓ |
| `matchupCloseness` | `calibratedProbability` | `index.ts:814` | ✓ |
| `computeRecommendation` call | `calibratedProbability` | `index.ts` (call site) | ✓ |

## Why raw probabilities appear in two places — both intentional

**1. Feature-module `modelAgreement`:**

The agreement label measures whether the input signals (Elo, recent form, surface, H2H, etc.) 
agree on which player will win. Calibration is applied to the blended ensemble output — it does 
not transform individual module probabilities. Using raw per-module probabilities here is correct: 
you are asking "do the signals agree?" before any blending or calibration smooths their spread.

**2. `models` display array + `modelConflict`:**

`featureModels` (raw per-module) are included in the displayed `models` array alongside the 
"General Model" (`generalProbability`, calibrated) and "Segment Specialist" (`specialistProbability`,
calibrated). This intentional mix is the transparency disclosure: users see both the raw signal 
votes AND the calibration-adjusted interpretation. The disagreement between them is exactly what 
`modelConflict` captures and discloses — "raw evidence favored X, but calibration shifted the pick 
to Y." If the raw module probabilities were replaced with calibrated values in this array, 
`modelConflict` would become meaningless (you'd be comparing calibrated to calibrated).

## Impact of the orientation fix (Task #175)

`applyCalibrationOriented` is correctly wired at both inference call sites:
- `index.ts:634` — general model: `applyCalibrationOriented(input.activeCalibration, ensembleProbability / 100)`
- `index.ts:657` — specialist: `applyCalibrationOriented(segment.calibrationMapping!, ensembleProbability / 100)`

All downstream consumers of `calibratedProbability` (recommendation, upsetRisk, matchupCloseness) 
see the orientation-corrected value. No additional changes needed.

## Conclusion

**No fix required. All model-agreement and probability-space usages are correct.**

The orientation fix from Task #175 is correctly wired into both calibration call sites. Every 
margin-based gate (recommendation tiers, upset risk, matchupCloseness) correctly uses 
`calibratedProbability`. Raw probabilities appear only where they are semantically correct: 
measuring input-signal consensus and disclosing calibration-flipped picks.
