---
name: Tie-break cascade underperformance
description: The tennis prediction engine's tie-break cascade (predictionEngine/tieBreakers.ts) was measured against real graded outcomes for the first time in Task #162's audit -- it makes predictions worse, not better, whenever it actually decides a pick.
---

## The rule

Never assume a tie-break/fallback heuristic that "picks a modest lean instead of an honest 50/50"
is safe just because it sounds conservative. Measure it against real graded outcomes before
trusting it.

**Why:** Querying `evaluation_predictions` by whether the tie-break cascade applied and which step
decided it showed: baseline (cascade not applied) 66.7% accuracy vs. 53.7% (Serve & Return-decided),
46.7% (Surface Elo-decided, worse than a coin flip), 42.9% (Recent Form-decided). 38% of all
validation predictions (1,509/3,987) go through this cascade. A named, confident-sounding "lean"
that underperforms a coin flip is worse for user trust than an honest 50/50, because it reads as
more reliable than it is.

**How to apply:** Any module that exists specifically to break ties/handle low-signal cases (not
just the main ensemble path) needs its own accuracy validation, separate from the main model's
overall accuracy numbers -- a good overall accuracy can hide a subset mechanism that's actively
harmful. See Task #163 for the tracked fix; the full breakdown and reproduction query are in
`artifacts/api-server/docs/audit-task162-full-prediction-accuracy-audit.md`, §2.

## 2026-08-03 implementation follow-up

- `predictionEngine/tieBreakers.ts` now keeps no-pick behavior (no directional nudge, `direction=0`, pass-through probability) while restoring diagnostic-only `decidingStep` reporting for core-module priority (`Serve & Return -> Surface Elo -> Recent Form`).
- The deciding step is now telemetry/explanation only and never determines the final winner.
- Added standalone-core-signal check (`>= TIE_BAND` points from 50) to the note text, so close-match disclosures explicitly state whether any core module had a decisive standalone signal.
- Updated regression tests in `predictionEngine/tieBreakers.test.ts` to assert:
	- no-pick behavior is preserved,
	- diagnostic `decidingStep` can be populated,
	- core priority ordering is preserved.

### Before/after accuracy split (best available evidence)

- Before (pre-fix corpus; Task #162):
	- Non-applied baseline: 66.7% (n=2,478)
	- Applied, Serve & Return decided: 53.7% (n=1,374)
	- Applied, Surface Elo decided: 46.7% (n=120)
	- Applied, Recent Form decided: 42.9% (n=7)
- After forced-pick removal (Task #11 post-fix walk-forward audit):
	- Tie-break applied, disclosure-only (no forced pick): 56.0% (n=2,803)
	- Overall: 64.6% (n=7,844)

### Runtime rerun status (this environment)

- Attempted fresh `evaluationOnly:false` walk-forward and `test:evaluation` reruns with
	`DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable`.
- Both still fail in Codespaces with `getaddrinfo ENOTFOUND helium` (host only resolvable in Replit runtime), so a new same-day corpus-level before/after measurement could not be produced here.
