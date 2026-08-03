# Parlay calibration findings

- Verified on 2026-08-03: the current prediction-engine tree does not contain a `historicalVolatility` factor in `MODULE_IMPORTANCE`, `ENSEMBLE_WEIGHT_PRIOR`, `EXCLUDED_FROM_ENSEMBLE`, or the walk-forward/evaluation code.
- The only volatility term in the active engine is the separate tournament-level upset-risk component (`upsetRisk.ts`), which is not part of the ensemble vote or calibration input.
- Because no `historicalVolatility` ensemble weight exists in the checked-in source, no source-level removal or walk-forward refit was performed in this workspace.
- If a historical config row in the database still contains a `historicalVolatility` key, that state is external to the repo and needs to be removed at the config/data layer before a fresh `evaluationOnly: false` walk-forward can measure any before/after delta.

## 2026-08-03 follow-up execution attempt

- Re-verified current retirement pattern: deprecated/underperforming ensemble factors are retired by exclusion in `EXCLUDED_FROM_ENSEMBLE` (for example `availability`, `fatigue`, and `matchLoadRecovery`), while module computation remains in place for transparency.
- Re-checked the full repo for `historicalVolatility` and found no active source references outside this note.
- Attempted to run full walk-forward refit in training mode (`evaluationOnly: false`) via:
	- `pnpm exec tsx scripts/runCompleteWalkForward.ts` (from `artifacts/api-server`)
	- Result: failed before scoring due DB host resolution (`getaddrinfo ENOTFOUND helium`).
- Attempted `pnpm --filter @workspace/api-server run test:evaluation` after installing deps.
	- Result: suite starts, but evaluation tests that touch DB also fail with the same `helium` host resolution error in this Codespaces environment.
- Re-ran both commands with explicit `DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable`.
	- Result: unchanged; both still fail with `getaddrinfo ENOTFOUND helium` because `helium` is not resolvable from this runtime.
- Net: no code changes were required for factor removal (already absent), and no fresh before/after walk-forward accuracy delta could be produced here because the required DB-backed evaluation path is unavailable in this runtime.
