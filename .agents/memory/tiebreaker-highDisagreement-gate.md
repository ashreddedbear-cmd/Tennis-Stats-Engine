---
name: Tie-break cascade HighDisagreement-only gate
description: The tie-break disclosure (tieBreakerApplied) is gated to HighDisagreement-only; firing for all agreement levels was harmful (−13.34pp overall on test segment).
---

# Tie-break cascade HighDisagreement-only gate

## The rule
`tieBreakerGated` in `index.ts` (after `modelAgreement` is finalized, ~line 806) sets
`applied = false` when `tieBreaker.applied && modelAgreement !== "HighDisagreement"`.
All downstream consumers use `tieBreakerGated` — recommendation, decisionTrace, engine output fields.

**Why:** auditTieBreakBaseline.ts found the tie-breaker fired on 28.2% of test-segment rows
and cost −13.34pp overall. Only HighDisagreement showed any benefit (+1.45pp, within noise).
Strong −11.30pp, Moderate −17.03pp, Mixed −20.11pp.

**How to apply:** Any change to the tie-breaker path must preserve the gate. The gate is placed
AFTER `modelAgreement` is finalized (after specialist and simulator adjustments) because
`applyTieBreaker` is called earlier in the function when only `featureAgreement` is available.
The probability is unchanged regardless (adjustedProbability === rawEnsembleProbability always).

## Fallback for gated predictions
- Strong/Moderate + margin < 3pp: `LOW_CONFIDENCE` (was `INSUFFICIENT_EDGE`)
- Mixed + margin < 8pp: `INSUFFICIENT_EDGE` via rule r2 (unchanged — independent of tie-breaker flag)

## Doc reference
`artifacts/api-server/docs/audit-task11-tiebreak-fix-before-after.md` §8 — full audit table,
fallback behavior, test descriptions.
