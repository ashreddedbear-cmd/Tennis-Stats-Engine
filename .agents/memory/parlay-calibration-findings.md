---
name: Parlay Builder calibration findings
description: Results from historical backfill runs and factor weight ablation for the Parlay Builder scoring engine.
---

## Rule
Always use the model-predicted winner (calibrated_probability > 50 → player1, else player2) as the
`selectedPlayerId` in the parlay backfill — not always player1. Using player1 arbitrarily gives a
~49% win rate baseline (noise), masking the validation engine's signal.

**Why:** `calibrated_probability` in `evaluation_predictions` is stored as a 0–100 **percentage**
(not 0–1 decimal). The threshold is `> 50`, not `> 0.5`. Model directional accuracy is ~62% on
historical matches, not coin-flip.

**How to apply:** In the backfill endpoint (`POST /admin/parlay/backfill`) and in
`backfillParlayLegOutcomes.ts`, check `calibrated_probability > 50` to decide which player to
pass as `selectedPlayerId`.

---

## Calibration Results — 1,500-row backfill (July 2026, superseded)

| Metric | Value |
|---|---|
| Overall win rate (model picks) | 53.3% |
| KEEP win rate | 63.3% (n=30) |
| BORDERLINE win rate | 53.0% (n=1,469) |

**Factor findings at n=1,500 (SUPERSEDED — was small-sample noise):**
- Recent Form: −8.8pp edge ← WRONG (noise at n<100)
- Surface Record: −6.8pp edge ← WRONG (noise at n<100)

---

## Factor Weight Ablation — 3,031-row backfill (August 2026)

Run with `auditParlayFactorWeights.ts` (80/20 chronological split; 2,424 train / 607 held-out).

### Holdout Leakage: CLEAN (confirmed)
Split: `splitIdx = Math.floor(total * 0.8); train = legs.slice(0, splitIdx); heldOut = legs.slice(splitIdx)`
- Step 2 directional edge: `for (const leg of train)` ← only train
- Step 3 LOO: `const looLegs = train.filter(...)` ← only train
- Step 4 weight derivation: uses `factorStats` built from train only
- The 607 held-out rows were genuinely excluded from the LOO weight computation. No leakage.

### Key Per-Factor Edges at n=3,031

| Factor | Weight (old → new) | n_data | Edge |
|---|---|---|---|
| Overall Win Rate | 0.18 → 0.182 | 784 | +17.7pp |
| Hard Court Advantage | 0.10 → 0.101 | 946 | +13.2pp |
| Hard Surface Record | 0.08 → 0.081 | 990 | +13.0pp |
| Current Ranking | 0.04 → 0.041 | 841 | +10.5pp |
| Source Agreement | 0.06 → 0.061 | 2130 | +10.0pp |
| Strength of Schedule | 0.05 → 0.051 | 707 | +9.3pp |
| Historical Volatility | 0.02 → **0.003** | 492 | **−4.1pp → near-zero** |

**historicalVolatility is the ONLY confirmed harmful factor** at n=3,031.
**Prior "negative" findings for Recent Form and Surface Record were n<100 noise** — both show positive edge at n=3,031.

---

## 10,000-Row Confirmation (August 2026, n=9,366/9,978)

Re-run of `auditParlayFactorWeights.ts` after full 10k backfill completed.

### Stats at n=9,366 (script output)

| Metric | Value |
|---|---|
| Total resolved legs | 9,366 |
| Overall win rate | 60.1% |
| Held-out win rate | 56.0% (n=1,874) |
| Held-out KEEP accuracy (old weights) | 63.9% (n=158) |
| Held-out KEEP accuracy (new weights) | 62.3% (n=167) |

### Step 5b: Isolated Weight-Change Effect (n=9,978)

Both arms scored from stored `factor_scores`; only the weight set differs.

| Tier | Prior weights | Current weights | Δ |
|---|---|---|---|
| Overall | 59.9% (n=9,978) | 59.9% (n=9,978) | **+0.0pp** |
| KEEP | 67.4% (n=3,895) | 67.3% (n=4,025) | **-0.1pp** |
| BORDERLINE | 55.1% (n=5,806) | 54.9% (n=5,676) | -0.2pp |
| REMOVE | 56.3% (n=277) | 56.3% (n=277) | +0.0pp |

**Conclusion:** The reweighting contributed **+0.0pp** to overall win rate.
The full 53.3% → 59.9% jump (+6.6pp) is **entirely a data-quality improvement** from richer provider data in the new rows, not from the weight change.

### Factor Edges at n=9,366 vs n=3,031 — Key Changes

| Factor | Edge at n=3,031 | Edge at n=9,366 | Note |
|---|---|---|---|
| historicalVolatility | -4.1pp | **-0.7pp** | Converging toward flat |
| strengthOfSchedule | +9.3pp | +16.2pp | Strengthened |
| overallAdvantage | +17.7pp | +15.7pp | Stable |
| rankingTrend | +10.5pp | +14.7pp | Strengthened |

`historicalVolatility` edge narrowed from -4.1pp to -0.7pp (essentially flat at n=9,366). This means the n=3,031 finding (-4.1pp) was directionally correct but somewhat noisy; the near-zero weight (0.003) remains defensible.

### Decision: Do NOT Update DEFAULT_WEIGHTS

The n=9,366 proposed weights (Step 6) differ from current by < 0.005 on most factors.
The isolated comparison shows Δ=-0.1pp on KEEP tier with new vs current weights.
**Current DEFAULT_WEIGHTS (derived at n=3,031) are the correct production values.**

The `historicalVolatility` weight of 0.003 should not be raised back up to 0.007 — it was
justified by -4.1pp at n=3,031, and even at -0.7pp (flat) at n=9,366, keeping it near-zero
is conservative and correct (no evidence of positive contribution).

### New DEFAULT_WEIGHTS (Applied 2026-08-01, FINAL)

```typescript
const DEFAULT_WEIGHTS: Record<string, number> = {
  overallAdvantage:      0.182,  // +17.7pp edge (n=784)
  surfaceAdvantage:      0.101,  // +13.2pp edge (n=946)
  utr:                   0.100,  // unavailable — spec weight kept
  surfaceRecord:         0.081,  // +13.0pp edge (n=990)
  recentForm:            0.068,  // +5.8pp edge — reduced from 0.10 (was overweighted)
  serveAdvantage:        0.060,  // unavailable — spec weight kept
  returnAdvantage:       0.060,  // unavailable — spec weight kept
  sourceAgreement:       0.061,  // +10.0pp edge (n=2130)
  holdBreak:             0.050,  // unavailable — spec weight kept
  strengthOfSchedule:    0.051,  // +9.3pp edge (n=707)
  rankingTrend:          0.041,  // +10.5pp edge (n=841)
  marketConsensus:       0.034,  // 0 live rows in backfill — reduced by normalization
  headToHead:            0.020,  // +7.5pp edge (n=419) — high signal, low coverage
  travelFatigue:         0.020,  // 0 live rows — reduced by normalization
  injuryRisk:            0.020,  // 0 live rows — reduced by normalization
  historicalConsistency: 0.020,  // +8.0pp edge (n=632)
  tournamentExperience:  0.014,  // +6.9pp edge — reduced by normalization
  dataQuality:           0.014,  // non-directional — reduced by normalization
  historicalVolatility:  0.003,  // −4.1pp at n=3,031 → near-zero; −0.7pp at n=9,366 (flat)
  // TOTAL: 1.000
};
```

---

## Edge-Weighted Agreement (August 2026)

Changed `sourceAgreement` computation in `builderScoringService.ts` from raw headcount
(`agreeing / available`) to edge-weighted vote (`edgeWeightedAgreementRate`).

### What changed

Added `AGREEMENT_EDGE_WEIGHTS` constant (per-factor validated edges from n=9,366 ablation)
and `edgeWeightedAgreementRate()` helper. Both updated in main scoring path and
`__TEST_computeScoring`. Detail string now reads "N of M sources agree — X% edge-weighted
agreement" (raw count kept for transparency; percentage is edge-weighted).

Key weights: overallAdvantage=17.7, surfaceAdvantage=13.2, surfaceRecord=13.0,
rankingTrend=10.5, strengthOfSchedule=9.3 ... historicalVolatility=**0.0** (excluded).
Live-only unvalidated factors (marketConsensus, travelFatigue, injuryRisk) get 5.0 default.

### Impact on stored rows (n=11,499)

| Tier | Raw count | Edge-weighted | Δ |
|---|---|---|---|
| Overall | 59.8% (n=11,499) | 59.8% (n=11,499) | **+0.0pp** |
| KEEP | 66.8% (n=4,284) | 66.7% (n=4,345) | **−0.1pp** |
| BORDERLINE | 55.7% (n=6,851) | 55.7% (n=6,790) | +0.0pp |
| REMOVE | 55.8% (n=364) | 55.8% (n=364) | +0.0pp |

Tier shifts: 79 rows promoted BORDERLINE→KEEP, 0 demotions. 11,420 unchanged.

**Why minimal movement:** `historicalVolatility` scores ≈50 (neutral) in most rows and
lands in `supportsSelected=null` anyway — it was already excluded from the opinionated set
in those rows. The 79 promoted rows had it taking a side against the pick; those upgrades
have nearly identical win rate to the existing KEEP pool (−0.1pp).

All 31 `builderScoringService.test.ts` scoring invariants still pass.

### Why this is still the right change

Correctness: Agreement no longer lets a confirmed-dead-weight factor outvote a
high-signal one. Future live predictions with richer factor coverage (where more factors
land in `supportsSelected !== null`) will benefit more than the backfill rows did.

---

## Infrastructure Added

- `GET /api/admin/parlay/calibration` — calibration bucket report
- `POST /api/admin/parlay/backfill` — async trigger (background job)
- `src/scripts/auditParlayFactorWeights.ts` — leave-one-out ablation + Step 5b isolated comparison
  - Step 5b uses hardcoded `PRIOR_WEIGHTS` (from git commit c075d53) to isolate weight-change effect
- `src/scripts/analyzeParlayCalibration.ts` — validation score decile + tier calibration report
