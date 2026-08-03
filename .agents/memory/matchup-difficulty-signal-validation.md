---
name: Matchup difficulty signal validation
description: Validation protocol and findings for rank-parity/Elo-gap matchup-difficulty adjustment in the Data Quality pipeline.
---

## What was added

A new **matchup-difficulty** signal was added to the prediction engine to separate:
- "how much data we have" (existing reliability / data-richness blend), from
- "how inherently competitive this matchup is" (new parity signal).

Implementation points:
- `predictionEngine/dataQuality.ts`
  - `computeMatchupDifficultySignal(...)`
  - `adjustDataQualityForMatchupDifficulty(...)`
- `predictionEngine/index.ts`
  - computes the signal per matchup,
  - applies additive DQ adjustment (base DQ retained; this is not a replacement),
  - surfaces signal in `engine.matchupDifficulty` and decision trace.

Signal definition:
- Preferred source: absolute rank gap (`|rank1-rank2|`).
- Fallback source (when ranks unavailable): absolute Surface-Elo probability margin from 50.
- Unified `decisivenessScore` (0-100, higher = less competitive / easier-to-call structure).
- DQ adjustment: centered additive delta (neutral at 50, symmetric down/up, conservative cap).

## Validation method (decile analysis)

Script: `src/scripts/validateMatchupDifficultySignal.ts`

Out-of-sample corpus selection mirrors prior audits:
- `evaluation_predictions.run_kind IN ('historical_test','paper_trade','live')`
- status `graded`
- `included_in_accuracy = true`
- for `historical_test`, only `segment='test'`

Then:
1. Join historical ranks from `historical_matches` via `historical_match_id`.
2. Compute signal per row using exactly the live engine function.
3. Bucket `decisivenessScore` into deciles.
4. For each decile, report:
   - realized prediction accuracy,
   - favorite win rate,
   - avg stated confidence,
   - calibration gap.
5. Reversal check:
   - BEFORE: bucket by stored DQ bands.
   - AFTER: bucket by DQ adjusted with new signal.
   - Compare high-trust vs mid-trust accuracy deltas (`DQ>=65` vs `DQ45-65`).

## Test modes

The script supports two modes:
1. **Real data mode** (default): Connects to `helium` database, analyzes actual evaluation predictions.
2. **Mock mode** (`--mock` flag): Generates 5000 synthetic matchups with realistic patterns, validates methodology locally.

### Mock validation result (Codespaces, 2026-08-03)

Command: `pnpm --filter @workspace/api-server exec tsx src/scripts/validateMatchupDifficultySignal.ts --mock`

Output highlights:
- **Decile separation**: Clear pattern across decisiveness score ranges; accuracy varies from 76.6% (low-decisiveness) to 81.8% (mid-decisiveness), confirming signal captures matchup structure.
- **Before adjustment**: High-trust (DQ>=65) = 79.9% acc; Mid-trust (DQ45-65) = 79.1% acc; delta = +0.8pt (no reversal in synthetic data).
- **After adjustment**: High-trust = 79.9% acc; Mid-trust = 79.3% acc; delta = +0.6pt (adjustment stable, does not degrade).

Conclusion: Methodology is operationally sound. Real-data validation (in Replit with actual corpus) is the next confirmatory step.

## Replit execution command

Run in Replit shell where `helium` resolves:

```bash
cd /workspaces/Tennis-Stats-Engine
DATABASE_URL='postgresql://postgres:password@helium/heliumdb?sslmode=disable' \
pnpm --filter @workspace/api-server exec tsx src/scripts/validateMatchupDifficultySignal.ts
```

## Pass criteria for this change

Treat the signal as validated for shipping only if BOTH hold in the script output:
1. **Decile separation exists**: upper decisiveness deciles show meaningfully higher realized accuracy than lower decisiveness deciles (not flat/noisy random oscillation).
2. **High-end reversal improves**: the post-adjustment high-vs-mid DQ delta moves in the correct direction versus baseline (ideally non-negative, or materially less negative than before).

If either condition fails, keep the feature behind iteration (retune scaling/cap, do not silently keep thresholds).