---
name: Walk-forward calibration-fit call-stack fix
description: Math.min/max spread on large arrays blows the JS call stack; fix + evaluationOnly default trap.
---

## Two bugs found during calibration refit (2026-07-24)

### Bug 1 — Math.min/max spread on large arrays
**Where:** `artifacts/api-server/src/services/evaluation/walkForward.ts` (calibration insert block)

**Problem:** `new Date(Math.min(...dates))` and `new Date(Math.max(...dates))` where `dates` is
`allMatches.map(m => m.scheduledStartAt.getTime())`. At 80k+ rows the spread pushes every
element onto the JS call stack as a function argument → `RangeError: Maximum call stack size exceeded`,
crashing the walk-forward right after it finishes scoring all folds.

**Fix:** Replaced both with `reduce`:
```js
const minDate = dates.reduce((a, b) => (b < a ? b : a), dates[0]!);
const maxDate = dates.reduce((a, b) => (b > a ? b : a), dates[0]!);
```

**Why:** JS engines limit the number of arguments passable via spread/apply. Typical limit is
~65k–130k; the corpus exceeded it. `reduce` is O(n) with constant stack depth.

### Bug 2 — `evaluationOnly` defaults to `true` in POST API
**Where:** `artifacts/api-server/src/services/evaluation/walkForwardJob.ts`, line ~36

```js
const evaluationOnly = opts.evaluationOnly ?? true;
```

Calling `POST /evaluation/walk-forward/run` with body `{}` silently runs evaluation-only mode —
it scores all matches but **does NOT update calibration_models or specialist_models**. The run
status shows `evaluationOnly: true` as a clear signal.

**Fix:** Always pass `{"evaluationOnly": false}` when the intent is to refit the live calibration.

## Result
After applying both fixes and running with `evaluationOnly: false`:
- 4-fold walk-forward on 79,196 matches completed in ~56 min
- Platt calibration selected (holdout log loss 0.6339 vs isotonic 0.6344)
- Calibration gap reduced from 10–20pt (systematic underconfidence) to ±2pt across all buckets
- New active model id = 83 (fitted 2026-07-24T23:55:52Z), 101 knots, n=31,140 validation pts

**How to apply:** Any future walk-forward refit via HTTP must use `{"evaluationOnly": false}`.
The standalone `pnpm run job:calibration-refit` bypasses this issue (calls `runWalkForwardEvaluation()` directly with no opts).
