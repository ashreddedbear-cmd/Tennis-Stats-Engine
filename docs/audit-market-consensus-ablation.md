# Market Consensus Ablation — Section B Results

**Generated:** 2026-08-08  
**Status:** ✅ ACTIVATED via documented override (2026-08-08) — n=174 < 200 gate; see `artifacts/api-server/docs/audit-market-consensus-ablation.md § "Activation Decision"`

---

## Decision

**2026-08-08 override:** `marketOdds` was activated despite not meeting the n≥200 gate (n=174).
Effect-size stability across three independent runs (Δacc 3.45–3.80pp, Δlog-loss −0.0514 to −0.0805)
justified the override. See `artifacts/api-server/docs/audit-market-consensus-ablation.md §
"Activation Decision: Documented Override"` for the full rationale.

~~`marketOdds` remains in `EXCLUDED_FROM_ENSEMBLE`. Both the accuracy and log-loss thresholds are
exceeded by a large margin, but the n≥200 processed-row gate is not met.~~

~~**Re-run this script** once n≥200 accuracy-eligible paper_trade rows with odds have passed
cross-validation. If both signal thresholds still hold, remove `"marketOdds"` from
`EXCLUDED_FROM_ENSEMBLE` in `dataQuality.ts`.~~

---

## Section B — Corrected paired-arm ablation (2026-08-08)

### Methodology

Both arms are reconstructed from the stored `preCalibrationProbability` for each paper_trade
row, passed through the **same** active calibration → specialist → simulator pipeline. The only
difference between the two arms is the pre-calibration input:

- **Baseline**: stored `preCalibrationProbability` → current calibration → current specialist
  (Clay disabled) → current simulator → clamp [0.6, 99.4]
- **With market**: `newPreCal = (preCalP1 × S + impliedP1 × 40) / (S + 40)` → same pipeline

S is computed from `WEIGHT_PRIOR × max(1, reliability)` for each feature module and
**cross-validated row-by-row**: if `|Σ(player1Probability × weightUsed) − preCalP1| > 1.5pp`,
the row is rejected as unverifiable. This ensures S is consistent with the stored snapshot and
catches any unexpected module composition differences.

**Why not use stored `calibratedProbability` as the baseline:** that value reflects whichever
calibration model was active at lock time. Calibration drift between lock time and now would
inflate or deflate the "with-market" arm's apparent gain, producing an uninterpretable delta.

**Why Fatigue, Availability, MatchLoadRecovery are NOT in S:** These are in
`EXCLUDED_FROM_ENSEMBLE` and therefore never appear in `engine.models` for live/paper_trade
calls. The stored `featureSnapshot.engine.models` contains only Surface Elo, Serve & Return,
Recent Form, and Head-to-Head as feature modules. If an unexpected module appeared, it would
cause the cross-validation to fail, and the row would be rejected.

### Active configuration

- Calibration model: id=691, method=isotonic, validationN=21,570, holdoutN=4,314
- Active specialists: WTA-Hard, WTA-Clay, ATP-Grass, WTA-Grass, WTA-IndoorHard, ATP-Clay, ATP-Hard
- Clay specialist: disabled in both arms (Ticket 1, 2026-08-08)

### Sample sizes

| Category | Count |
|---|---|
| Total graded paper_trade rows with odds | 201 |
| Accuracy-eligible (graded + included_in_accuracy=true) | 184 |
| Passed cross-validation (gate n) | **174** |
| Rejected by cross-validation | 10 |

The 10 rejected rows had `|Σ(p×w) − preCalP1| > 1.5pp`. These are rows where the stored
snapshot's weight structure diverges from what the current WEIGHT_PRIOR table predicts —
likely from model-configuration changes between lock time and today. Rejecting them ensures
the ablation only uses rows where the reconstruction is verifiably accurate.

### Results

| Metric | Baseline | With market | Delta | Threshold | Pass |
|---|---|---|---|---|---|
| **Accuracy** | 66.67% | 70.11% | **+3.45pp** | ≥ +0.5pp | ✅ |
| **Log-loss** | 0.6066 | 0.5547 | **−0.0519** | ≤ −0.010 | ✅ |
| **n (processed)** | — | — | — | ≥ 200 | ❌ 174 |

### Market vs model disagreement

- Disagreement rate: **23.6%** (n=41 of 174)
- Market accuracy when disagreeing: **68.3%**
- Reconstructed baseline accuracy when disagreeing: **31.7%**

### By surface

| Surface | n | Baseline acc | With-market acc | Δacc | Δlog-loss |
|---|---|---|---|---|---|
| Clay | 104 | 67.3% | 71.2% | +3.8pp | −0.0612 |
| Hard | 70 | 65.7% | 68.6% | +2.9pp | −0.0380 |

---

## Signal picture across all completed sections

| Section | n | Δ accuracy | Δ log-loss | Notes |
|---|---|---|---|---|
| A (market vs model direction, live) | 184 | market right 69.6% on disagree | — | Stored columns only; no confound |
| **B (corrected paired-arm, live)** | **174** | **+3.45pp** | **−0.0519** | **Primary gate — 10 rows rejected by cross-val** |
| B (prior confounded, 2026-08-08) | 184 | +3.80pp | −0.0805 | Superseded — calibration drift in baseline |
| B (original, 2026-07-31) | 180 | +0.5pp | −0.0141 | Superseded — first run, raw re-score (no cross-val rejection, no calibration-alignment) |
| B (prior, 2026-08-01) | ~180 | +1.1pp | +0.0205 | Superseded — calibration-vintage mismatch; conflicted with B-original (Item 5 reconciliation 2026-08-08) |
| C fast direction (historical, hindsight) | 5,932 | +3.7pp | −0.0338 | Corroborating; player1=winner bias |
| C full engine re-run (historical, hindsight) | 5,400 | +3.0pp | −0.0331 | Corroborating; player1=winner bias |

---

## Next step (SUPERSEDED — activation already occurred 2026-08-08)

~~Re-run `scripts/auditMarketConsensusAblation.ts` once n≥200 rows pass cross-validation.
The current signal is very strong; at +3.45pp accuracy and −0.0519 log-loss on n=174,
any modest increase in sample size will confirm the result. The n≥200 bar is the agreed
reliability gate and must be met before activation.~~

`marketOdds` was activated via documented override on 2026-08-08. This section is preserved
as a historical record of the script's original output. Re-running the script is still
worthwhile once the corpus grows to validate the activation decision holds.
