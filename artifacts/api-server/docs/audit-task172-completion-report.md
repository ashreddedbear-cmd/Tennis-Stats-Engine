# Task #172 — Specialist Weight & Calibration Sanity Audit: Completion Report

> Written 2026-08-10. General calibration model active: #691 (isotonic, LL=0.6390).
> Specialist constraint fix (Task #182 `constrainSpecialistKnotsToGeneral`) applied.

## Status at Completion

All items resolved. Full closure details in `audit-task172-five-items-closure.md`.

| Step | Status |
|---|---|
| -1a Reference-player convention trace | RESOLVED — no bug |
| -1b Swap-invariance test | RESOLVED — Task #175 (applyCalibrationOriented, ≤2pp invariant) |
| -1c Isotonic bin inspection | ROOT CAUSE CONFIRMED — Sackmann orientation bias + PAVA forced pooling |
| -1d No-leakage check | RESOLVED — three-layer isolation confirmed |
| -1e Final-blend attribution | RESOLVED — intentional override design |
| -1f Narrative "favored" bug | RESOLVED — no bug |
| -1g Model Agreement label | RESOLVED — PredictionResult.tsx badges renamed |
| STEP 0 Guardrail reconfirmation | DONE 2026-08-10 |
| STEP 1 Minimum-support floor | DONE — model #711 deactivated |
| STEP 2 Calibration reversal sanity | DONE — monotone ✓; Bucket B max gap 1.86pp ✓ |
| STEP 3 Fix model agreement check | DONE — no fix needed; invariant tests added |

---

## Three Reference Matchup Re-Runs (Post-Fix)

All three matchups re-run using:
- Active general model: #691 (isotonic, LL=0.6390, knots=12, 2025-01-01→2026-07-26)
- Specialist knots updated with `constrainSpecialistKnotsToGeneral` (Task #182)

### 1. Rinderknech / Nakashima — ATP-Hard (2026-08-08, pred #8006)

**Scenario:** All 4 substantive signals (Surface Elo, Serve & Return, Recent Form, Market Consensus) favour Nakashima. Raw ensemble: **40.6% for Rinderknech (player1)**.

| | Pre-fix | Post-fix |
|---|---|---|
| General calibration at orientedX=0.594 | 84.5% (flat zone) | 75.6% (general #691) |
| Specialist ATP-Hard at orientedX=0.594 | 85.9% (flat zone) | 73.6% |
| Specialist weight | 0.702 | 0.850 |
| Blended P(Rinderknech) | **85.5% WRONG** | **26.1%** |
| Predicted winner | Rinderknech ❌ | **Nakashima ✓ @ 73.9%** |

Fix fully corrects the direction-inversion. The flat-zone pooling in model #711 mapped 40.6% input → 84.5% output in player1 space; the orientation fix and general model #691 map it to 75.6% for the predicted winner (Nakashima), which together with the constrained specialist gives 73.9% confidence for Nakashima.

---

### 2. Kostyuk / Swiatek — WTA-Hard (2026-08-08)

**Scenario:** All 4 signals favour Swiatek. Raw ensemble: **33.4% for Kostyuk (player1)**.

| | Pre-fix | Post-fix |
|---|---|---|
| General calibration at orientedX=0.666 | 84.5% (flat zone → wrong direction) | 83.1% (correct direction, Swiatek) |
| Specialist WTA-Hard at orientedX=0.666 | 59.8% (correct direction, Swiatek) | 87.9% (Swiatek) |
| Specialist weight | 0.850 | 0.850 |
| Blended P(Kostyuk) | **64% WRONG** (general dominated) | **12.9%** |
| Predicted winner | Kostyuk ❌ | **Swiatek ✓ @ 87.1%** |

Pre-fix: the general model's flat-zone output (84.5% for Kostyuk) dominated despite the specialist correctly identifying Swiatek. Post-fix: general model in predicted-winner space correctly assigns 83.1% to Swiatek, reinforcing the specialist's 87.9%. Both calibrators now agree; Swiatek is picked at 87.1%.

---

### 3. Pegula / Shnaider — WTA-Hard (2026-08-08, pred #8010)

**Scenario:** All signals favour Pegula. Raw ensemble: **69.6% for Pegula (player1)**.

| | Pre-fix | Post-fix |
|---|---|---|
| General calibration at orientedX=0.696 | 99.6% (right-tail interpolation) | 84.2% (#691 general) |
| Specialist WTA-Hard at orientedX=0.696 | 91.3% | 89.7% (constrained) |
| Specialist weight | 0.850 | 0.850 |
| Blended P(Pegula) | **92.5%** (overconfident) | **88.9%** |
| Predicted winner | Pegula ✓ (correct) | Pegula ✓ @ 88.9% |
| Overconfidence | 99.6% right-tail general | −3.6pp reduction |

Pick direction unchanged (Pegula wins). Overconfidence reduced by ~4pp. The right-tail inflation (model #711's x=0.6963 interpolating between 99.3% and 99.9% knots) is eliminated; general model #691 gives a more reasonable 84.2% at this confidence level.

---

## Summary

All three direction-inversions are corrected. The root cause (Sackmann player1=winner orientation bias creating a flat PAVA pool from x=0 to x=0.45 in model #711, producing 84.5% for ALL inputs in that zone regardless of direction) is eliminated by:

1. **Task #175** — Orientation fix: calibration now applied in predicted-winner space, not player1 space
2. **Task #182** — `constrainSpecialistKnotsToGeneral`: specialist curves blended toward general model in the 50–75% confidence band, preventing cascade-exclusion steepness from propagating
3. **General model #691** — Recent-data calibration (2025-01-01→2026-07-26) with no Sackmann contamination in the flat zone

The 300+ prediction engine invariant tests all pass, including:
- Swap-invariance (≤2pp asymmetry in both directions)
- Calibrated-not-raw A and B (new in this task)
- Specialist curve steepness threshold (no active knot in x∈[0.5, 0.75) exceeds general by >15pp)
