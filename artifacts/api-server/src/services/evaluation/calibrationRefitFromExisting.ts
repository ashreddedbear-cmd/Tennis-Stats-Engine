/**
 * Fast calibration refit from existing evaluation_predictions data.
 *
 * Problem: the walk-forward skips already-scored historical matches (append-only design).
 * After the orientation fix (Task #175, 2026-08-09), there is no mechanism to produce a
 * correctly-oriented calibration model without clearing the entire evaluation_predictions table
 * and re-running the 2-3 hour walk-forward.
 *
 * Solution (Step 1, 2026-08-10): query the existing validation-segment evaluation_predictions
 * rows, join to historical_matches to get each row's source provider, apply the orientation
 * fix (predicted-winner space), exclude known-bad cascade rows, then fit and activate a new
 * calibration model — all in a single DB round-trip + fit operation (~seconds, not hours).
 *
 * This path is intentionally narrow: it re-uses existing scored rows, so the underlying
 * model predictions (rawProbability) are unchanged. Only the calibration mapping is replaced.
 *
 * Reference cases validated after every refit (Step 1 requirement):
 *   - Kostyuk/Swiatek    (raw ~33.4% → oriented x=0.666): was 84.5% → expect ~65-72%
 *   - Rinderknech/Nakashima (raw ~40.6% → oriented x=0.594): was 85.5% → expect ~60-68%
 *   - Pegula/Shnaider    (raw ~69.6% → oriented x=0.696): was 99.6% → expect ~72-85%
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, evaluationPredictionsTable, calibrationModelsTable, historicalMatchesTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import {
  fitBestCalibration,
  applyCalibration,
  isKnownBadCascadeRow,
  WINNER_ALWAYS_PLAYER1_PROVIDERS,
  type CalibrationPoint,
} from "./calibration";
import type { CalibrationKnot } from "./types";
// Use the same threshold as the activation endpoint so every pending model produced here
// can actually be approved via POST /evaluation/walk-forward/activate/:id.
import { MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE as MIN_HOLDOUT_TO_ACTIVATE } from "./walkForward";

export interface RefitReferenceCase {
  label: string;
  rawPlayer1Probability: number;
  orientedX: number;
  /** Calibrated P(predicted winner wins) — same as calibrated P(player1 wins) when raw ≥ 0.5 */
  calibratedConfidence: number;
  /** Calibrated P(player1 wins), in [0, 100] percentage scale matching the stored DB column */
  calibratedPlayer1Probability: number;
}

export interface RefitProviderBreakdown {
  provider: string;
  totalRows: number;
  accuracyEligible: number;
  cascadeBadExcluded: number;
  usedInFit: number;
  isWinnerAlwaysPlayer1: boolean;
}

export interface RefitCalibrationReport {
  status: "success" | "skipped" | "error";
  reason?: string;

  /** Per-provider row counts after filtering. */
  providerBreakdown: RefitProviderBreakdown[];

  /** Total rows used to fit the model (after all exclusions). */
  fitSampleSize: number;
  holdoutSampleSize: number;
  method: "isotonic" | "platt" | "none";
  isotonicHoldoutLogLoss: number | null;
  plattHoldoutLogLoss: number | null;

  /**
   * Task #198: this path now stores the new model as pending (pendingActivation=true) rather
   * than auto-activating. `activated` is always false; the admin must call
   * POST /evaluation/walk-forward/activate/:pendingModelId to activate it.
   */
  activated: false;
  /** ID of the pending calibration_models row when quality gates passed; undefined otherwise. */
  pendingModelId?: number;
  activationBlockedReason?: string;

  /** Fitted knots (for diagnostic inspection). */
  knots: CalibrationKnot[];

  /** Reference case outputs before (using previous model) and after (using new model). */
  referenceCases: {
    before: RefitReferenceCase[];
    after: RefitReferenceCase[];
  };

  durationMs: number;
  fittedAt: string;
}

/**
 * Computes reference case outputs using a given calibration mapping.
 * All three cases are oriented to predicted-winner space before lookup.
 */
function computeReferenceCases(mapping: CalibrationKnot[]): RefitReferenceCase[] {
  const cases: Array<{ label: string; rawPlayer1: number }> = [
    { label: "Kostyuk/Swiatek (raw ~33.4% for Kostyuk)", rawPlayer1: 0.334 },
    { label: "Rinderknech/Nakashima (raw ~40.6% for Rinderknech, pred #8006)", rawPlayer1: 0.406 },
    { label: "Pegula/Shnaider (raw ~69.6% for Pegula, pred #8010)", rawPlayer1: 0.696 },
  ];

  return cases.map(({ label, rawPlayer1 }) => {
    const predictedPlayer1 = rawPlayer1 >= 0.5;
    const orientedX = predictedPlayer1 ? rawPlayer1 : 1 - rawPlayer1;
    const calibratedConfidence = applyCalibration(mapping, orientedX);
    // De-orient: if model picked player2 (raw < 0.5), player1's calibrated prob is 1 - confidence
    const calibratedPlayer1Probability = (predictedPlayer1 ? calibratedConfidence : 1 - calibratedConfidence) * 100;
    return {
      label,
      rawPlayer1Probability: rawPlayer1,
      orientedX,
      calibratedConfidence,
      calibratedPlayer1Probability,
    };
  });
}

/**
 * Refits the calibration model from existing validation-segment evaluation_predictions rows,
 * applying the predicted-winner orientation fix for all rows (including those from
 * WINNER_ALWAYS_PLAYER1_PROVIDERS). Writes a new calibration_models row and activates it if
 * it passes the minimum-quality gates.
 *
 * @param minDate Optional YYYY-MM-DD lower bound on scheduledStartAt. When provided, only rows
 *   from that date forward are used. Restricting to recent rows (e.g. 2024-01-01) prevents
 *   the full-corpus dilution problem: models fit on the entire historical corpus (2000–present)
 *   produce worse cross-check deltas on live paper-trade rows than models fit on recent data only.
 *   See .agents/memory/market-odds-ablation-results.md § "Full-corpus calibration underperforms".
 *
 * Returns a full diagnostic report including per-provider breakdowns and reference case outputs.
 */
export async function refitCalibrationFromExistingEvaluationData(minDate?: string): Promise<RefitCalibrationReport> {
  const startMs = Date.now();
  const fittedAt = new Date().toISOString();

  logger.info("calibration-refit-from-existing: starting");

  // ── Load previous active model (for "before" reference cases) ─────────────────────────
  const [previousActiveModel] = await db
    .select({ id: calibrationModelsTable.id, mapping: calibrationModelsTable.mapping, isotonicHoldoutLogLoss: calibrationModelsTable.isotonicHoldoutLogLoss })
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);

  const previousMapping: CalibrationKnot[] = previousActiveModel
    ? (previousActiveModel.mapping as CalibrationKnot[])
    : [{ x: 0, y: 0 }, { x: 1, y: 1 }];

  const referenceBefore = computeReferenceCases(previousMapping);

  // ── Query validation rows with provider info ───────────────────────────────────────────
  // Join historical_matches to get the source provider for each evaluation_predictions row.
  // We only need: raw_probability, actual_winner_id, player1_id, locked_at,
  // and the tieBreakerApplied flag (extracted from featureSnapshot JSONB).
  const minDateFilter = minDate ? gte(evaluationPredictionsTable.scheduledStartAt, new Date(minDate)) : undefined;

  logger.info(
    { minDate: minDate ?? "none (full corpus)" },
    "calibration-refit-from-existing: applying date filter",
  );

  const rows = await db
    .select({
      id:               evaluationPredictionsTable.id,
      rawProbability:   evaluationPredictionsTable.rawProbability,           // 0-100 scale in DB
      actualWinnerId:   evaluationPredictionsTable.actualWinnerId,
      player1Id:        evaluationPredictionsTable.player1Id,
      lockedAt:         evaluationPredictionsTable.lockedAt,
      includedInAccuracy: evaluationPredictionsTable.includedInAccuracy,
      tieBreakerApplied: sql<boolean | null>`(
        (${evaluationPredictionsTable.featureSnapshot}->'engine'->>'tieBreakerApplied')::boolean
      )`,
      provider: historicalMatchesTable.provider,
    })
    .from(evaluationPredictionsTable)
    .innerJoin(historicalMatchesTable, eq(evaluationPredictionsTable.historicalMatchId, historicalMatchesTable.id))
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "historical_test"),
        eq(evaluationPredictionsTable.segment, "validation"),
        eq(evaluationPredictionsTable.includedInAccuracy, true),
        isNotNull(evaluationPredictionsTable.rawProbability),
        isNotNull(evaluationPredictionsTable.actualWinnerId),
        isNotNull(evaluationPredictionsTable.player1Id),
        minDateFilter,
      ),
    );

  logger.info({ totalRows: rows.length }, "calibration-refit-from-existing: loaded validation rows");

  // ── Per-provider breakdown ─────────────────────────────────────────────────────────────
  const providerMap = new Map<string, RefitProviderBreakdown>();

  const fitPoints: CalibrationPoint[] = [];

  for (const row of rows) {
    const provider = row.provider ?? "unknown";
    if (!providerMap.has(provider)) {
      providerMap.set(provider, {
        provider,
        totalRows: 0,
        accuracyEligible: 0,
        cascadeBadExcluded: 0,
        usedInFit: 0,
        isWinnerAlwaysPlayer1: WINNER_ALWAYS_PLAYER1_PROVIDERS.has(provider),
      });
    }
    const breakdown = providerMap.get(provider)!;
    breakdown.totalRows++;
    breakdown.accuracyEligible++;

    // Exclude known-bad pre-cascade rows
    const lockedAt = row.lockedAt instanceof Date ? row.lockedAt : new Date(row.lockedAt as string);
    const tieBreakerApplied = typeof row.tieBreakerApplied === "boolean" ? row.tieBreakerApplied : false;
    if (isKnownBadCascadeRow(lockedAt, tieBreakerApplied)) {
      breakdown.cascadeBadExcluded++;
      continue;
    }

    // rawProbability is stored as 0-100 in DB; convert to 0-1 for calibration
    const rawDb = typeof row.rawProbability === "number" ? row.rawProbability : null;
    if (rawDb === null || !Number.isFinite(rawDb)) continue;
    const raw = rawDb / 100; // now 0-1

    // Orientation fix: train in predicted-winner space regardless of provider convention.
    // For WINNER_ALWAYS_PLAYER1_PROVIDERS (sackmann, tennis-data-co-uk), player1Won is always
    // true by construction — but the orientation transform still works correctly:
    //   - Model predicts player1 (raw ≥ 0.5): outcome = 1 (player1 won, model was right)
    //   - Model predicts player2 (raw < 0.5): outcome = 0 (player1 won, model was wrong)
    // This gives honest training signal: high model confidence in the predicted winner → outcome=1.
    const player1Won = row.actualWinnerId === row.player1Id;
    const predictedPlayer1 = raw >= 0.5;
    const orientedX = predictedPlayer1 ? raw : 1 - raw; // always in [0.5, 1.0]
    const outcome = (predictedPlayer1 === player1Won ? 1 : 0) as 0 | 1;

    fitPoints.push({ rawProbability: orientedX, outcome });
    breakdown.usedInFit++;
  }

  const providerBreakdown = Array.from(providerMap.values()).sort((a, b) => b.usedInFit - a.usedInFit);

  logger.info(
    {
      fitPoints: fitPoints.length,
      providers: providerBreakdown.map((p) => `${p.provider}:${p.usedInFit}`).join(", "),
    },
    "calibration-refit-from-existing: orientation complete",
  );

  if (fitPoints.length < 100) {
    return {
      status: "skipped",
      reason: `Too few fit points after exclusions: ${fitPoints.length} (need ≥ 100)`,
      providerBreakdown,
      fitSampleSize: fitPoints.length,
      holdoutSampleSize: 0,
      method: "none",
      isotonicHoldoutLogLoss: null,
      plattHoldoutLogLoss: null,
      activated: false,
      activationBlockedReason: "insufficient data",
      knots: previousMapping,
      referenceCases: { before: referenceBefore, after: computeReferenceCases(previousMapping) },
      durationMs: Date.now() - startMs,
      fittedAt,
    };
  }

  // ── Fit ───────────────────────────────────────────────────────────────────────────────
  const fitResult = fitBestCalibration(fitPoints);

  logger.info(
    {
      method: fitResult.method,
      fitSampleSize: fitResult.fitSampleSize,
      holdoutSampleSize: fitResult.holdoutSampleSize,
      isotonicHoldoutLogLoss: fitResult.isotonicHoldoutLogLoss,
      plattHoldoutLogLoss: fitResult.plattHoldoutLogLoss,
    },
    "calibration-refit-from-existing: fit complete",
  );

  const newMapping = fitResult.knots;
  const referenceAfter = computeReferenceCases(newMapping);

  // ── Quality gates ──────────────────────────────────────────────────────────────────────
  //
  // Gate 1 — non-degenerate: holdout slice must exist (≥ 100 points, per fitBestCalibration)
  // Gate 2 — holdout floor: require MIN_HOLDOUT_TO_ACTIVATE held-out rows
  // Gate 3 — not worse than current active model on log loss
  const gate1 = fitResult.holdoutSampleSize > 0;
  const gate2 = fitResult.holdoutSampleSize >= MIN_HOLDOUT_TO_ACTIVATE;
  const activeLL = previousActiveModel?.isotonicHoldoutLogLoss ?? null;
  const newLL = fitResult.isotonicHoldoutLogLoss;
  const gate3 = !previousActiveModel || activeLL === null || (newLL !== null && newLL <= activeLL);

  const activationBlockedReason = !gate1
    ? "degenerate fit (holdoutSampleSize === 0)"
    : !gate2
    ? `holdout too small: ${fitResult.holdoutSampleSize} < ${MIN_HOLDOUT_TO_ACTIVATE}`
    : !gate3
    ? `new model LL (${newLL?.toFixed(4)}) > active model LL (${activeLL?.toFixed(4)})`
    : undefined;

  // Task #198: store the new model as pending (never auto-activate).
  // Admin must approve via POST /evaluation/walk-forward/activate/:pendingModelId.
  // This path is calibration-only (no specialist data), so pendingSpecialistData stays null.
  let pendingModelId: number | undefined;

  if (!activationBlockedReason) {
    // Insert as pending — do NOT deactivate the current active model yet.
    const [inserted] = await db
      .insert(calibrationModelsTable)
      .values({
        method: fitResult.method,
        mapping: newMapping as any,
        validationSampleSize: fitResult.fitSampleSize,
        active: false,
        pendingActivation: true,
        isotonicHoldoutLogLoss: fitResult.isotonicHoldoutLogLoss ?? undefined,
        plattHoldoutLogLoss: fitResult.plattHoldoutLogLoss ?? undefined,
        holdoutSampleSize: fitResult.holdoutSampleSize,
      })
      .returning({ id: calibrationModelsTable.id });
    pendingModelId = inserted?.id;
    logger.info(
      { method: fitResult.method, fitSampleSize: fitResult.fitSampleSize, holdoutSampleSize: fitResult.holdoutSampleSize, pendingModelId },
      "calibration-refit-from-existing: new model stored as pending — activate via POST /evaluation/walk-forward/activate/:pendingModelId",
    );
  } else {
    logger.warn({ activationBlockedReason }, "calibration-refit-from-existing: quality gate failed, model not stored");
  }

  const durationMs = Date.now() - startMs;

  return {
    status: "success",
    providerBreakdown,
    fitSampleSize: fitResult.fitSampleSize,
    holdoutSampleSize: fitResult.holdoutSampleSize,
    method: fitResult.method,
    isotonicHoldoutLogLoss: fitResult.isotonicHoldoutLogLoss,
    plattHoldoutLogLoss: fitResult.plattHoldoutLogLoss,
    activated: false,
    pendingModelId,
    activationBlockedReason,
    knots: newMapping,
    referenceCases: { before: referenceBefore, after: referenceAfter },
    durationMs,
    fittedAt,
  };
}
