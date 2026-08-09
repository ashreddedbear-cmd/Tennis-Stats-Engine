---
name: Calibration orientation bias (Task #172 audit)
description: Root cause and swap-invariance proof for the -1a orientation bug — calibration trained on Sackmann data where player1=winner 90.33% of the time, producing a non-symmetric PAVA pool that overrides unanimous raw signal consensus.
---

## Root Cause

Calibration id=711 (active as of 2026-08-08) was trained on 16,760 rows from evaluation_runs folds 243–246. Of those rows:
- 90.33% have `actualWinnerId = player1Id` (Sackmann convention: winner stored as player1)
- Even when the model opposes player1 (raw < 50%), player1 still wins 84.7% of the time

This creates a non-monotone U-shaped win-rate curve across raw probability bins. PAVA pooled the entire range x ∈ [0, 0.4506] into a single flat block at y = 0.8448. The DB anchor knot is `{x:0, y:0.8448}` — the entire left tail is flat at 84.5%, not shrinking toward 0.

**Why:** In training, "model gives player1 only 25% probability" means the model disagrees with the stored winner order. Player1 (the stored winner) still wins ~97% of the time — not because the model is wrong, but because player1 IS the winner in the Sackmann format.

**At inference:** player1 is an arbitrarily-ordered player, not the match winner. So a 25% raw probability for player1 correctly means player1 is a heavy underdog — but the calibration maps it to 84.5% (the wrong direction entirely).

## Swap-Invariance Test (-1b) — Confirmed 2026-08-09

Test: `artifacts/api-server/src/services/predictionEngine/swapInvariance.test.ts`

Inputs: weakPlayer (rank 180, 1W-5L Hard) vs strongPlayer (rank 8, 16W-4L Hard).
Active calibration id=711 + ATP-Hard specialist (weight=0.702).

Results:
- Forward raw (weak=player1): 24.90% | Swapped raw (strong=player1): 75.00% → sum = 99.90% → **raw engine IS symmetric** ✓
- Forward calibrated: 60.00% → predicted winner: weakPlayer
- Swapped calibrated: 99.40% → predicted winner: strongPlayer
- Calibrated sum: 159.40% → **59.4pp asymmetry** ✗
- Weak player's win probability: 60.0% (forward) vs 0.6% (swapped) — 59.4pp gap

The raw ensemble is correct. The calibration is not.

## PAVA Pool Structure (General, id=711)

Flat zone: x=0 through x=0.4506 → y=0.8448 (n=3,753 training rows, 86.84% empirical win rate)
Right-tail flat: x≥0.7658 → y=100% (n=1,408 training rows, 100% win rate — also orientation bias, not extrapolation)
Steep interpolation zone: x=0.6725 (99.31%) through x=0.7224 (99.90%) — produces 99.6% outputs at ~69.7% raw input (the Pegula/Shnaider case — a DIFFERENT phenomenon from the Kostyuk/Rinderknech PAVA pool cases).

## Specialist Notes

- ATP-Hard (weight=0.702): flat zone x ∈ [0, 0.4315] → y=0.8594. B-concordant with General in Rinderknech case (both in flat zones simultaneously).
- WTA-Hard (weight=0.85): DIFFERENT behavior — first real knot at x=0.5357, y=0.2741 (left tail at 27.4%, not 84%). Different WTA training distribution.
- specialist_models column is `calibration_mapping` (not `mapping` or `knots`).
- calibration_models column is `mapping` (not `knots`).

## Reference Cases

- Kostyuk/Swiatek (Aug 8, WTA-Hard): All 4 signals → Swiatek ~63%. Engine: 64% Kostyuk. B-concordant flat zone. Swiatek won.
- Rinderknech/Nakashima (Aug 8, ATP-Hard): All 4 signals → Nakashima. Engine: ~86% Rinderknech. B-concordant (both ATP-Hard specialist at x≈33% and General at x≈33% both in flat zones). Nakashima won.
- Pegula/Shnaider: All signals → Pegula ~93%. General: 99.6% (interpolation zone at x≈69.7%, NOT flat PAVA pool). Different mechanism.

## STEP 1 Fix Design

Re-orient calibration training so x and outcome are always from the predicted winner's perspective:
- if rawProbability >= 50: x = rawProbability/100, outcome = (actualWinnerId === player1Id ? 1 : 0)
- else: x = (100 - rawProbability)/100, outcome = (actualWinnerId === player2Id ? 1 : 0)

At inference: apply calibration to max(raw, 1-raw), then assign to the raw-favored player.
This makes calibration structurally symmetric by construction. Requires both General and Specialist training paths to adopt new orientation + fresh walk-forward refit.

## How to Apply

Before any calibration training code change, check that:
1. CalibrationPoint construction uses predicted-winner-relative x and outcome (not player1-relative)
2. Inference in index.ts applies calibration to max(raw, 1-raw) and assigns to favored player
3. Walk-forward uses the new orientation for BOTH General (walkForward.ts lines 316-328) and Specialist (specialistWeights.ts lines 140-163)
