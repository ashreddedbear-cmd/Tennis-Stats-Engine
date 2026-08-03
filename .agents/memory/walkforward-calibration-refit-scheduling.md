# Walk-forward / calibration refit scheduling hardening (2026-08-03)

## Trigger audit

`runWalkForwardEvaluation` call sites:
- `src/services/evaluation/candidateOptimizer.ts`: **explicit `evaluationOnly:false`** (training/refit path).
- `scripts/runCompleteWalkForward.ts`: **explicit `evaluationOnly:false`**.
- `src/services/evaluation/walkForwardJob.ts`: receives route-provided options; default remained `true` in service but route now requires callers to send `evaluationOnly` explicitly (no silent defaulting).
- `src/jobs/runCalibrationRefitJob.ts`: now **explicit `evaluationOnly:false`** (previously relied on default).
- tests (`walkForward.test.ts`, `outcomelearning.test.ts`): test-only callers.

## Changes landed

1. Hard precondition against degenerate calibration activation:
- `src/services/evaluation/walkForward.ts`: refuses activation when `liveFit.holdoutSampleSize === 0`.
- `scripts/runCompleteWalkForward.ts`: same guard before replacing active model.

2. Silent no-op prevention for HTTP walk-forward trigger:
- `src/routes/evaluation.ts`: `POST /evaluation/walk-forward/run` now rejects requests that omit `evaluationOnly`.

3. Durable/manual refit trigger endpoint:
- Added `POST /evaluation/calibration-refit/run` in `src/routes/evaluation.ts`.
- Intended for person-triggered/manual use and Scheduled Deployment glue; guarded against concurrent in-process duplicate starts.

4. Restart-interruption guard for walk-forward:
- `src/services/evaluation/walkForwardJob.ts` now writes/updates `walk_forward_runs` markers.
- On start, if a stale `status='running'` row from before current process start is found, it checks `historical_test` row count.
- If row count is above threshold (`>25`), it refuses to start a new run until corpus is near-zero, preventing restart-mid-run overlap/ambiguity.

5. Monitoring/alerting visibility:
- `src/services/launchAudit.ts` now flags calibration refit as warning when:
  - no recent run exists,
  - latest run is stale (>30h),
  - latest run is skipped (`skippedNoEligibleMatches` / `foldsRun=0`),
  - latest run summary shows `evaluationOnly:true` (refit no-op).
- Added explicit degenerate-active-model alert if active `calibration_models.holdoutSampleSize === 0`.

## Scheduling model

- No in-process recurring timer exists for walk-forward/calibration refit.
- Durable cadence is expected via Replit Scheduled Deployment invoking `job:calibration-refit` (person-configured, process-uptime independent).