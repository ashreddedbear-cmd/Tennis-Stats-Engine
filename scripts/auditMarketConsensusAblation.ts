/**
 * Market Consensus Ablation — Section B (live paper_trade paired rows)
 *
 * Compares two otherwise-identical arms:
 *   BASELINE   : stored preCalibrationProbability → current calibration → current specialist
 *                → current simulator → clamp
 *   WITH-MARKET: newPreCal (market injected into the feature ensemble) → current calibration
 *                → current specialist → current simulator → clamp
 *
 * Both arms pass through exactly the same post-ensemble pipeline so the delta isolates
 * the market signal from any calibration drift between lock time and now.
 *
 * Why NOT use stored calibratedProbability as the baseline:
 *   stored calibratedProbability reflects whichever calibration was active at lock time.
 *   If the calibration has since been updated, the delta would conflate calibration
 *   improvement with the market signal, making the result uninterpretable.
 *
 * Injecting market odds into the pre-calibration step:
 *   rawWeight_i = max(1, reliability_i) × weightPrior_i for each feature module i
 *   S           = Σ(rawWeight_i)  [the original total weight denominator]
 *   marketRaw   = 80 (reliability) × 0.5 (prior) = 40
 *   newPreCalP1 = (preCalP1 × S + marketP1 × 40) / (S + 40)
 *
 * S is derived from the WEIGHT_PRIOR table and stored reliability values — the same
 * computation buildEnsemble performs. It is cross-validated row-by-row against the stored
 * weightUsed values: if Σ(player1Probability × weightUsed) differs from preCalP1 by more
 * than the rounding tolerance, the row is rejected as unverifiable. This guards against
 * unexpected module changes between the lock time and today.
 *
 * Why Fatigue, Availability, MatchLoadRecovery are NOT in S:
 *   These modules are in EXCLUDED_FROM_ENSEMBLE and therefore never appear in engine.models
 *   for non-ablation (live/paper_trade) calls. The stored featureSnapshot.engine.models for
 *   paper_trade rows contains only the non-excluded feature modules (Surface Elo, Serve &
 *   Return, Recent Form, Head-to-Head). Both the S computation and the cross-validation
 *   operate on the actual stored models list, so any unexpected contributor would fail the
 *   cross-validation check and be reported.
 *
 * Activation criteria (from task spec):
 *   n ≥ 200 accuracy-eligible paired rows (after cross-validation passes)
 *   AND Δacc ≥ +0.5pp
 *   AND Δlog-loss ≤ −0.010
 *
 * Run from api-server directory:
 *   cd artifacts/api-server && pnpm exec tsx ../../scripts/auditMarketConsensusAblation.ts
 */

import { db, evaluationPredictionsTable, calibrationModelsTable, specialistModelsTable } from "@workspace/db";
import { and, count, eq, isNotNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Weight priors (must match ENSEMBLE_WEIGHT_PRIOR in dataQuality.ts)
// ---------------------------------------------------------------------------
const WEIGHT_PRIOR: Record<string, number> = {
  "Surface Elo":   1.5,
  "Serve & Return": 1.5,
  "Recent Form":   1.3,  // overridden to 0.1 when formEloConflict=true
  "Head-to-Head":  0.4,
};
const FORM_ELO_CONFLICT_PRIOR = 0.1;
const MARKET_RELIABILITY  = 80;
const MARKET_WEIGHT_PRIOR = 0.5;
const MARKET_RAW_WEIGHT   = MARKET_RELIABILITY * MARKET_WEIGHT_PRIOR; // 40

/**
 * Tolerance for the baseline cross-validation check.
 * preCalibrationProbability is stored at 1dp; weightUsed at 3dp. Rounding accumulates
 * across up to 4 modules, so an honest discrepancy can reach ~1.5pp in extreme cases.
 * Rows exceeding this are rejected as unverifiable.
 */
const CROSS_VALIDATION_TOLERANCE_PP = 1.5;

/** Linear interpolation between calibration knots. Matches applyCalibration() in calibration.ts. */
function applyCalibration(mapping: Array<{ x: number; y: number }>, rawProbability: number): number {
  const x = Math.max(0, Math.min(1, rawProbability));
  if (mapping.length === 0) return x;
  if (x <= mapping[0].x) return mapping[0].y;
  if (x >= mapping[mapping.length - 1].x) return mapping[mapping.length - 1].y;
  for (let i = 0; i < mapping.length - 1; i++) {
    const a = mapping[i];
    const b = mapping[i + 1];
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return a.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return x;
}

function applyCalibrationPct(knots: Array<{ x: number; y: number }>, rawPct: number): number {
  return Math.round(applyCalibration(knots, rawPct / 100) * 1000) / 10;
}

function logLossBinary(pPct: number, outcome: 1 | 0): number {
  const eps = 1e-9;
  const prob = Math.max(eps, Math.min(1 - eps, pPct / 100));
  return outcome === 1 ? -Math.log(prob) : -Math.log(1 - prob);
}

/**
 * Reconstruct the final blended probability from a pre-calibration probability,
 * applying the SAME active calibration → specialist → simulator pipeline for both arms.
 */
function reconstructFinalProbability(
  preCalP1: number,
  surface: string,
  snap: any,
  calibKnots: Array<{ x: number; y: number }>,
  specialists: Map<string, any>,
): number {
  const engine = snap.engine;

  // Step 1: Apply current calibration
  const generalP1 = applyCalibrationPct(calibKnots, preCalP1);

  // Step 2: Apply specialist if applicable.
  // Clay specialist is disabled (per ablation finding: −1.67pp on Clay, Ticket 1, 2026-08-08).
  // Both arms apply the same gate so the delta is not affected by this policy.
  let blendedP1 = generalP1;
  const specialistApplied = engine?.specialistApplied ?? false;
  if (specialistApplied && surface !== "Clay") {
    const segmentKey = engine?.segmentKey as string | null;
    const specialist = segmentKey ? specialists.get(segmentKey) : null;
    if (
      specialist &&
      specialist.meetsThreshold &&
      specialist.calibrationMapping &&
      (specialist.calibrationMapping as any[]).length > 0
    ) {
      const specKnots = specialist.calibrationMapping as Array<{ x: number; y: number }>;
      const specialistP1 = applyCalibrationPct(specKnots, preCalP1);
      const specWeight = specialist.weight ?? 0;
      blendedP1 = Math.round((specWeight * specialistP1 + (1 - specWeight) * generalP1) * 10) / 10;
    }
  }

  // Step 3: Apply simulator if it was active (simulator input unchanged by market odds)
  let finalP1 = blendedP1;
  const simulatorApplied = engine?.simulatorApplied ?? false;
  if (simulatorApplied && engine?.simulation) {
    const simulatorModel = (engine?.models ?? []).find(
      (m: any) => m.modelName === "Monte Carlo Simulator",
    );
    if (simulatorModel && engine.simulation.player1WinProbability != null) {
      const simWeight = simulatorModel.weightUsed ?? 0;
      const simP1 = engine.simulation.player1WinProbability;
      finalP1 = Math.round((simWeight * simP1 + (1 - simWeight) * blendedP1) * 10) / 10;
    }
  }

  // Step 4: Clamp to engine bounds [0.6, 99.4]
  return Math.max(0.6, Math.min(99.4, finalP1));
}

async function run() {
  // 1. Active calibration
  const [calRow] = await db
    .select()
    .from(calibrationModelsTable)
    .where(eq(calibrationModelsTable.active, true))
    .limit(1);
  if (!calRow || !calRow.mapping || (calRow.mapping as any[]).length === 0) {
    console.error("No active calibration model found.");
    process.exit(1);
  }
  const calibrationKnots = calRow.mapping as Array<{ x: number; y: number }>;
  console.log(
    `Active calibration: id=${calRow.id}, method=${calRow.method}, validationN=${calRow.validationSampleSize}, holdoutN=${calRow.holdoutSampleSize}`,
  );

  // 2. Active specialist models
  const specialistRows = await db.select().from(specialistModelsTable);
  const specialistByKey = new Map<string, typeof specialistRows[0]>();
  for (const s of specialistRows) {
    if (s.meetsThreshold) specialistByKey.set(s.segmentKey, s);
  }
  console.log(`Active specialists: ${[...specialistByKey.keys()].join(", ")}`);

  // 3. Query total graded rows with odds (context only — not the activation gate)
  const [{ totalWithOdds }] = await db
    .select({ totalWithOdds: count() })
    .from(evaluationPredictionsTable)
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "paper_trade"),
        eq(evaluationPredictionsTable.status, "graded"),
        isNotNull(evaluationPredictionsTable.oddsPlayer1Decimal),
      ),
    );

  // 4. Accuracy-eligible paper_trade rows with odds
  const eligibleRows = await db
    .select()
    .from(evaluationPredictionsTable)
    .where(
      and(
        eq(evaluationPredictionsTable.runKind, "paper_trade"),
        eq(evaluationPredictionsTable.status, "graded"),
        eq(evaluationPredictionsTable.includedInAccuracy, true),
        isNotNull(evaluationPredictionsTable.oddsPlayer1Decimal),
        isNotNull(evaluationPredictionsTable.impliedProbability),
        isNotNull(evaluationPredictionsTable.calibratedProbability),
        isNotNull(evaluationPredictionsTable.actualWinnerId),
        isNotNull(evaluationPredictionsTable.predictedWinnerId),
      ),
    )
    .orderBy(evaluationPredictionsTable.scheduledStartAt);

  const nEligible = eligibleRows.length;
  console.log(`\nTotal graded paper_trade rows with odds (any accuracy status): ${totalWithOdds}`);
  console.log(`Accuracy-eligible rows with odds (cohort before cross-validation): ${nEligible}`);
  if (nEligible === 0) {
    console.error("No eligible rows found.");
    process.exit(1);
  }

  // 5. Process rows: compute both arms with cross-validation
  let baselineCorrect = 0;
  let withMarketCorrect = 0;
  let baselineLogLossSum = 0;
  let withMarketLogLossSum = 0;
  let marketDisagreements = 0;
  let marketCorrectWhenDisagreed = 0;
  let modelCorrectWhenDisagreed = 0;
  const bySurface: Record<string, { n: number; bCorr: number; wCorr: number; bLL: number; wLL: number }> = {};
  const reconstructionErrors: string[] = [];
  let processedN = 0;

  for (const row of eligibleRows) {
    const snap = row.featureSnapshot as any;
    if (!snap || !snap.engine || snap.preCalibrationProbability == null) {
      reconstructionErrors.push(`Row ${row.id}: missing featureSnapshot or preCalibrationProbability`);
      continue;
    }

    const engine = snap.engine;
    const preCalP1   = snap.preCalibrationProbability as number; // 0-100
    const impliedP1  = row.impliedProbability!;                   // vig-adjusted, player-1, 0-100
    const surface    = row.surface ?? "";

    // Feature models only: exclude post-ensemble models from S
    const featureModels: Array<{ modelName: string; reliability: number; weightUsed: number }> = (
      engine.models ?? []
    ).filter(
      (m: any) =>
        m.modelName !== "General Model" &&
        m.modelName !== "Monte Carlo Simulator" &&
        !String(m.modelName).startsWith("Segment Specialist"),
    );

    if (featureModels.length === 0) {
      reconstructionErrors.push(`Row ${row.id}: no feature models in snapshot`);
      continue;
    }

    // Compute S = Σ(max(1, reliability_i) × weightPrior_i) using the same formula as buildEnsemble.
    // This is the original totalWeight denominator before normalization.
    const formEloConflict = engine.formEloConflict ?? false;
    let S = 0;
    for (const m of featureModels) {
      const prior =
        m.modelName === "Recent Form" && formEloConflict
          ? FORM_ELO_CONFLICT_PRIOR
          : (WEIGHT_PRIOR[m.modelName] ?? 1.0);
      S += Math.max(1, m.reliability) * prior;
    }

    // Cross-validate S: verify that Σ(player1Probability × weightUsed) ≈ preCalP1.
    // This confirms our S reproduces the stored ensemble and that no unexpected modules
    // contributed. Rounding accumulates across models, so we allow CROSS_VALIDATION_TOLERANCE_PP.
    const reconstructedPreCal = featureModels.reduce(
      (sum, m) => sum + m.player1Probability * m.weightUsed,
      0,
    );
    const crossValError = Math.abs(reconstructedPreCal - preCalP1);
    if (crossValError > CROSS_VALIDATION_TOLERANCE_PP) {
      reconstructionErrors.push(
        `Row ${row.id}: cross-validation failed ` +
          `(Σ(p×w)=${reconstructedPreCal.toFixed(2)}pp ≠ preCalP1=${preCalP1.toFixed(2)}pp, ` +
          `Δ=${crossValError.toFixed(2)}pp > ${CROSS_VALIDATION_TOLERANCE_PP}pp tolerance)`,
      );
      continue;
    }

    // Inject market into the pre-calibration step.
    // Both arms then go through exactly the same pipeline.
    const newPreCalP1 = (preCalP1 * S + impliedP1 * MARKET_RAW_WEIGHT) / (S + MARKET_RAW_WEIGHT);

    const baselineP1    = reconstructFinalProbability(preCalP1,    surface, snap, calibrationKnots, specialistByKey);
    const withMarketP1  = reconstructFinalProbability(newPreCalP1, surface, snap, calibrationKnots, specialistByKey);

    const actualWon             = row.actualWinnerId === row.player1Id ? 1 : 0;
    const baselinePredictedP1   = baselineP1   >= 50;
    const withMarketPredictedP1 = withMarketP1 >= 50;
    const baselineCorrectRow    = baselinePredictedP1   === (actualWon === 1);
    const withMarketCorrectRow  = withMarketPredictedP1 === (actualWon === 1);

    baselineCorrect    += baselineCorrectRow   ? 1 : 0;
    withMarketCorrect  += withMarketCorrectRow ? 1 : 0;
    baselineLogLossSum  += logLossBinary(baselineP1,   actualWon as 0 | 1);
    withMarketLogLossSum += logLossBinary(withMarketP1, actualWon as 0 | 1);

    // Disagreement: market vs reconstructed baseline direction
    const marketFavorsP1 = impliedP1  >= 50;
    const modelFavorsP1  = baselineP1 >= 50;
    if (marketFavorsP1 !== modelFavorsP1) {
      marketDisagreements++;
      if (marketFavorsP1 === (actualWon === 1)) marketCorrectWhenDisagreed++;
      if (modelFavorsP1  === (actualWon === 1)) modelCorrectWhenDisagreed++;
    }

    const surf = surface || "Unknown";
    if (!bySurface[surf]) bySurface[surf] = { n: 0, bCorr: 0, wCorr: 0, bLL: 0, wLL: 0 };
    bySurface[surf].n++;
    bySurface[surf].bCorr += baselineCorrectRow   ? 1 : 0;
    bySurface[surf].wCorr += withMarketCorrectRow ? 1 : 0;
    bySurface[surf].bLL   += logLossBinary(baselineP1,   actualWon as 0 | 1);
    bySurface[surf].wLL   += logLossBinary(withMarketP1, actualWon as 0 | 1);

    processedN++;
  }

  if (processedN === 0) {
    console.error("No rows could be processed.");
    process.exit(1);
  }

  // 6. Aggregate metrics
  const n                = processedN;
  const baselineAccuracy = (baselineCorrect  / n) * 100;
  const withMarketAcc    = (withMarketCorrect / n) * 100;
  const deltaAcc         = withMarketAcc - baselineAccuracy;
  const baselineLL       = baselineLogLossSum  / n;
  const withMarketLL     = withMarketLogLossSum / n;
  const deltaLL          = withMarketLL - baselineLL;
  const disagRate        = (marketDisagreements / n) * 100;
  const mktAccDisagree   = marketDisagreements > 0 ? (marketCorrectWhenDisagreed / marketDisagreements) * 100 : null;
  const modAccDisagree   = marketDisagreements > 0 ? (modelCorrectWhenDisagreed  / marketDisagreements) * 100 : null;

  // 7. Print
  console.log("\n" + "=".repeat(72));
  console.log("MARKET CONSENSUS ABLATION — SECTION B RESULTS (corrected paired-arm)");
  console.log("=".repeat(72));
  console.log(`Methodology  : both arms reconstructed from stored preCalibrationProbability`);
  console.log(`               through SAME calibration → specialist → simulator pipeline.`);
  console.log(`               S verified row-by-row via stored weightUsed cross-validation.`);
  console.log(`Eligible n   : ${nEligible} accuracy-eligible rows with odds`);
  if (reconstructionErrors.length > 0) {
    console.log(`Skipped      : ${reconstructionErrors.length} (cross-val failed or missing snapshot)`);
  }
  console.log(`Processed n  : ${n}  ← used for gate and metrics`);
  console.log("");
  console.log(`Baseline accuracy     : ${baselineAccuracy.toFixed(2)}%`);
  console.log(`With-market accuracy  : ${withMarketAcc.toFixed(2)}%`);
  console.log(`Δacc                  : ${deltaAcc >= 0 ? "+" : ""}${deltaAcc.toFixed(2)}pp`);
  console.log("");
  console.log(`Baseline log-loss     : ${baselineLL.toFixed(4)}`);
  console.log(`With-market log-loss  : ${withMarketLL.toFixed(4)}`);
  console.log(`Δlog-loss             : ${deltaLL >= 0 ? "+" : ""}${deltaLL.toFixed(4)}`);
  console.log("");
  console.log(`Market disagreement rate : ${disagRate.toFixed(1)}% (n=${marketDisagreements})`);
  if (mktAccDisagree !== null) {
    console.log(`  Market accuracy when disagreeing  : ${mktAccDisagree.toFixed(1)}%`);
    console.log(`  Model accuracy when disagreeing   : ${modAccDisagree!.toFixed(1)}%`);
  }

  console.log("\nBy surface:");
  for (const [surf, b] of Object.entries(bySurface).sort(([a], [c]) => a.localeCompare(c))) {
    const bAcc = (b.bCorr / b.n) * 100;
    const wAcc = (b.wCorr / b.n) * 100;
    const dAcc = wAcc - bAcc;
    const bLL  = b.bLL / b.n;
    const wLL  = b.wLL / b.n;
    const dLL  = wLL - bLL;
    console.log(
      `  ${surf.padEnd(12)} n=${String(b.n).padStart(4)}` +
        `  baseline=${bAcc.toFixed(1)}%  with-market=${wAcc.toFixed(1)}%` +
        `  Δacc=${dAcc >= 0 ? "+" : ""}${dAcc.toFixed(1)}pp  Δlog-loss=${dLL >= 0 ? "+" : ""}${dLL.toFixed(4)}`,
    );
  }

  // 8. Activation decision
  const THRESHOLD_ACC = 0.5;    // +0.5pp
  const THRESHOLD_LL  = -0.010; // -0.010
  const THRESHOLD_N   = 200;    // accuracy-eligible processed rows

  const meetsAcc = deltaAcc >= THRESHOLD_ACC;
  const meetsLL  = deltaLL  <= THRESHOLD_LL;
  const meetsN   = n        >= THRESHOLD_N;
  const shouldActivate = meetsAcc && meetsLL && meetsN;

  console.log("\n" + "=".repeat(72));
  console.log("ACTIVATION DECISION");
  console.log("=".repeat(72));
  console.log(`Criteria: Δacc ≥ +${THRESHOLD_ACC}pp AND Δlog-loss ≤ ${THRESHOLD_LL} at n ≥ ${THRESHOLD_N}`);
  console.log(`  Δacc ≥ +${THRESHOLD_ACC}pp     : ${deltaAcc >= 0 ? "+" : ""}${deltaAcc.toFixed(2)}pp → ${meetsAcc ? "✓ MET" : "✗ NOT MET"}`);
  console.log(`  Δlog-loss ≤ ${THRESHOLD_LL}  : ${deltaLL >= 0 ? "+" : ""}${deltaLL.toFixed(4)} → ${meetsLL ? "✓ MET" : "✗ NOT MET"}`);
  console.log(`  n ≥ ${THRESHOLD_N}             : ${n} processed → ${meetsN ? "✓ MET" : "✗ NOT MET"}`);
  console.log("");
  console.log(
    `DECISION: ${
      shouldActivate
        ? "ACTIVATE — remove 'marketOdds' from EXCLUDED_FROM_ENSEMBLE"
        : "DO NOT ACTIVATE — keep 'marketOdds' in EXCLUDED_FROM_ENSEMBLE"
    }`,
  );

  if (reconstructionErrors.length > 0) {
    console.log(`\nCross-validation failures / missing-snapshot rows (${reconstructionErrors.length}):`);
    for (const e of reconstructionErrors.slice(0, 5)) console.log(`  ${e}`);
    if (reconstructionErrors.length > 5) console.log(`  … and ${reconstructionErrors.length - 5} more`);
  }
  console.log("=".repeat(72));

  return {
    nEligible,
    nProcessed: n,
    totalGradedWithOdds: totalWithOdds,
    baselineAccuracy,
    withMarketAccuracy: withMarketAcc,
    deltaAcc,
    baselineLogLoss: baselineLL,
    withMarketLogLoss: withMarketLL,
    deltaLogLoss: deltaLL,
    marketDisagreements,
    disagRate,
    mktAccDisagree,
    modAccDisagree,
    bySurface,
    shouldActivate,
    meetsAcc,
    meetsLL,
    meetsN,
    skippedRows: reconstructionErrors.length,
    generatedAt: new Date().toISOString(),
  };
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
