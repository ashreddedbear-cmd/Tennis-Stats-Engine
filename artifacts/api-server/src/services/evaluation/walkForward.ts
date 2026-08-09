import { db, evaluationPredictionsTable, evaluationRunsTable, calibrationModelsTable, historicalMatchesTable } from "@workspace/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { fitBestCalibration, applyCalibration, applyCalibrationOriented, isKnownBadCascadeRow, type CalibrationPoint } from "./calibration";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { getPredictionSettings } from "./settle";
import { computeAndStoreSpecialistSegments, getActiveSpecialistSegments } from "./specialistWeights";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { defaultPredictionMode, derivePredictionStrategyIdentity } from "./strategyIdentity";
import { eloFallbackTracker, fallbackRateWarning } from "../predictionEngine/fallbackTracking";
import { HISTORICAL_MODEL_VERSION, type ResultType, type RetirementRule } from "./types";
import type { CalibrationKnot } from "./types";

export interface WalkForwardOptions {
  /** Number of expanding-window folds to run over the back portion of the timeline. */
  foldCount?: number;
  /** Fraction of the earliest history reserved as train-only warmup, never scored. */
  warmupFraction?: number;
  /** Optional optimizer run identifier when this walk-forward is executed as part of optimizer training. */
  optimizerRunId?: string | null;
  /**
   * Task #12: when true, run all folds and compute metrics using the currently-active
   * (frozen) calibration without touching calibration_models, specialist_models, or any
   * threshold value. The "Run Walk-Forward" button on the Accuracy Dashboard always uses
   * evaluationOnly=true. The separate "Run Optimizer" action uses evaluationOnly=false.
   *
   * Defaults to false for backward compatibility, but the dashboard wires it as true.
   */
  evaluationOnly?: boolean;
  /**
   * When provided, restricts the walk-forward to only these historical match IDs. The scoring
   * context (Elo index, match history) is built only from these rows too, which makes the
   * run fast. Intended for integration tests that seed a small synthetic corpus — never use
   * this in production (omit the field entirely, or pass undefined).
   */
  matchIds?: number[];
  /**
   * Task #127: optional inclusive lower bound on scheduled_start_at (YYYY-MM-DD or ISO-8601).
   * When provided together with endDate, only historical matches whose scheduled_start_at falls
   * within [startDate, endDate] are eligible for scoring. Matches outside the window are still
   * loaded into the scoring context (Elo index, match history) so predictions remain
   * point-in-time accurate — only scoring eligibility is restricted.
   * Omit to score the full corpus (existing default behaviour).
   */
  startDate?: string;
  /**
   * Task #127: optional inclusive upper bound on scheduled_start_at (YYYY-MM-DD or ISO-8601).
   * Must be paired with startDate. See startDate for full semantics.
   */
  endDate?: string;
}

export interface WalkForwardSummary {
  foldsRun: number;
  foldIds: number[];
  skippedNoEligibleMatches: boolean;
  /** Share (0-1) of opponent Elo lookups across this run that hit #76's last-resort fallback baseline (Task #77). 0 when nothing was scored. */
  fallbackRate: number;
  /** Data-quality warnings for this run -- e.g. the fallback-rate threshold warning (Task #77) -- surfaced the same way per-prediction module warnings are, never a new UI surface. */
  warnings: string[];
  /** Task #12: true when this run was evaluation-only (frozen calibration/specialist weights), false when it was a full optimizer/training run. */
  evaluationOnly: boolean;
}

function classifyResult(match: { winnerId: string | null; retired: boolean; walkover: boolean; cancelled: boolean }): ResultType {
  if (match.cancelled) return "cancelled";
  if (match.walkover) return "walkover";
  if (match.retired) return "retired";
  return "normal";
}

/**
 * Minimum eligible historical matches required before a training-mode walk-forward may
 * replace an already-deployed active calibration model. Exported so callers (tests and the
 * calibration-refit job) can reference the same constant.
 */
export const MIN_ELIGIBLE_FOR_TRAINING = 500;

/**
 * Minimum holdout sample size a newly-fitted calibration model must have before it is
 * allowed to replace the currently active model. A model with holdoutSampleSize > 0 but
 * below this floor was trained on a very small eligible set (e.g. because the historical
 * corpus was almost entirely already scored from a prior run) and its holdout log-loss
 * estimate is not reliable enough to stake the live calibration on.
 *
 * Distinct from the degenerate guard (holdoutSampleSize > 0) which catches the complete
 * collapse case; this floor catches the "technically non-zero but too small to trust" case.
 * Value chosen so a model needs at least 500 genuinely held-out rows — the same floor used
 * for training eligibility — before it can displace an existing active model.
 */
export const MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE = 500;

/** Return type for `checkTrainingModeGuard`. */
export type TrainingModeGuardResult =
  | { skip: false; reason: "evaluationOnly" | "scoped" | "aboveFloor" | "bootstrap" }
  | { skip: true;  reason: "activeModelExists" };

/**
 * Returns whether a training-mode walk-forward should be skipped for this particular call
 * without executing the full fold pipeline. Extracted so the guard can be tested directly
 * (behavioral test) and so the job pre-flight can use the same logic without duplicating it.
 *
 * Skip fires only when ALL of the following hold:
 *   1. evaluationOnly is false (training mode — calibration write is intended)
 *   2. scopedMatchIds is null (unscoped / real production run, not a test/dev invocation)
 *   3. eligibleCount < MIN_ELIGIBLE_FOR_TRAINING (too sparse to produce a meaningful fit)
 *   4. An active calibration model exists in the DB (bootstrap exception: no active model →
 *      always proceed so a fresh environment can produce its first real model)
 *
 * When skip is true, the caller must return `{ foldsRun: 0, skippedNoEligibleMatches: true }`
 * without writing to calibration_models.
 */
export async function checkTrainingModeGuard({
  evaluationOnly,
  scopedMatchIds,
  eligibleCount,
}: {
  evaluationOnly: boolean;
  scopedMatchIds: readonly number[] | null;
  eligibleCount: number;
}): Promise<TrainingModeGuardResult> {
  if (evaluationOnly)             return { skip: false, reason: "evaluationOnly" };
  if (scopedMatchIds !== null)    return { skip: false, reason: "scoped" };
  if (eligibleCount >= MIN_ELIGIBLE_FOR_TRAINING) return { skip: false, reason: "aboveFloor" };

  const [activeModel] = await db
    .select({ id: calibrationModelsTable.id })
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);

  if (activeModel) return { skip: true, reason: "activeModelExists" };
  return { skip: false, reason: "bootstrap" };
}

/**
 * Runs a fresh sequence of expanding-window walk-forward folds over the entire leak-proof
 * historical store and persists per-fold results. Each run supersedes prior evaluation_runs /
 * evaluation_predictions rows of runKind='historical_test' (deleted up front) so re-running
 * after a model change never mixes stale and fresh fold results together.
 *
 * Task #12: when `options.evaluationOnly=true`, folds are scored against the currently-active
 * (frozen) calibration mapping without touching calibration_models, specialist_models, or any
 * threshold value. The dashboard "Run Walk-Forward" button always uses evaluation-only mode.
 * The separate "Run Optimizer" endpoint uses the full training mode (evaluationOnly=false).
 */
export async function runWalkForwardEvaluation(options: WalkForwardOptions = {}): Promise<WalkForwardSummary> {
  const foldCount = options.foldCount ?? 4;
  const warmupFraction = options.warmupFraction ?? 0.4;
  const evaluationOnly = options.evaluationOnly ?? false;
  const optimizerRunId = options.optimizerRunId ?? null;
  const scopedMatchIds = options.matchIds && options.matchIds.length > 0 ? options.matchIds : null;
  // Task #127: optional date-range filter. Both must be provided together or neither.
  const startDate = options.startDate ? new Date(options.startDate) : null;
  const endDate = options.endDate ? new Date(options.endDate + "T23:59:59.999Z") : null;
  if ((startDate !== null) !== (endDate !== null)) throw new Error("startDate and endDate must both be provided or both omitted");
  if (startDate !== null && endDate !== null && startDate > endDate) throw new Error("startDate must be <= endDate");
  if (foldCount < 1) throw new Error("foldCount must be >= 1");
  if (warmupFraction <= 0 || warmupFraction >= 1) throw new Error("warmupFraction must be between 0 and 1 (exclusive)");

  // Task #12: in evaluation-only mode, load the currently-active calibration once up front.
  // This mapping is used for ALL folds (instead of per-fold refitting). Never touched/updated.
  let frozenCalibrationMapping: CalibrationKnot[] | null = null;
  if (evaluationOnly) {
    const [activeCalibration] = await db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1);
    frozenCalibrationMapping = activeCalibration ? (activeCalibration.mapping as CalibrationKnot[]) : null;
    logger.info({ hasFrozenMapping: frozenCalibrationMapping !== null, knots: frozenCalibrationMapping?.length ?? 0 }, "Task #12: evaluation-only walk-forward — calibration is frozen, no writes to calibration_models or specialist_models");
  }

  const settings = await getPredictionSettings();

  const allMatches = await db
    .select()
    .from(historicalMatchesTable)
    .where(scopedMatchIds ? inArray(historicalMatchesTable.id, scopedMatchIds) : undefined)
    .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

  // Task #109: append-only fold preservation — never wipe prior walk-forward results.
  // Build the set of historical match IDs already scored in a prior run so this run skips
  // them (idempotent). Prior evaluation_runs / evaluation_predictions rows are NEVER deleted;
  // each run only adds new folds for matches not yet covered.
  const alreadyScoredIds = new Set<number>(
    (await db
      .select({ historicalMatchId: evaluationPredictionsTable.historicalMatchId })
      .from(evaluationPredictionsTable)
      .where(and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        isNotNull(evaluationPredictionsTable.historicalMatchId),
      ))
    ).map(r => r.historicalMatchId as number)
  );

  const eligible = allMatches.filter(
    // cancelled matches never reach scoring; already-scored matches are preserved across runs.
    // Task #127: when startDate/endDate are provided, further restrict to matches whose
    // scheduled_start_at falls within [startDate, endDate]. allMatches is intentionally kept as
    // the full corpus above so the Elo/history context is still built from all available data
    // (point-in-time accuracy for the scored subset requires the full historical backdrop).
    (m) =>
      !m.cancelled &&
      !alreadyScoredIds.has(m.id) &&
      (startDate === null || m.scheduledStartAt >= startDate) &&
      (endDate === null || m.scheduledStartAt <= endDate),
  );
  if (eligible.length < 20) {
    logger.warn({ count: eligible.length, alreadyScored: alreadyScoredIds.size }, "Not enough new historical matches to run a meaningful walk-forward evaluation");
    return { foldsRun: 0, foldIds: [], skippedNoEligibleMatches: true, fallbackRate: 0, warnings: [], evaluationOnly };
  }

  // Training-mode guard: when a real active calibration model already exists, require
  // ≥500 new eligible historical matches before replacing it. The holdoutSampleSize
  // quality gate below catches a degenerate fit after the fact, but the run still fires,
  // scores all folds, and writes a noise row to calibration_models (stored inactive).
  // This guard prevents that wasted work.
  //
  // Two intentional exceptions — both skip the guard:
  //
  // 1. Bootstrap (no active calibration model yet): always run so a fresh environment
  //    can produce its first real model. The holdoutSampleSize quality gate is the
  //    safety net for sparse bootstrap data.
  //
  // 2. Scoped runs (scopedMatchIds !== null): these are test/development invocations
  //    that explicitly bound the corpus to a small seed set. They are never real
  //    production calibration replacements and must not be blocked by a production floor.
  //
  // Why 500: with foldCount=4 and warmupFraction=0.4, eligible=500 yields ≈120 pooled
  // validation points before accuracy filtering — comfortably above the 101-point
  // minimum splitForCalibrationHoldout needs to produce a non-empty holdout slice.
  //
  // Evaluation-only runs use the frozen calibration without writing anything; they can
  // still run with as few as 20 eligible matches (the base floor above).
  const trainingGuard = await checkTrainingModeGuard({ evaluationOnly, scopedMatchIds, eligibleCount: eligible.length });
  if (trainingGuard.skip) {
    logger.warn(
      { eligible: eligible.length, min: MIN_ELIGIBLE_FOR_TRAINING, alreadyScored: alreadyScoredIds.size },
      "Training-mode walk-forward skipped: not enough new eligible historical matches to replace the active calibration model; existing model kept unchanged",
    );
    return { foldsRun: 0, foldIds: [], skippedNoEligibleMatches: true, fallbackRate: 0, warnings: [], evaluationOnly };
  }
  if (trainingGuard.reason === "bootstrap") {
    logger.info(
      { eligible: eligible.length, min: MIN_ELIGIBLE_FOR_TRAINING },
      "Training-mode walk-forward: no active calibration model yet — running bootstrap fit (holdoutSampleSize quality gate is the safety net for sparse data)",
    );
  }

  // Task #77: run-scoped fallback tracker, reset here so this run's rate never mixes with a
  // prior run's (e.g. a live prediction request scored moments before).
  eloFallbackTracker.reset();

  // Preload the whole corpus ONCE for this run -- a run scores thousands of matches, each
  // needing two players' full prior histories, their H2H, and opponent-Elo lookups. Re-querying
  // the DB per match would turn a run that should take seconds into one that takes hours; see
  // `HistoricalScoringContext`. The identity index is built once here too (Task #77) and reused
  // both for `eloHistory`'s own canonicalized grouping and for every match's opponent-resolution
  // lookup below, so a fragmented player's Elo trajectory is merged and resolved consistently.
  const identityIndex = await buildPlayerIdentityIndex();
  // Task #65: snapshot the PREVIOUS cycle's specialist fit before this run's own fold scoring --
  // `computeAndStoreSpecialistSegments` below (which fits fresh specialists FROM this run's own
  // validation output) only overwrites `specialist_models` at the very end of this function, so
  // this read is guaranteed to see last cycle's rows, never this cycle's own. That's what makes
  // applying it in `scoreHistoricalMatch` non-circular.
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
  const scoringContext: HistoricalScoringContext = {
    matchHistory: buildMatchHistoryIndex(allMatches),
    eloHistory: await buildEloHistoryIndex(identityIndex),
    identityIndex,
    specialistRowsBySegmentKey,
  };

  const warmupEndIdx = Math.floor(eligible.length * warmupFraction);
  const scorable = eligible.slice(warmupEndIdx);
  if (scorable.length < foldCount * 6) {
    logger.warn({ scorable: scorable.length, foldCount }, "Not enough post-warmup matches for the requested fold count");
    return { foldsRun: 0, foldIds: [], skippedNoEligibleMatches: true, fallbackRate: 0, warnings: [], evaluationOnly };
  }

  const chunkSize = Math.floor(scorable.length / foldCount);
  const foldIds: number[] = [];
  const allValidationPoints: CalibrationPoint[] = [];

  for (let fold = 0; fold < foldCount; fold++) {
    const chunkStart = fold * chunkSize;
    const chunkEnd = fold === foldCount - 1 ? scorable.length : chunkStart + chunkSize;
    const chunk = scorable.slice(chunkStart, chunkEnd);
    if (chunk.length < 4) continue;

    const half = Math.floor(chunk.length / 2);
    const validationMatches = chunk.slice(0, half);
    const testMatches = chunk.slice(half);

    const trainEnd = validationMatches[0].scheduledStartAt;
    const validationStart = validationMatches[0].scheduledStartAt;
    const validationEnd = validationMatches[validationMatches.length - 1].scheduledStartAt;
    const testStart = testMatches[0]?.scheduledStartAt ?? validationEnd;
    const testEnd = testMatches[testMatches.length - 1]?.scheduledStartAt ?? validationEnd;
    const trainStart = allMatches[0].scheduledStartAt;

    const validationRows = await scoreAndInsert(validationMatches, "validation", null, settings.retirementRule as RetirementRule);

    let mapping: CalibrationKnot[];
    if (evaluationOnly) {
      // Task #12: evaluation-only mode -- use the frozen calibration (never refit).
      // When no active calibration exists yet (fresh env), fall back to the identity curve so
      // the run still completes with honest "uncalibrated" metrics rather than crashing.
      mapping = frozenCalibrationMapping ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    } else {
      // Training mode: fit calibration ONLY on this fold's validation-segment, accuracy-eligible
      // points. Never touches test data.
      // Exclude known-bad pre-cascade rows: predictions locked before 2026-07-15 with
      // tieBreakerApplied=true were scored by the old directional cascade (removed Task #5)
      // which achieved only ~30.8% accuracy on close matchups vs a 76.9% baseline.
      const foldEligible = validationRows.filter((r) => r.includedInAccuracy && r.rawProbability !== null);
      const foldCascadeBad = foldEligible.filter((r) => isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied));
      if (foldCascadeBad.length > 0) {
        logger.warn(
          { fold, excludedCascadeRows: foldCascadeBad.length, kept: foldEligible.length - foldCascadeBad.length },
          "Excluded known-bad pre-cascade rows from fold calibration training data",
        );
      }
      const foldValidationPoints: CalibrationPoint[] = foldEligible
        .filter((r) => !isKnownBadCascadeRow(r.lockedAt, r.tieBreakerApplied))
        .map((r) => {
          // Orientation fix (2026-08-09): train in predicted-winner space, not player1 space.
          // Sackmann stores the winner as player1 in ~90% of rows, so player1-space training
          // learned "player1 wins ~85% of the time regardless of raw signals" — not a tennis fact.
          // x = max(raw, 1-raw): model's confidence in its own pick, always in [0.5, 1.0].
          // outcome = 1 if the predicted winner actually won.
          const raw = r.rawProbability as number; // 0-1 in-memory scale
          const predictedPlayer1 = raw >= 0.5;
          return {
            rawProbability: predictedPlayer1 ? raw : 1 - raw,
            outcome: (predictedPlayer1 === r.player1Won ? 1 : 0) as 0 | 1,
          };
        });
      mapping = fitBestCalibration(foldValidationPoints).knots;
      allValidationPoints.push(...foldValidationPoints);
    }

    // Apply calibration to validation rows (in-sample for training mode, against-frozen for eval)
    // and to test rows (always out-of-sample).
    await recalibrateRows(validationRows.map((r) => r.id), mapping);
    const testRows = await scoreAndInsert(testMatches, "test", null, settings.retirementRule as RetirementRule);
    await recalibrateRows(testRows.map((r) => r.id), mapping);

    const [insertedFold] = await db
      .insert(evaluationRunsTable)
      .values({
        foldIndex: fold,
        modelVersion: HISTORICAL_MODEL_VERSION,
        trainStart,
        trainEnd,
        validationStart,
        validationEnd,
        testStart,
        testEnd,
        calibrationMapping: mapping,
        validationMetrics: await summarizeSegment("historical_test", "validation", null),
        testMetrics: {},
      })
      .returning({ id: evaluationRunsTable.id });

    // Backfill foldId + fold-scoped metrics now that we have the fold's id.
    await db
      .update(evaluationPredictionsTable)
      .set({ foldId: insertedFold.id })
      .where(inArray(evaluationPredictionsTable.id, [...validationRows.map((r) => r.id), ...testRows.map((r) => r.id)]));

    await db
      .update(evaluationRunsTable)
      .set({
        validationMetrics: await summarizeSegment("historical_test", "validation", insertedFold.id),
        testMetrics: await summarizeSegment("historical_test", "test", insertedFold.id),
      })
      .where(eq(evaluationRunsTable.id, insertedFold.id));

    foldIds.push(insertedFold.id);
  }

  if (evaluationOnly) {
    // Task #12: evaluation-only -- calibration_models and specialist_models are frozen.
    // No writes to either table. The run's purpose is purely to produce fresh metrics against
    // the current deployed calibration without touching it.
    logger.info({ foldsRun: foldIds.length }, "Task #12: evaluation-only walk-forward complete — skipped calibration refit and specialist recompute");
  } else {
    // Training mode: refit the single "live" calibration model from every fold's pooled
    // validation data -- this is what future paper-trade/live predictions will be calibrated with.
    // allValidationPoints was already filtered per-fold to exclude known-bad cascade rows.
    logger.info(
      { pooledValidationPoints: allValidationPoints.length },
      "Fitting pooled calibration model (cascade-bad rows already excluded per fold)",
    );
    const liveFit = fitBestCalibration(allValidationPoints);
    const liveMapping = liveFit.knots;
    const dates = allMatches.map((m) => m.scheduledStartAt.getTime());
    // Use reduce instead of spread (Math.min(...dates)) to avoid "Maximum call stack size
    // exceeded" when allMatches is large (50k+ rows -- spread pushes every element onto the
    // call stack as a function argument, which blows the stack limit at scale).
    const minDate = dates.length ? dates.reduce((a, b) => (b < a ? b : a), dates[0]!) : null;
    const maxDate = dates.length ? dates.reduce((a, b) => (b > a ? b : a), dates[0]!) : null;

    // ── Minimum-quality gate (three independent checks) ─────────────────────
    //
    // Gate 1 — degenerate guard (unchanged): holdoutSampleSize === 0 means the
    // validation set was too small for fitBestCalibration to hold out a real
    // comparison slice (requires ≥100 points). Isotonic regression on a handful
    // of rows collapses to a constant-1 mapping that sends every prediction to
    // ~100%. This is the "complete collapse" case.
    //
    // Gate 2 — holdout floor: even with holdoutSampleSize > 0, a model trained
    // on a tiny eligible set (e.g. the corpus was almost entirely already-scored
    // from a prior run) produces a log-loss estimate with very wide confidence
    // intervals. Require at least MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE held-out
    // rows before trusting the estimate enough to displace the active model.
    //
    // Gate 3 — log-loss comparison: a new model must be at least as good as the
    // currently active one on the holdout. If the active model already has a
    // lower (better) log-loss, the new fit was likely trained on an unrepresentative
    // or too-sparse slice and should not displace it. Bootstrap exception: when
    // no active model exists, or the active model has no stored LL (legacy row),
    // always allow activation so a fresh environment can produce its first model.

    const [currentActiveModel] = await db
      .select({ id: calibrationModelsTable.id, isotonicHoldoutLogLoss: calibrationModelsTable.isotonicHoldoutLogLoss })
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1);

    const gate1_nonDegenerate = liveFit.holdoutSampleSize > 0;
    const gate2_aboveFloor    = liveFit.holdoutSampleSize >= MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE;
    // Gate 3: allow when no active model, active model has no LL stored (legacy), or new fit is ≤ current LL.
    // If the new fit's LL is somehow null despite passing gate 1 (should not happen per fitBestCalibration),
    // be conservative and block activation.
    const activeLL  = currentActiveModel?.isotonicHoldoutLogLoss ?? null;
    const newLL     = liveFit.isotonicHoldoutLogLoss;
    const gate3_notWorseThanCurrent =
      currentActiveModel === undefined   // bootstrap: no active model yet
      || activeLL === null               // legacy active model with no LL stored — can't compare, allow
      || (newLL !== null && newLL <= activeLL);

    const fitsPassesQualityGate = gate1_nonDegenerate && gate2_aboveFloor && gate3_notWorseThanCurrent;

    if (fitsPassesQualityGate) {
      await db.update(calibrationModelsTable).set({ active: false }).where(eq(calibrationModelsTable.active, true));
    } else {
      const rejectionReason = !gate1_nonDegenerate
        ? `holdoutSampleSize === 0 (degenerate fit — too few validation points)`
        : !gate2_aboveFloor
          ? `holdoutSampleSize ${liveFit.holdoutSampleSize} < floor ${MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE} (eligible set too sparse)`
          : `new holdout log-loss ${newLL?.toFixed(4) ?? "null"} > active model ${activeLL?.toFixed(4) ?? "null"} (new fit is worse)`;
      logger.warn(
        {
          fitSampleSize: liveFit.fitSampleSize,
          holdoutSampleSize: liveFit.holdoutSampleSize,
          newIsotonicHoldoutLogLoss: newLL,
          activeModelId: currentActiveModel?.id ?? null,
          activeIsotonicHoldoutLogLoss: activeLL,
          pooledValidationPoints: allValidationPoints.length,
          gate1_nonDegenerate,
          gate2_aboveFloor,
          gate3_notWorseThanCurrent,
        },
        `Calibration refit: new model stored inactive — ${rejectionReason}; previous active model kept`,
      );
    }
    await db.insert(calibrationModelsTable).values({
      method: liveFit.method,
      mapping: liveMapping,
      validationSampleSize: allValidationPoints.length,
      validationDateRangeStart: minDate !== null ? new Date(minDate) : null,
      validationDateRangeEnd: maxDate !== null ? new Date(maxDate) : null,
      active: fitsPassesQualityGate,
      isotonicHoldoutLogLoss: liveFit.isotonicHoldoutLogLoss,
      plattHoldoutLogLoss: liveFit.plattHoldoutLogLoss,
      holdoutSampleSize: liveFit.holdoutSampleSize,
    });

    // Phase 6: recompute every tour/surface specialist segment from the fold's freshly-written
    // validation-reference data, comparing each against this SAME newly-fit general/pooled mapping.
    // Only run when the fit passes the quality gate — specialist models calibrated against a
    // degenerate mapping would produce equally broken per-segment overrides.
    if (fitsPassesQualityGate) {
      await computeAndStoreSpecialistSegments(liveMapping);
    } else {
      logger.warn({ fitSampleSize: liveFit.fitSampleSize }, "Calibration refit: skipping specialist segment recompute because quality gate failed");
    }
  }

  // Task #12: run pattern analysis automatically after every walk-forward (both modes).
  // Import lazily to avoid a circular dep and keep this file focused on fold mechanics.
  try {
    const { runPatternAnalysis } = await import("./patternAnalysis");
    await runPatternAnalysis();
  } catch (err) {
    // Pattern analysis failure is non-fatal -- the walk-forward result is still valid.
    logger.warn({ err }, "Task #12: post-walk-forward pattern analysis failed (non-fatal)");
  }

  // Task #77: surface a data-quality warning through this run's own existing summary output
  // (the same "warnings" shape every per-prediction module already uses) whenever more than 1%
  // of this run's opponent Elo lookups needed the last-resort fallback -- the run still completes
  // either way, it's never silently swallowed nor a reason to halt.
  const fallbackStats = eloFallbackTracker.getStats();
  const fallbackWarning = fallbackRateWarning(fallbackStats);
  const warnings = fallbackWarning ? [fallbackWarning] : [];
  if (fallbackWarning) {
    logger.warn({ fallbackRate: fallbackStats.fallbackRate, fallbackCount: fallbackStats.fallbackCount, totalAttempts: fallbackStats.totalAttempts }, fallbackWarning);
  }

  return { foldsRun: foldIds.length, foldIds, skippedNoEligibleMatches: false, fallbackRate: fallbackStats.fallbackRate, warnings, evaluationOnly };

  // --- helpers (closures over allMatches context) ---

  async function scoreAndInsert(
    matches: (typeof allMatches)[number][],
    segment: "validation" | "test",
    foldId: number | null,
    retirementRule: RetirementRule,
  ): Promise<Array<{ id: number; rawProbability: number | null; player1Won: boolean; includedInAccuracy: boolean; tieBreakerApplied: boolean; lockedAt: Date }>> {
    const results: Array<{ id: number; rawProbability: number | null; player1Won: boolean; includedInAccuracy: boolean; tieBreakerApplied: boolean; lockedAt: Date }> = [];


    for (const match of matches) {
      const resultType = classifyResult(match);
      const isVoid = resultType === "walkover" || resultType === "cancelled";
      const player1Won = match.winnerId === match.player1Id;

      const scored = await scoreHistoricalMatch(match, scoringContext);
      const rawProbability = scored?.rawProbability ?? null;
      const predictedWinnerId = rawProbability !== null ? (rawProbability >= 0.5 ? match.player1Id : match.player2Id) : null;
      const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included") && rawProbability !== null;
      // Capture tieBreakerApplied from the engine breakdown so calibration training can exclude
      // rows that were scored by the old directional cascade (see isKnownBadCascadeRow).
      const tieBreakerApplied = scored?.snapshot.engine.tieBreakerApplied ?? false;
      const lockedAt = new Date();
      const player1Id = typeof match.player1Id === "string" ? match.player1Id : null;
      const player1Name = typeof match.player1Name === "string" ? match.player1Name : null;
      const player2Id = typeof match.player2Id === "string" ? match.player2Id : null;
      const player2Name = typeof match.player2Name === "string" ? match.player2Name : null;

      if (!player1Id || !player1Name || !player2Id || !player2Name) {
        logger.warn({ historicalMatchId: match.id }, "Skipping historical evaluation row with missing required player identifiers");
        continue;
      }

      // Sanitize and validate the persistence object to avoid fatal DB errors
      const toInsert = {
        predictionMode: defaultPredictionMode("historical_test"),
        strategyId: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("historical_test"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: lockedAt }).strategyId,
        strategyVersion: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("historical_test"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: lockedAt }).strategyVersion,
        strategyFingerprint: HISTORICAL_MODEL_VERSION,
        optimizerRunId,
        calibrationVersion: null,
        competitiveBalanceVersion: null,
        evidenceReliabilityVersion: null,
        runKind: "historical_test",
        foldId,
        segment,
        dataSegment: segment,
        historicalMatchId: typeof match.id === "number" ? match.id : null,
        player1Id,
        player1Name,
        player2Id,
        player2Name,
        surface: typeof match.surface === "string" ? match.surface : null,
        matchFormat: typeof match.matchFormat === "string" ? match.matchFormat : null,
        tournamentLevel: typeof match.tournamentLevel === "string" ? match.tournamentLevel : null,
        tournamentName: typeof match.tournamentName === "string" ? match.tournamentName : null,
        scheduledStartAt: match.scheduledStartAt instanceof Date ? match.scheduledStartAt : new Date(match.scheduledStartAt),
        cutoffAt: match.cutoffAt instanceof Date ? match.cutoffAt : new Date(match.cutoffAt),
        lockedAt,
        modelVersion: HISTORICAL_MODEL_VERSION,
        // featureSnapshot may be large; keep it but avoid logging it on error
        featureSnapshot: scored?.snapshot ?? null,
        modelAgreement: typeof scored?.modelAgreement === "string" ? scored.modelAgreement : null,
        upsetRiskTier: typeof scored?.upsetRiskTier === "string" ? scored.upsetRiskTier : null,
        usedFallback: scored?.usedFallback ?? null,
        fallbackSources: scored?.fallbackSources ?? null,
        rawProbability: rawProbability !== null && Number.isFinite(rawProbability) ? rawProbability * 100 : null,
        calibratedProbability: rawProbability !== null && Number.isFinite(rawProbability) ? rawProbability * 100 : null,
        predictedWinnerId: predictedWinnerId ?? null,
        predictedWinnerName: predictedWinnerId ? (predictedWinnerId === player1Id ? player1Name : player2Name) : null,
        status: rawProbability === null ? "void" : isVoid ? "void" : "graded",
        actualWinnerId: typeof match.winnerId === "string" ? match.winnerId : null,
        actualWinnerName:
          match.winnerId && typeof match.winnerId === "string"
            ? match.winnerId === player1Id
              ? player1Name
              : player2Name
            : null,
        resultType: rawProbability === null ? null : resultType,
        includedInAccuracy: typeof includedInAccuracy === "boolean" ? includedInAccuracy : false,
        gradedAt: new Date(),
      };

      try {
        const [inserted] = await db.insert(evaluationPredictionsTable).values(toInsert).returning({ id: evaluationPredictionsTable.id });
        results.push({ id: inserted.id, rawProbability, player1Won, includedInAccuracy, tieBreakerApplied, lockedAt });
      } catch (err: any) {
        // Capture concise DB error metadata without logging the full feature snapshot or payload
        const errInfo: Record<string, any> = {
          message: err?.message ?? String(err),
          code: err?.code ?? null,
          constraint: err?.constraint ?? null,
          runKind: toInsert.runKind,
          historicalMatchId: toInsert.historicalMatchId,
          scheduledStartAt: toInsert.scheduledStartAt,
          fieldChecks: {
            rawProbabilityFinite: Number.isFinite(toInsert.rawProbability),
            scheduledStartAtValid: toInsert.scheduledStartAt instanceof Date && !isNaN((toInsert.scheduledStartAt as Date).getTime()),
            cutoffAtValid: toInsert.cutoffAt instanceof Date && !isNaN((toInsert.cutoffAt as Date).getTime()),
          },
        };
        logger.error(errInfo, "evaluation_predictions insert failed (concise)");
        // Try a smallest-safe repair: drop `featureSnapshot` (common cause for JSON/serialization issues)
        try {
          const repair = { ...toInsert, featureSnapshot: null };
          const [recovered] = await db.insert(evaluationPredictionsTable).values(repair).returning({ id: evaluationPredictionsTable.id });
          logger.warn({ recoveredId: recovered.id, historicalMatchId: toInsert.historicalMatchId }, "evaluation_predictions insert recovered by dropping featureSnapshot");
          results.push({ id: recovered.id, rawProbability, player1Won, includedInAccuracy, tieBreakerApplied, lockedAt });
        } catch (repairErr: any) {
          // If repair also fails, surface the original concise error and re-throw the repair error
          logger.error({ repairMessage: repairErr?.message ?? String(repairErr) }, "evaluation_predictions repair attempt failed");
          throw err;
        }
      }
    }

    return results;
  }

  async function recalibrateRows(ids: number[], mapping: CalibrationKnot[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await db
      .select({ id: evaluationPredictionsTable.id, rawProbability: evaluationPredictionsTable.rawProbability })
      .from(evaluationPredictionsTable)
      .where(inArray(evaluationPredictionsTable.id, ids));

    for (const row of rows) {
      if (row.rawProbability === null) continue;
      const calibrated = applyCalibrationOriented(mapping, row.rawProbability / 100) * 100;
      await db
        .update(evaluationPredictionsTable)
        .set({ calibratedProbability: calibrated })
        .where(eq(evaluationPredictionsTable.id, row.id));
    }
  }

  async function summarizeSegment(_runKind: string, segment: string, foldId: number | null) {
    const { computeSegmentMetrics } = await import("./metrics");
    if (foldId === null) return computeSegmentMetrics([]);
    const rows = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.foldId, foldId));
    const filtered = rows.filter((r) => r.segment === segment);
    return computeSegmentMetrics(filtered);
  }
}
