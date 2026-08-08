---
name: Degenerate calibration model activation guard
description: When walk-forward produces too few validation points, fitBestCalibration returns holdoutSampleSize=0 and a constant y=1 mapping; walkForward.ts must check this before replacing the active model.
---

## Rule
Before deactivating the current active `calibration_models` row and inserting a replacement, check `liveFit.holdoutSampleSize > 0`. Only replace when the holdout gate passes. Write the new model to the DB regardless (for diagnostics), but set `active: false` when the gate fails.

**Why:** `fitBestCalibration` requires ≥100 holdout points for the isotonic/Platt comparison. When total validation points < ~120, `splitForCalibrationHoldout` returns an empty holdout slice. Isotonic regression on a tiny all-wins sample collapses to a constant y=1 mapping — every raw probability becomes 100%. Without the guard, the walk-forward unconditionally called `db.update(...active: false)` on the good model and then inserted and activated the degenerate one. Effect: every prediction jumped to 99%+ and showed HIGHEST CONFIDENCE regardless of the actual matchup.

**How to apply:** The guard is in `artifacts/api-server/src/services/evaluation/walkForward.ts` at the calibration insert step. Also skip `computeAndStoreSpecialistSegments` when the gate fails — specialist models calibrated against a y=1 mapping are equally broken.

**Incident:** Calibration model #697 (fitted 2026-07-30 00:27, validation_sample_size=14, holdout_sample_size=0) replaced the good model #691 (fitted 2026-07-29 20:46, holdout_sample_size=4314). Rolled back manually by setting active=false on #697, active=true on #691.

**Extended 2026-08-08 — three-gate guard:**
The original single `holdoutSampleSize > 0` gate was insufficient — model #708 (holdout n=807, LL=0.6904) passed it and displaced model #691 (LL=0.6390). Guard now has three named checks in `walkForward.ts`:
- `gate1_nonDegenerate`: holdoutSampleSize > 0 (existing)
- `gate2_aboveFloor`: holdoutSampleSize >= MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE (500, exported constant)
- `gate3_notWorseThanCurrent`: new model's isotonicHoldoutLogLoss ≤ active model's LL; bootstrap exception when no active model or active model's LL is null (legacy row)
All three must pass. Rejected activations log per-gate flags and the reason string. Constant `MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE = 500` is exported for tests.
