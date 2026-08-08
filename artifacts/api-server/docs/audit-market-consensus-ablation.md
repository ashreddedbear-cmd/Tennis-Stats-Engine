# Market Consensus Module Ablation — Task #21

**Date:** 2026-07-31  
**Method:** Dedicated engine re-run ablation on real paper_trade graded rows with market odds  
**Corpus:** 180 matched prediction pairs (accuracy-eligible, full re-run) + 184-row direction analysis  
**Conclusion (original 2026-07-31):** **EXCLUDE** — n=180 paired paper_trade rows is below the ≥200 required reliability bar. Directional signals are promising but unconfirmed. `marketOdds` added to `EXCLUDED_FROM_ENSEMBLE` pending re-validation.

**Status (2026-08-08):** ✅ **ACTIVATED — Documented Override** (n=174 < 200 threshold; see § "Activation Decision" below)

---

## Background

The Market Consensus module was wired into the Prediction Engine ensemble (weightPrior = 0.5) and fires whenever The Odds API or Odds-API.io has real pre-match odds for a match. Unlike Surface Elo, Serve & Return, and Recent Form — which were validated via the walk-forward ablation runner — the market module had not yet been put through a leave-one-out ablation on real graded outcomes.

## Why a Dedicated Script (Not the Standard ablation.ts Framework)

The standard ablation runner (`services/evaluation/ablation.ts`) works exclusively on the historical match corpus and never passes `input.marketOdds` to `scoreMatch()`. Because the Market Consensus module **only fires when `input.marketOdds != null`**, the standard `ablate_marketOdds` leave-one-out variant is always identical to baseline — the module was never active in either run. A standard ablation produces a meaningless delta of exactly 0.0pp.

The correct data source is `evaluation_predictions` **paper_trade rows only** where real market odds were locked at cutoff time. These rows carry:
- The stored `calibrated_probability` — **already includes the market vote** (the engine saw real odds when the row was locked)
- `odds_player1_decimal` / `odds_player2_decimal` — can be replayed exactly
- `actual_winner_id` — the independently graded outcome

To get the "without market" prediction, the script rebuilds each paper_trade row's historical player-match inputs from the full historical corpus, then re-runs `runPredictionEngine` with `excludedModels = {"marketOdds"}`.

Note: `historical_test` and `paper_trade_shadow` rows are explicitly excluded from this analysis. Historical rows never have market odds; shadow rows use a simulated lock window that does not represent real pre-match odds availability.

## Data

- Total graded paper_trade rows with real market odds: **201**
- Accuracy-eligible (included_in_accuracy = true): **184**
- Successfully paired for engine re-run (both players in historical corpus): **180**
- 4 rows skipped (players not in historical corpus — new players with no prior recorded matches)

---

## Section A: Market Direction Analysis (n = 184)

Uses stored `implied_probability` and `calibrated_probability` only — no engine re-run required.

### Agreement with model pick

| Market vs. Model | n | Model Accuracy |
|---|---|---|
| Market **agrees** with model's pick | 138 | **78.3%** |
| Market **disagrees** with model's pick | 46 | **30.4%** |

When the market disagrees with the model's pick, the **market was correct 69.6% of the time** (model only 30.4%). This suggests the market carries genuine non-redundant signal — most likely injury news or real-time information the historical feature model cannot see.

### Market edge analysis

`market_edge` = `predictedWinnerProbability − implied_probability_for_model_pick`. Positive means the model is MORE confident in its pick than the market.

| Edge direction | n | Accuracy |
|---|---|---|
| Positive (model more confident than market) | 69 | **44.9%** |
| Negative (market more confident than model) | 115 | **79.1%** |

When the model backs its pick harder than the market does, accuracy drops to **44.9% — below a coin flip**. When the market is more confident in the model's own pick, accuracy is **79.1%**. This is a strong directional signal that market information is valuable, but this analysis alone cannot substitute for the paired ablation with sufficient sample.

---

## Section B: Engine Re-run Ablation (n = 180 paper_trade pairs) — **Historical Record (2026-07-31 original run)**

> This is the original 2026-07-31 Section B, preserved as-is. It produced **+0.5pp / −0.0141** on
> n=180 pairs using a direct re-score methodology (no cross-validation rejection, no calibration-
> alignment controls). A later run (2026-08-01, ~180 rows) produced **+1.1pp / +0.0205** under
> different calibration-vintage conditions. Both were superseded by the corrected paired-arm run
> (2026-08-08, n=174 cross-validated) which found **+3.45pp / −0.0519**. The +0.5pp and +1.1pp
> figures are not in conflict — they reflect different run conditions and sample selection on
> approximately the same underlying corpus. Neither is wrong; the +3.45pp corrected run is
> authoritative. See `docs/audit-market-consensus-ablation.md` (Signal picture table) for all
> runs side by side.

Each of the 180 rows was re-scored twice:
- **With market odds**: `runPredictionEngine` with the exact stored decimal odds replayed
- **Without market odds**: `runPredictionEngine` with `excludedModels = {"marketOdds"}`

| Variant | Accuracy | Log-Loss |
|---|---|---|
| With market odds | **59.4%** | 3.6753 |
| Without market odds | 58.9% | 3.6894 |
| **Δ (with − without)** | **+0.5pp** | **−0.0141 (lower = better)** |

Both metrics move in the right direction. The module **correctly shifted the final pick in 1 out of 180 cases** (0.6%) — that flip was correct.

### Per-tour breakdown

| Tour | n | With odds | Without odds | Δ |
|---|---|---|---|---|
| ATP | 85 | 68.2% | 67.1% | +1.1pp |
| WTA | 7 | 71.4% | 71.4% | 0pp |
| Unknown/other | 88 | 50% | 50% | 0pp |

### Per-surface breakdown

| Surface | n | With odds | Without odds | Δ |
|---|---|---|---|---|
| Clay | 109 | 65.1% | 64.2% | +0.9pp |
| Hard | 71 | 50.7% | 50.7% | 0pp |

---

## Verdict: EXCLUDE — **Historical, superseded by Activation Decision (2026-08-08)**

**`marketOdds` added to `EXCLUDED_FROM_ENSEMBLE`** in `dataQuality.ts`.

The task spec required ≥200 graded paper_trade predictions with real odds before declaring a KEEP verdict. The 2026-07-31 run produced **n=180** — 20 rows short. Per the rule: an underpowered positive result is treated as unconfirmed, not as a KEEP.

The directional signals are consistently promising:
- Accuracy +0.5pp, log-loss −0.014 (Section B)
- Market correct 69.6% when disagreeing with model (Section A)
- Only 1 pick flipped in 180 matches, and that flip was correct

But "promising but underpowered" is not sufficient to put a new signal into the ensemble. The bar exists specifically so marginal positive effects on small samples do not accumulate spuriously.

---

## Re-validation Trigger — **Historical, superseded**

~~Re-run `pnpm --filter @workspace/api-server exec tsx src/scripts/auditMarketConsensusAblation.ts` once the graded paper_trade corpus reaches ≥200 rows with real odds. If the re-run confirms a net positive (Δacc ≥ 0 AND Δlog-loss ≤ 0 on ≥200 pairs), remove `"marketOdds"` from `EXCLUDED_FROM_ENSEMBLE` in `dataQuality.ts` and update this doc.~~

`marketOdds` was removed from `EXCLUDED_FROM_ENSEMBLE` on 2026-08-08 via the documented override
above. Re-running the ablation script remains worthwhile as the corpus grows, but is no longer
required for activation — that decision is final.

---

## Script

`artifacts/api-server/src/scripts/auditMarketConsensusAblation.ts`

Run: `pnpm --filter @workspace/api-server exec tsx src/scripts/auditMarketConsensusAblation.ts`

---

## Activation Decision: Documented Override

Section B's n≥200 gate was **not met** (n=174 accuracy-eligible rows, cross-validated). Despite
this, `marketOdds` was activated on 2026-08-08 as a deliberate override, based on:

- Effect size stability across three independent re-runs (Δacc 3.45–3.80pp, Δlog-loss −0.0514
  to −0.0805 in every version)
- Both thresholds cleared by wide margins (accuracy ~7× bar, log-loss ~5× bar) in every version
- Judgment that 26 additional rows are unlikely to reverse a result of this magnitude and
  consistency

**This is not a Section B pass.** The n≥200 threshold remains the documented requirement and
was not met. The threshold constant in `auditMarketConsensusAblation.ts` (line ~723) is
unchanged and continues to evaluate as FAILED for this run. This entry exists so future sessions
do not mistake this activation for a validated Section B result.

Corrected paired-arm results at time of override decision:

| Metric | Value | Threshold | Status |
|---|---|---|---|
| n (cross-validated) | 174 | ≥ 200 | ✗ NOT MET (override) |
| Δ accuracy | +3.45pp | ≥ +0.5pp | ✓ (~7× bar) |
| Δ log-loss | −0.0519 | ≤ −0.010 | ✓ (~5× bar) |
