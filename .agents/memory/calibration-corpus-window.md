---
name: Calibration corpus window — full-corpus dilution
description: Pooled calibration fits must be restricted to last 24 months; full-corpus fits pass the global holdout gate but miscalibrate live predictions because old tennis distributions no longer reflect the current player pool.
---

## Rule

The final pooled calibration fit in `walkForward.ts` (training mode) must only include validation points from matches within the last `CALIBRATION_WINDOW_MONTHS` (24) months. The full corpus is still loaded for the scoring context (Elo, match history) — only the set of points passed to `fitBestCalibration` for the live-serving model is windowed.

**Why:** Model #712 (84,885 rows, year 2000–2026) produced holdout LL=0.6397 globally but LL=0.6599 on 184 live paper-trade rows — measurably worse than model #691 (21,570 rows, 2025-2026 only, LL=0.6361). Same dilution caused models #707 and #708 to be discarded in the 2026-08-07/08 incident. The global holdout gate (Gate 3: new LL ≤ active model LL) does NOT catch this because the holdout is drawn proportionally from the same diluted corpus — 70% old rows → 70% old holdout rows → the comparison sees no degradation. The miscalibration only surfaces on a live holdout drawn entirely from the current distribution.

**How to apply:**
- `CALIBRATION_WINDOW_MONTHS = 24` is an exported constant in `walkForward.ts` with a detailed comment.
- The window is applied by filtering `allValidationPoints` (now typed as `Array<CalibrationPoint & { matchDate: Date }>`) to `p.matchDate >= calibrationWindowStart` before calling `fitBestCalibration`.
- `scoreAndInsert` now returns `scheduledStartAt: Date` so validation points can carry their match date.
- Scoped runs (`matchIds` provided) bypass the window — their synthetic seed corpus is already bounded.
- Per-fold intermediate fits are not restricted — they only see their own fold's data anyway.

## B-CAL validation target

The fix cannot be verified until graded paper-trade rows accumulate post-2026-08-09 (orientation-fix date). Target: B-CAL cross-check delta < 0.010 on rows locked after that date. The pre-fix baseline was −0.0238 (model #712 vs stored #691 probs on 184 rows, but those rows predate the orientation fix and the delta is partially a measurement artifact — see `market-odds-ablation-results.md` §"B-CAL orientation-convention finding").
