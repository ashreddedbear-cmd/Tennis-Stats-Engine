---
name: Walk-forward append-only design
description: The walk-forward evaluation is now append-only — prior folds are never wiped on re-run. Documents the idempotency mechanism and test approach.
---

## Rule
Walk-forward (Task #109) must NEVER delete prior `historical_test` predictions or evaluation_runs rows. Each run is append-only: it scores only matches not yet covered, creating new fold IDs for new data.

**Why:** Wiping fold history on every re-run destroys the ability to compare model versions over time. The old blanket DELETE also wiped evaluation_runs for ALL runKinds (paper_trade, live), not just historical_test.

## How to apply
- `alreadyScoredIds` Set is built at the start of `runWalkForwardEvaluation` — any match with an existing `runKind='historical_test'` prediction is skipped.
- If all matches are already scored, `eligible.length < 20` trips and returns `{ skippedNoEligibleMatches: true }`.
- The fold-preservation regression guard test in `walkForward.test.ts` runs walk-forward twice on a shared synthetic dataset and asserts the second run does NOT delete the first run's fold IDs.

## Test approach
Do NOT run `walkForward.test.ts` casually — it takes 8–12+ min on the full corpus. The fold-preservation test uses synthetic data only (26 matches) so it's fast, but it still hits the DB.
