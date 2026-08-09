---
name: Calibration orientation bias — fixed 2026-08-09
description: Root cause, swap-invariance proof, and fix for the training orientation bug where calibration was trained in player1 space instead of predicted-winner space.
---

## Root Cause (introduced 2026-07-11, fixed 2026-08-09)

Both training paths used `outcome = (actualWinnerId === player1Id) ? 1 : 0`.
In Sackmann-sourced historical data the winner is stored as player1 in ~90% of
rows. So the calibration learned "player1 wins 85-90% of the time regardless of
raw signals" — not a tennis fact, an artefact of storage convention.

Confirmed by swap-invariance test (-1b): same hypothetical matchup produced a
**59.4pp asymmetry** depending solely on which player was in the player1 slot.

## Fix Applied (2026-08-09)

### Training — both paths now use predicted-winner orientation

**General (`walkForward.ts` line 326):**
```typescript
const raw = r.rawProbability as number; // 0-1 in-memory scale
const predictedPlayer1 = raw >= 0.5;
return {
  rawProbability: predictedPlayer1 ? raw : 1 - raw,  // always in [0.5, 1.0]
  outcome: (predictedPlayer1 === r.player1Won ? 1 : 0) as 0 | 1,
};
```

**Specialist (`specialistWeights.ts` line 163):**
```typescript
const raw = (r.rawProbability as number) / 100; // normalize DB 0-100 → 0-1
const predictedPlayer1 = raw >= 0.5;
const actualPlayer1Won = r.actualWinnerId === r.player1Id;
return {
  rawProbability: predictedPlayer1 ? raw : 1 - raw,
  outcome: (predictedPlayer1 === actualPlayer1Won ? 1 : 0) as 0 | 1,
};
```

### Inference — `applyCalibrationOriented` helper added to `calibration.ts`

Re-orients player1-perspective raw → looks up mapping → de-orients output.
Mathematically guarantees: `applyCalibrationOriented(knots, r) + applyCalibrationOriented(knots, 1-r) = 1`

**Call sites updated (all production inference paths):**
- `walkForward.ts:632` — recalibrate stored fold predictions
- `predictionEngine/index.ts:634` — live general calibration
- `predictionEngine/index.ts:657` — live specialist calibration
- `backtestService.ts:331` — historical backtest
- `bridgeRescore.ts:197` — bridge rescore

**NOT updated (correct as-is):**
- `specialistWeights.ts` log-loss comparison loops — those points are already
  in predicted-winner space after the training fix; plain `applyCalibration` is
  correct there.

### Stale model deactivated

`calibration_models id=711` (isotonic, the wrong-orientation model) set to
`active=false` via psql on 2026-08-09. Engine now runs on raw scores until a
fresh walk-forward refits in the new orientation.

### Swap test updated

`swapInvariance.test.ts` now uses placeholder knots in [0.5, 1.0]
predicted-winner space and **asserts** `|calibSum - 100| < 2pp` instead of
documenting the asymmetry. The test will fail if the orientation bug regresses.

## How to Apply to Future Changes

1. Any new training path that constructs `CalibrationPoint` objects must use
   `rawProbability = max(raw, 1-raw)` and `outcome = (predicted winner won)`.
2. Any new inference path that applies a calibration mapping to a player1-
   perspective raw probability must use `applyCalibrationOriented`, never bare
   `applyCalibration`.
3. After any change to the calibration training code, re-run
   `prediction-engine-invariants` and confirm `calibSum ≈ 100`.

## Flat-zone characterisation correction (confirmed 2026-08-09)

"Zero training support" was wrong. There are 6,073 training rows in bins 15–50%.

The correct characterisation: **perverse training signal**. Folds 243, 244, 245 are pure
Sackmann data where player1 wins 100% of every row (4,551/4,551 each) — not by coincidence,
but because Sackmann stores the winner as player1 without exception. Fold 246 (mixed sources)
is 61.2%. PAVA sees a decreasing win-rate sequence at low x (violates monotone increasing) and
merges all of x=0.17→0.47 into one flat block at y≈84.5%.

## B-concordant confirmation (Rinderknech/Nakashima, 2026-08-08)

Rinderknech vs Nakashima (live #8006): raw ensemble 40.6% for Rinderknech (all 4 signals favour
Nakashima). General at x=0.406 → flat zone → 84.5%. ATP-Hard specialist at x=0.406 → flat zone
→ 85.9%. Final: 85.5% for Rinderknech (wrong direction). Both calibrators in flat zone
simultaneously — specialist does not moderate General. Confirmed B-concordant same root cause as
Kostyuk/Swiatek.

## Pegula/Shnaider tail confirmation (2026-08-08)

Live #8010: raw 69.6% for Pegula. General at x=0.6963 interpolates between right-tail knots
(x=0.6725, y=99.31%) and (x=0.7224, y=99.90%) → 99.6%. WTA-Hard specialist: 91.3%. Final:
92.5%. **Different mechanism from flat zone** — interpolation zone overconfidence in the correct
direction. Pegula won. Right-tail knots near 100% are inflated because model-correctly-favours
player1 compounds with Sackmann-stores-winner-as-player1.

## Walk-Forward Refit Required

The next step is triggering a walk-forward run to generate a correctly-oriented
calibration model. Until that completes (~2-3 hrs), the engine runs on
uncalibrated raw scores (honest, not broken).

## Why

Sackmann stores the match winner as player1. At inference time, player1 is
assigned arbitrarily. The two conventions are incompatible, so calibration
trained in player1 space produces outputs that depend on slot assignment, not
evidence.
