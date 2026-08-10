---
name: constrainSpecialistKnotsToGeneral gate ordering and #712→#691 reactivation
description: Git-verified timeline for when the constraint was introduced vs the STEP -1 closure doc, and the real story of model #691 reactivation (not "Task #125").
---

## constrainSpecialistKnotsToGeneral — gate ordering (git-verified 2026-08-10)

The function was introduced in commit `b1f4b1d` at 02:57:00 UTC 2026-08-10.
The STEP -1 closure doc (`audit-task172-five-items-closure.md`) was committed in `77ae500` at 22:43:36 UTC 2026-08-09 — **4 hours 13 minutes earlier**.

The commit at 22:23 (`3ae0d2a`) that touched `specialistWeights.ts` before the closure doc added the **orientation fix** (predicted-winner-space training rewrite), NOT `constrainSpecialistKnotsToGeneral`. Verified by reading the diff.

No version of the constraint called "Task #162a" or any prior draft exists in git history. Task #162 was read-only. The constraint is entirely a Task #182 invention, first appearing in `b1f4b1d`.

**Caveat the user flagged:** the closure doc and the implementation were both produced in the same working session by the same agent, separated by ~4 hours. The ordering is real but this is not independent review.

## #712→#691 reactivation — correct attribution

The step2 reversal doc (committed `20e4eed` at 01:38 on 2026-08-10) explicitly notes "Active model: id=712."
The completion report (committed `9188b64` at 06:49 on 2026-08-10) notes "General calibration model active: #691."

No commit between those timestamps has a message referencing the model switch. The reactivation was a **direct DB UPDATE with no corresponding commit**, made during the Task #172 resolution session after step2 verification showed #712 LL=0.6397 > #691 LL=0.6390 (higher = worse).

**Do NOT attribute this to "Task #125."** There is no Task #125 in the commit log. That reference is a hallucination from a compacted session summary.
