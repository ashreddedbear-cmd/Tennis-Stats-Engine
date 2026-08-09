# Task #172 — Five Open Items: Closure Report

> Written after Task #175 shipped (orientation fix, model #711 deactivated, swap-invariance test
> enforces ≤2pp asymmetry). These items were open pre-fix; this document confirms or corrects
> each claim with actual DB data.

---

## Item 1: Per-bin training counts and win rates behind model #711's flat region

**Verdict: "Zero training support" was wrong. The correct characterisation is "perverse training
signal from total Sackmann contamination."**

### Actual per-bin training data (player1-space, as model #711 was trained)

Source: `evaluation_predictions` WHERE `fold_id IN (243,244,245,246)` AND `segment='validation'`
AND `included_in_accuracy=true` AND `raw_probability IS NOT NULL` AND `actual_winner_id IS NOT NULL`

| raw_probability bin | n     | player1 win % |
|---------------------|-------|---------------|
| 15–20 %             | 5     | **100.0 %**   |
| 20–25 %             | 56    | **100.0 %**   |
| 25–30 %             | 312   | **97.1 %**    |
| 30–35 %             | 539   | **95.2 %**    |
| 35–40 %             | 1 022 | **89.9 %**    |
| 40–45 %             | 1 774 | **80.6 %**    |
| 45–50 %             | 2 365 | **81.0 %**    |
| 50–55 %             | 2 634 | 84.1 %        |
| 55–60 %             | 2 662 | 92.0 %        |
| 60–65 %             | 2 016 | 97.8 %        |
| 65–70 %             | 1 627 | 99.1 %        |
| 70–75 %             | 1 281 | 99.9 %        |
| 75–80 %             | 451   | 100.0 %       |
| 80–85 %             | 15    | 100.0 %       |
| 85–90 %             | 1     | 100.0 %       |

Total training rows: **16 760**. Rows in bins 15–50 %: **6 073** (not zero).

### Why the flat zone exists despite real training data

Per-fold player1 win rates for the validation segment:

| fold_id | date range      | n     | p1 wins | p1 win % |
|---------|-----------------|-------|---------|----------|
| 243     | 2007-04 – 2008-09 | 4 551 | 4 551   | **100 %** |
| 244     | 2010-04 – 2011-09 | 4 551 | 4 551   | **100 %** |
| 245     | 2013-04 – 2016-09 | 4 551 | 4 551   | **100 %** |
| 246     | 2017-08 – 2024-07 | 4 552 | 2 756   | 61.2 %   |

Folds 243–245 are sourced entirely from Sackmann historical data. In Sackmann's format the
match winner is stored as `player1` in **100 % of rows** — no exceptions. There is no noise,
no randomness: every single validation row in those three folds has `actual_winner_id =
player1_id`.

Fold 246 covers 2017–2024, a period that blends Sackmann data with other sources, producing a
more realistic 61.2 % player1 win rate.

### PAVA behaviour given this data

PAVA requires the calibration curve to be monotone increasing (higher raw probability → higher
predicted win probability). The training data shows the opposite across the low-probability range:

```
raw = 0.17  →  p1_win = 100 %   ↓ (should rise, not fall)
raw = 0.22  →  p1_win = 100 %
raw = 0.27  →  p1_win =  97.1 %
raw = 0.32  →  p1_win =  95.2 %
raw = 0.37  →  p1_win =  89.9 %
raw = 0.42  →  p1_win =  80.6 %
raw = 0.47  →  p1_win =  81.0 %  ← non-monotone kink
raw = 0.52  →  p1_win =  84.1 %  ← continues up
```

This is a strictly decreasing sequence from x=0.17 to x=0.42 (win rate DROPS as raw
probability rises), then jumps back up. PAVA merges all bins from x≈0.17 to x≈0.47 into one
flat block at their weighted average ≈ 84.48 %. The anchor at line 104 of `calibration.ts`
(`if (knots[0].x > 0) knots.unshift({ x: 0, y: knots[0].y })`) then extends that value back
to x=0, producing the observed flat zone x=0 → x=0.4506, y=0.8448.

**Revised characterisation:** The flat zone is not zero-support — it represents 6 073 real
training rows whose win rates are perversely shaped by Sackmann's winner-as-player1 convention.
PAVA cannot fit a monotone curve to a sequence that is strongly decreasing, so it pools the
entire region into a constant. The underlying cause is still the orientation bias; the specific
mechanism is PAVA forced pooling of a reverse-monotone empirical sequence, not missing data.

---

## Item 2: B-concordant cases — Rinderknech and Nakashima

**Verdict: Confirmed same root cause as Kostyuk/Swiatek. Both are flat-zone outputs.**

### Rinderknech vs Nakashima (2026-08-08, ATP250, Hard, live prediction id=8006)

Feature model votes (player1 = Rinderknech):

| model          | weight | player1 probability | favors     |
|----------------|--------|---------------------|------------|
| Surface Elo    | 0.362  | 35.3 %              | Nakashima  |
| Serve & Return | 0.219  | 44.5 %              | Nakashima  |
| Recent Form    | 0.317  | 45.7 %              | Nakashima  |
| Head-to-Head   | 0.005  | 50.0 %              | —          |
| Market Consensus | 0.097 | 34.5 %             | Nakashima  |

Raw ensemble (feature models only, weights sum to 1.000):

```
(0.362×35.3 + 0.219×44.5 + 0.317×45.7 + 0.005×50.0 + 0.097×34.5) / 1.000 = 40.61 %
```

All four substantive signals (Surface Elo, Serve & Return, Recent Form, Market) favour
Nakashima. Raw ensemble: 40.6 % for Rinderknech.

Calibration lookup — **both models in the flat zone:**

- General (id=711): x=0.406 < 0.4506 → flat zone → y=**84.5 %** for Rinderknech
- ATP-Hard specialist: x=0.406 < 0.4315 → flat zone → y=**85.9 %** for Rinderknech

Final blend: `0.702 × 85.9 + 0.298 × 84.5 = 85.5 %` for Rinderknech ✓ (matches stored
`calibrated_probability=85.5`).

**This is B-concordant:** both General and Specialist are simultaneously in their respective flat
zones for the same input. The specialist (weight 0.702) does not moderate the General's output
because it produces an identical flat-zone value. The raw ensemble of 40.6 % has no causal role
in the final output — both calibrations map it to ≈ 85 %.

### Nakashima's separate match (2026-08-07, Masters1000, Hard, live prediction id=7775)

Player1=Nakashima, stored `calibrated_probability=38.2`, `predicted_winner_probability=61.8`
(predicted winner = Droguet). This is a different, normal case — Nakashima as player1 with
raw probability below 50 % where the wrong-direction General output was partially corrected by
the specialist. Not a reference case for the audit.

---

## Item 3: Pegula/Shnaider tail case

**Verdict: Different mechanism from the flat zone. Confirmed as interpolation-zone overconfidence,
correct direction, wrong magnitude.**

### Pegula vs Shnaider (2026-08-08, ATP250, Hard, live prediction id=8010)

Feature model votes (player1 = Pegula):

| model          | weight | player1 probability | favors  |
|----------------|--------|---------------------|---------|
| Surface Elo    | 0.364  | 88.2 %              | Pegula  |
| Serve & Return | 0.218  | 57.2 %              | Pegula  |
| Recent Form    | 0.316  | 56.9 %              | Pegula  |
| Head-to-Head   | 0.005  | 50.0 %              | —       |
| Market Consensus | 0.097 | 70.4 %             | Pegula  |

Raw ensemble: `(0.364×88.2 + 0.218×57.2 + 0.316×56.9 + 0.005×50.0 + 0.097×70.4) / 1.000 = 69.63 %`

All signals favour Pegula. Raw ensemble: 69.6 % for Pegula.

General calibration lookup at x=0.6963:

```
knot[4]: x=0.6725, y=0.9931
knot[5]: x=0.7224, y=0.9990
interpolation: 0.9931 + (0.6963-0.6725)/(0.7224-0.6725) × (0.9990-0.9931) = 99.59 %
```

Stored General output: **99.6 %** ✓

WTA-Hard specialist output: **91.3 %** (from its own knots, x=0.6963 falls in a well-supported
region of the WTA-Hard specialist — its first real knot is x=0.2741, so this range has real
training support).

Final blend: `0.85 × 91.3 + 0.15 × 99.6 = 92.5 %` for Pegula ✓

### Why this is a different mechanism

The General calibration's knots at x=0.6725 (y=99.31%) and x=0.7224 (y=99.90%) sit in the
well-populated right-side bins (65–70 %: n=1,627 rows, win rate 99.1%; 70–75 %: n=1,281 rows,
win rate 99.9%). The high win rates in this region are partially real — when the raw model gives
a player 70 % probability AND Sackmann stores that player as player1, the player wins 99.9 % of
the time — but they are amplified by the Sackmann bias: the two effects compound.

**The prediction direction is correct** (Pegula was the favourite; Pegula won). The error is
overconfidence: 69.6 % raw should not calibrate to 99.6 %, even accounting for historical
win-rate patterns. The orientation fix addresses this: in predicted-winner space a raw confidence
of 69.6 % will map to a realistic win probability well below 99 %.

**Key distinction from items 1–2:** Flat-zone cases (Rinderknech, Kostyuk) produce wrong
directions — the underdog is predicted to win. Pegula/Shnaider is overconfidence in the correct
direction. The root cause is shared (Sackmann convention contaminating training data) but the
PAVA manifestation is different (interpolation between near-100% right-tail knots vs. forced
pooling of the reverse-monotone left tail).

---

## Item 4: -1f template literal bug — `.toFixed(0)` placement

**Verdict: No bug. The -1f fix is syntactically correct.**

The concern was that `.toFixed(0)` might have been placed outside the template interpolation,
producing literal text `.toFixed(0)` in the output string. Checking `index.ts` line 851
(the -1f fix location):

```typescript
.map((m) =>
  `${m.modelName} → ${m.player1Probability >= 50
    ? input.player1.name
    : input.player2.name} (${
    (m.player1Probability >= 50
      ? m.player1Probability
      : 100 - m.player1Probability
    ).toFixed(0)
  }%, weight ${m.weightUsed.toFixed(2)})`
)
```

The `.toFixed(0)` call is on the numeric result of the parenthesised ternary expression inside
`${}`. The template interpolation closes with `}%` after the `.toFixed(0)` call. This is correct
JavaScript. No literal `.toFixed(0)` appears in the output.

A global search for `${[^}]*}.toFixed` (`.toFixed` outside a template interpolation) across all
`.ts` and `.tsx` files in `artifacts/` returns no results.

**Before -1f:** the expression was `m.player1Probability.toFixed(0)` — always showed
Rinderknech's raw player1 probability regardless of who was the predicted winner, so a model
voting 35.3% for player1 displayed as "35%" even when Nakashima was the predicted winner.

**After -1f:** shows the favoured player's own probability (the ternary `m.player1Probability >=
50 ? m.player1Probability : 100 - m.player1Probability`), so a model voting 35.3% for player1
displays as "65%" for Nakashima, the actual predicted winner. Fix is correct.

---

## Item 5: -1d no-leakage check — code path with file/line citations

**Verdict: No leakage. Three independent isolation layers confirmed.**

The concern was that the walk-forward calibration training might inadvertently include test-segment
predictions, inflating in-sample metrics or producing an overfit model.

### Layer 1 — Fold-level train/test split (lines 288–339, `walkForward.ts`)

```typescript
// line 291
const half = Math.floor(chunk.length / 2);
const validationMatches = chunk.slice(0, half);   // first half of fold
const testMatches = chunk.slice(half);             // second half of fold

// line 302 — score ONLY validationMatches
const validationRows = await scoreAndInsert(validationMatches, "validation", null, ...);

// lines 316–339 — build CalibrationPoint[] from validationRows only
const foldEligible = validationRows.filter(
  (r) => r.includedInAccuracy && r.rawProbability !== null
);
const foldValidationPoints: CalibrationPoint[] = foldEligible
  .filter((r) => !isKnownBadCascadeRow(...))
  .map((r) => ({ rawProbability: ..., outcome: ... }));
mapping = fitBestCalibration(foldValidationPoints).knots;  // calibration fit here

// line 346 — testMatches scored AFTER calibration is fit
const testRows = await scoreAndInsert(testMatches, "test", null, ...);
```

`testMatches` are never passed to `fitBestCalibration`. They are scored using the just-fitted
`mapping` (line 345 applies it) to measure out-of-sample performance — they read the calibration
but never write to it.

### Layer 2 — Pooled live model fit (lines 340, 395–396, `walkForward.ts`)

```typescript
// line 340 — only validation points are pooled
allValidationPoints.push(...foldValidationPoints);

// line 396 — live model fit from pooled validation only
const liveFit = fitBestCalibration(allValidationPoints);
```

`allValidationPoints` is never appended to from `testRows`. The live model that goes into
`calibration_models` is trained exclusively on the union of validation-segment points from all
folds.

### Layer 3 — Segment tagging in DB (line 302 vs. line 346, `walkForward.ts`)

`scoreAndInsert` receives the segment string as its second argument (`"validation"` or `"test"`).
This tag is written to `evaluation_predictions.segment`. The calibration fitting code never
queries this column — it only receives `CalibrationPoint[]` arrays built inline from the returned
`validationRows` objects — so there is no secondary path by which test rows could contaminate
training.

### Conclusion

Calibration training data = `evaluation_predictions` WHERE `fold_id IN (243..246)` AND
`segment = 'validation'` AND `included_in_accuracy = true`. Test rows share the same fold IDs
but have `segment = 'test'` and are never fed to `fitBestCalibration`. No leakage.

---

## Gate status after Task #175

| item  | status                                                      |
|-------|-------------------------------------------------------------|
| -1a   | RESOLVED — no bug (prior)                                   |
| -1b   | **RESOLVED — Task #175: `applyCalibrationOriented`, swap test ≤2pp assertion, model #711 deactivated** |
| -1c   | CONFIRMED — root cause is Sackmann orientation bias, not zero support |
| -1d   | RESOLVED — no leakage (file/line citations above)           |
| -1e   | RESOLVED — intentional override design (prior)              |
| -1f   | RESOLVED — fix is correct, no template literal bug          |
| -1g   | RESOLVED — badge rename (prior)                             |
| Item 1 (bin data) | **CLOSED — 6,073 training rows in flat zone; perverse signal, not absent data** |
| Item 2 (B-concordant) | **CLOSED — Rinderknech/Nakashima confirmed same mechanism** |
| Item 3 (Pegula tail) | **CLOSED — different mechanism: interpolation zone overconfidence, correct direction** |
| Item 4 (-1f bug) | **CLOSED — no bug** |
| Item 5 (-1d write-up) | **CLOSED — three-layer isolation cited above** |

STEP 0 gate is now clear. Proceed to Step 0 (guardrail reconfirmation) then Step 1
(minimum-support floor / orientation-space blending) once the walk-forward refit completes.
