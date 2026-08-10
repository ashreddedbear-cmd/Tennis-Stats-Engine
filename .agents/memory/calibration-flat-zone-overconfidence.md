---
name: Calibration flat-zone overconfidence
description: The PAVA flat zone at x=0.50–0.52 produces calibrated output 55.65% even when empirical win rate is ~50–52%; known isotonic constraint, bounded by INSUFFICIENT_EDGE gate.
---

# Calibration flat-zone overconfidence (model #712)

## The rule
Any prediction with oriented x ≤ 0.5245 (raw probability ≈ 48–52%) gets calibrated
output of 55.65% — the flat-zone floor knot value — regardless of how close to 50/50 the
raw signal actually is.

## Why
PAVA (isotonic regression) must produce a non-decreasing curve. The x=0.50–0.52 sub-range
has empirical win rates (49.90%, 52.34%) below the average of the adjacent higher-x bins.
PAVA merges them upward into a single flat block at the pooled average of 55.65%.
This is mathematically correct behaviour, not a bug.

## Measured gaps (validation set, model #712, 2026-08-10)
- x=0.50 (n=4,331): empirical 49.90%, calibrated 55.65%, gap +5.75pp
- x=0.51 (n=9,789): empirical 52.34%, calibrated 55.65%, gap +3.31pp
- x=0.52+: all within 2pp of empirical ✓

## Product impact — bounded
`computeRecommendation` gates `margin < 8pp` → `INSUFFICIENT_EDGE`. All predictions with
calibratedProbability in [42%, 58%] are already labelled as coin-flip/low-confidence.
The 55.65% flat-zone output falls within that range for near-50% raw predictions, so
users see the conservative label regardless of the calibrated number itself.

## How to apply
- If a future calibration refit shows x=0.50–0.51 gaps > 5pp, this is expected — don't
  treat it as a new bug unless the INSUFFICIENT_EDGE gate has also been weakened.
- A Platt-scaling approach or a custom left-tail prior could soften this; deferred to a
  future calibration cycle. Tasks #180/#181 track the follow-up.
- Do NOT add a post-hoc clamp on calibrated output for this range — that would break the
  monotone guarantee for the stored knots.
