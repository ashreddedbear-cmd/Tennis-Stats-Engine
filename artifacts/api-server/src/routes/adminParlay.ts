/**
 * Admin-only: Parlay Builder routes.
 *
 * Two evaluation paths:
 *   POST /evaluate  — legacy path using Prediction Engine stored signals
 *   POST /validate  — Task 105 Independent Validation Engine (completely separate)
 *
 * The /validate route is the primary path for Task 105. It reads only raw match data and
 * independent evidence sources — NEVER the predictions table or any engine output.
 */
import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/adminAuth";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { computeBuilderScore, type BuilderSnapshot } from "../services/parlayBuilder/builderScoringService.js";
import { fetchMarketOdds } from "../services/oddsData";

const router: IRouter = Router();

// ── Safety Score ──────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  value: string;
  status: "pass" | "warn" | "fail";
}

interface EvalLeg {
  player1Name: string; player2Name: string; selectedName: string;
  tournamentName: string | null; selectedSide: "1" | "2";
  hasData: boolean; score: number | null; decision: string;
  reasons: string[]; checks: Record<string, CheckResult>;
  winnerProb: number | null; calibratedProbabilityP1: number | null;
  marketImpliedProb: number | null; marketOdds: number | null;
  dataQuality: number | null; dataQualityLabel: string | null;
  upsetRisk: string | null; modelAgreement: string | null;
  dataStoredAt: string | null;
}

interface ScoreResult {
  score: number;
  reasons: string[];
  checks: {
    calibratedConfidence: CheckResult;
    evidenceReliability: CheckResult;
    matchDifficulty: CheckResult;
    modelAgreement: CheckResult;
    conditionRisk: CheckResult;
    marketAlignment: CheckResult;
  };
}

function computeSafetyScore(params: {
  winnerProb: number;
  dataQuality: number;
  dataQualityLabel: string;
  upsetRisk: string;
  modelAgreement: string;
  closenessTo50: number | null;
  marketOdds: number | null;
}): ScoreResult {
  const { winnerProb, dataQuality, dataQualityLabel, upsetRisk, modelAgreement, closenessTo50, marketOdds } = params;

  // Base: winner prob 50%→0, 100%→10
  const base = Math.max(0, ((winnerProb - 50) / 50) * 10);
  let deductions = 0;
  const reasons: string[] = [];

  // 1. Calibrated confidence
  const confCheck: CheckResult = {
    label: "Calibrated Confidence",
    value: `${winnerProb.toFixed(1)}%`,
    status: winnerProb >= 65 ? "pass" : winnerProb >= 55 ? "warn" : "fail",
  };

  // 2. Evidence reliability (data quality)
  const dqCheck: CheckResult = { label: "Evidence Reliability", value: `${dataQuality} (${dataQualityLabel})`, status: "pass" };
  if (dataQuality < 25 || dataQualityLabel === "Poor") {
    deductions += 2.5; dqCheck.status = "fail";
    reasons.push("Very thin data — high uncertainty in this matchup");
  } else if (dataQuality < 45) {
    deductions += 1.5; dqCheck.status = "warn";
    reasons.push("Limited historical data for this matchup");
  } else if (dataQuality < 60) {
    deductions += 0.5; dqCheck.status = "warn";
  }

  // 3. Match difficulty (upset risk)
  const urCheck: CheckResult = { label: "Match Difficulty", value: upsetRisk, status: "pass" };
  if (upsetRisk === "EXTREME") {
    deductions += 2.5; urCheck.status = "fail";
    reasons.push("Extreme upset risk — highly volatile for parlay use");
  } else if (upsetRisk === "HIGH") {
    deductions += 1.5; urCheck.status = "warn";
    reasons.push("High upset risk — meaningful chance of surprise result");
  } else if (upsetRisk === "MODERATE") {
    deductions += 0.5; urCheck.status = "warn";
  }

  // 4. Model agreement
  const maCheck: CheckResult = { label: "Model Agreement", value: modelAgreement, status: "pass" };
  if (modelAgreement === "HighDisagreement") {
    deductions += 1.5; maCheck.status = "fail";
    reasons.push("Strong disagreement between prediction models");
  } else if (modelAgreement === "Mixed") {
    deductions += 0.7; maCheck.status = "warn";
    reasons.push("Mixed signals across prediction models");
  }

  // 5. Condition risk (closeness to 50 / coin-flip proximity)
  const c50Check: CheckResult = {
    label: "Condition Risk",
    value: closenessTo50 != null ? `${(closenessTo50 * 100).toFixed(0)}% near-flip` : "N/A",
    status: "pass",
  };
  if (closenessTo50 != null && closenessTo50 > 0.8) {
    deductions += 0.8; c50Check.status = "warn";
    reasons.push("Probability is very close to a coin flip");
  } else if (closenessTo50 != null && closenessTo50 > 0.5) {
    deductions += 0.3; c50Check.status = "warn";
  }

  // 6. Market alignment (if odds supplied)
  const mktCheck: CheckResult = { label: "Market Alignment", value: "N/A", status: "pass" };
  if (marketOdds != null && marketOdds > 1) {
    const impliedProb = (1 / marketOdds) * 100;
    mktCheck.value = `${impliedProb.toFixed(1)}% implied`;
    const gap = Math.abs(winnerProb - impliedProb);
    if (gap > 15) {
      deductions += 2.0; mktCheck.status = "fail";
      reasons.push(`Large model-vs-market gap (${gap.toFixed(0)}pp) — possible unpriced risk`);
    } else if (gap > 8) {
      deductions += 1.0; mktCheck.status = "warn";
      reasons.push(`Moderate model-vs-market gap (${gap.toFixed(0)}pp)`);
    } else {
      mktCheck.status = "pass";
    }
  }

  const score = parseFloat(Math.max(0, Math.min(10, base - deductions)).toFixed(1));

  // Default positive reason when no red flags
  if (reasons.length === 0) {
    if (score >= 8) reasons.push("Strong calibrated edge with stable, consistent evidence");
    else if (score >= 7) reasons.push("Good calibrated probability with acceptable risk profile");
    else reasons.push("Reasonable edge — playable but treat with care");
  }

  return { score, reasons: reasons.slice(0, 3), checks: { calibratedConfidence: confCheck, evidenceReliability: dqCheck, matchDifficulty: urCheck, modelAgreement: maCheck, conditionRisk: c50Check, marketAlignment: mktCheck } };
}

function getDecision(score: number): "Approved" | "Caution" | "Remove" {
  if (score >= 7) return "Approved";
  if (score >= 4) return "Caution";
  return "Remove";
}

function getSlipFragility(legs: Array<{ score: number; decision: string }>): "Low" | "Moderate" | "High" | "Extreme" {
  if (legs.length === 0) return "Low";
  const hasRemove = legs.some(l => l.decision === "Remove");
  const hasCaution = legs.some(l => l.decision === "Caution");
  const avg = legs.reduce((s, l) => s + l.score, 0) / legs.length;
  if (hasRemove || avg < 3) return "Extreme";
  if (hasCaution && avg < 5) return "High";
  if (hasCaution || avg < 7) return "Moderate";
  return "Low";
}

// ── POST /admin/parlay/evaluate ───────────────────────────────────────────────

router.post("/admin/parlay/evaluate", requireAdmin, async (req, res): Promise<void> => {
  try {
    const { legs } = req.body as {
      legs: Array<{
        player1Id: string;
        player2Id: string;
        player1Name: string;
        player2Name: string;
        selectedSide: "1" | "2"; // which player in the matchup the user is backing
        tournamentName?: string | null;
        surface?: string | null;
        marketOdds?: number | null; // decimal odds for the selected player
      }>;
    };

    if (!Array.isArray(legs) || legs.length === 0) { res.status(400).json({ error: "legs must be a non-empty array" }); return; }
    if (legs.length > 150) { res.status(400).json({ error: "maximum 150 legs per parlay" }); return; }

    const evaluatedLegs = await Promise.all(legs.map(async (leg): Promise<EvalLeg> => {
      try {
      const { player1Id, player2Id, player1Name, player2Name, selectedSide, tournamentName, marketOdds: callerMarketOdds } = leg;
      const inlineSignals = (leg as Record<string, unknown>).inlineSignals as {
        calibratedProbabilityP1: number;
        dataQuality: number;
        dataQualityLabel: string;
        upsetRisk: string;
        modelAgreement: string;
        closenessTo50: number | null;
      } | null | undefined;
      const selectedIsP1 = selectedSide === "1";
      const selectedName = selectedIsP1 ? player1Name : player2Name;

      // Task #2: resolve real market odds when the caller did not supply them.
      // Without this, computeSafetyScore falls back to a hardcoded 50 (neutral) market factor
      // for every leg that lacks caller-supplied odds — the "50 % fallback" Task #2 removes.
      let marketOdds: number | null = callerMarketOdds ?? null;
      if (marketOdds === null) {
        try {
          const oddsQuote = await fetchMarketOdds(player1Name, player2Name, null);
          if (oddsQuote) {
            // Orient to the selected player so the implied-probability display is always relative
            // to the pick, not a fixed player slot.
            marketOdds = selectedIsP1 ? oddsQuote.player1DecimalOdds : oddsQuote.player2DecimalOdds;
          }
        } catch (fetchErr) {
          logger.warn({ fetchErr, player1Name, player2Name }, "Market odds fetch failed — scoring leg without odds");
        }
      }

      // Fast path: inline signals supplied by caller (e.g. freshly-run prediction result)
      // Skip the DB lookup entirely and compute the safety score directly.
      if (inlineSignals) {
        const { calibratedProbabilityP1: calibP1, dataQuality, dataQualityLabel, upsetRisk, modelAgreement, closenessTo50 } = inlineSignals;
        const winnerProb = selectedIsP1 ? calibP1 : 100 - calibP1;
        const { score, reasons, checks } = computeSafetyScore({ winnerProb, dataQuality, dataQualityLabel, upsetRisk, modelAgreement, closenessTo50, marketOdds: marketOdds ?? null });
        return {
          player1Name, player2Name, selectedName, tournamentName: tournamentName ?? null, selectedSide,
          hasData: true,
          score, decision: getDecision(score), reasons, checks,
          winnerProb: parseFloat(winnerProb.toFixed(1)),
          calibratedProbabilityP1: parseFloat(calibP1.toFixed(1)),
          marketImpliedProb: marketOdds ? parseFloat(((1 / marketOdds) * 100).toFixed(1)) : null,
          marketOdds: marketOdds ?? null,
          dataQuality, dataQualityLabel, upsetRisk, modelAgreement,
          dataStoredAt: new Date().toISOString(),
        };
      }

      // Query user predictions first (most recent within 30 days, either player order)
      const { rows } = await pool.query(`
        SELECT
          player1_id, calibrated_probability,
          COALESCE(data_quality, 0) AS data_quality,
          COALESCE(data_quality_label, 'Unknown') AS data_quality_label,
          upset_risk, engine, created_at
        FROM predictions
        WHERE (
          (player1_id = $1 AND player2_id = $2) OR
          (player1_id = $2 AND player2_id = $1)
        )
        AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
        LIMIT 1
      `, [player1Id, player2Id]);

      // Fallback: evaluation_predictions (paper-trade or walk-forward rows)
      let row = rows[0];
      let storedP1Id: string | null = null;
      if (!row) {
        const epRes = await pool.query(`
          SELECT
            player1_id, calibrated_probability, data_quality, data_quality_label,
            upset_risk_tier AS upset_risk, model_agreement, feature_snapshot AS engine,
            locked_at AS created_at
          FROM evaluation_predictions
          WHERE (
            (player1_id = $1 AND player2_id = $2) OR
            (player1_id = $2 AND player2_id = $1)
          )
          AND status = 'pending'
          AND locked_at > NOW() - INTERVAL '30 days'
          ORDER BY locked_at DESC
          LIMIT 1
        `, [player1Id, player2Id]);
        row = epRes.rows[0] ?? null;
      }

      if (!row) {
        return {
          player1Name, player2Name, selectedName, tournamentName: tournamentName ?? null, selectedSide,
          hasData: false,
          score: null as number | null,
          decision: "Caution" as const,
          reasons: ["No recent stored prediction — run a prediction for this matchup first"],
          checks: {} as Record<string, CheckResult>,
          winnerProb: null as number | null,
          calibratedProbabilityP1: null as number | null,
          marketImpliedProb: marketOdds ? parseFloat(((1 / marketOdds) * 100).toFixed(1)) : null,
          marketOdds: marketOdds ?? null,
          dataQuality: null, dataQualityLabel: null, upsetRisk: null, modelAgreement: null,
          dataStoredAt: null,
        };
      }

      storedP1Id = row.player1_id as string;
      const storedP1MatchesLegP1 = storedP1Id === player1Id;

      const calibP1 = parseFloat(String(row.calibrated_probability));
      // Orient probability to the selected player's side
      const winnerProb = (selectedIsP1 === storedP1MatchesLegP1)
        ? calibP1
        : 100 - calibP1;

      const eng = (row.engine as Record<string, unknown>) ?? {};
      const modelAgreement = (eng.modelAgreement as string | null) ?? (row.model_agreement as string | null) ?? "Unknown";
      const closenessTo50 = typeof eng.closenessTo50 === "number" ? eng.closenessTo50 : null;
      const upsetRisk = (row.upset_risk as string) ?? "UNKNOWN";

      const { score, reasons, checks } = computeSafetyScore({
        winnerProb,
        dataQuality: row.data_quality as number,
        dataQualityLabel: row.data_quality_label as string,
        upsetRisk,
        modelAgreement,
        closenessTo50,
        marketOdds: marketOdds ?? null,
      });

      return {
        player1Name, player2Name, selectedName, tournamentName: tournamentName ?? null, selectedSide,
        hasData: true,
        score,
        decision: getDecision(score),
        reasons,
        checks,
        winnerProb: parseFloat(winnerProb.toFixed(1)),
        calibratedProbabilityP1: parseFloat(calibP1.toFixed(1)),
        marketImpliedProb: marketOdds ? parseFloat(((1 / marketOdds) * 100).toFixed(1)) : null,
        marketOdds: marketOdds ?? null,
        dataQuality: row.data_quality as number,
        dataQualityLabel: row.data_quality_label as string,
        upsetRisk,
        modelAgreement,
        dataStoredAt: row.created_at,
      };
      } catch (legErr) {
        logger.error({ err: legErr, player1Name: leg.player1Name, player2Name: leg.player2Name }, "Per-leg evaluation error — returning Caution fallback");
        const { player1Name, player2Name, selectedSide, tournamentName, marketOdds } = leg;
        const selectedName = selectedSide === "1" ? player1Name : player2Name;
        return {
          player1Name, player2Name, selectedName, tournamentName: tournamentName ?? null, selectedSide,
          hasData: false, score: null as number | null, decision: "Caution" as const,
          reasons: ["Evaluation error — could not analyze this leg"],
          checks: {} as Record<string, CheckResult>,
          winnerProb: null as number | null, calibratedProbabilityP1: null as number | null,
          marketImpliedProb: marketOdds ? parseFloat(((1 / marketOdds) * 100).toFixed(1)) : null,
          marketOdds: marketOdds ?? null,
          dataQuality: null, dataQualityLabel: null, upsetRisk: null, modelAgreement: null,
          dataStoredAt: null,
        };
      }
    }));

    // Sort: Remove → Caution → Approved
    const sortOrder: Record<string, number> = { Remove: 0, Caution: 1, Approved: 2 };
    const sortedLegs = [...evaluatedLegs].sort((a, b) => sortOrder[a.decision] - sortOrder[b.decision]);

    const legsWithScores = evaluatedLegs.filter(l => l.score != null).map(l => ({ score: l.score as number, decision: l.decision }));
    const fragility = getSlipFragility(legsWithScores);

    // Correlation: multiple legs from same tournament
    const tGroups: Record<string, number> = {};
    for (const l of evaluatedLegs) {
      if (l.tournamentName) {
        const k = l.tournamentName.toLowerCase().trim();
        tGroups[k] = (tGroups[k] ?? 0) + 1;
      }
    }
    const correlated = Object.entries(tGroups).filter(([, c]) => c >= 2).map(([n]) => n);

    res.json({
      legs: sortedLegs,
      fragility,
      correlationWarning: correlated.length > 0
        ? `${correlated.map(n => n.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ")).join(", ")} — multiple legs from the same tournament are correlated`
        : null,
      removeCount: evaluatedLegs.filter(l => l.decision === "Remove").length,
      cautionCount: evaluatedLegs.filter(l => l.decision === "Caution").length,
      approvedCount: evaluatedLegs.filter(l => l.decision === "Approved").length,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Evaluation failed" });
  }
});

// ── POST /admin/parlay/validate (Task 105 — Independent Validation Engine) ────
//
// This route is the ONLY entry point for the Independent Validation Engine.
// It reads historical_matches directly and NEVER touches: predictions,
// evaluation_predictions, featureSnapshot, or any calibration output.

router.post("/admin/parlay/validate", requireAdmin, async (req, res): Promise<void> => {
  try {
    const { legs } = req.body as { legs: Array<BuilderSnapshot> };
    if (!Array.isArray(legs) || legs.length === 0) {
      res.status(400).json({ error: "legs must be a non-empty array" }); return;
    }
    if (legs.length > 150) {
      res.status(400).json({ error: "maximum 150 legs per validation" }); return;
    }

    const gradeOrder = ["Reject", "Weak", "Moderate", "Strong", "Elite"] as const;

    const results = await Promise.all(legs.map(async (leg) => {
      try {
        const result = await computeBuilderScore(leg);
        return {
          ...result,
          selectedPlayerName: leg.selectedPlayerName,
          opponentName: leg.opponentName,
          tournamentName: leg.tournamentName ?? null,
          surface: leg.surface ?? null,
        };
      } catch (e) {
        logger.error({ err: e, selectedPlayerName: leg.selectedPlayerName }, "Builder validation failed for leg — returning BORDERLINE fallback");
        return {
          selectedPlayerName: leg.selectedPlayerName,
          opponentName: leg.opponentName,
          tournamentName: leg.tournamentName ?? null,
          surface: leg.surface ?? null,
          validationScore: 50,
          riskScore: 65,
          matchupCloseness: 50,
          reliabilityGrade: "D" as const,
          parlayGrade: "Weak" as const,
          removalProbability: 65,
          decision: "BORDERLINE" as const,
          reasons: ["Validation service encountered an error — analysis incomplete"],
          criticalFlags: ["Validation error"],
          dataCoverage: 0,
          sourceAgreement: 50,
          sourcesAgreeing: 0,
          sourcesTotal: 0,
          factorScores: [] as Array<{ name: string; score: number; weight: number; available: boolean; contribution: number }>,
          builderVersion: "1.0.0",
        };
      }
    }));

    const keepCount = results.filter(r => r.decision === "KEEP").length;
    const borderlineCount = results.filter(r => r.decision === "BORDERLINE").length;
    const removeCount = results.filter(r => r.decision === "REMOVE").length;
    const avgValidationScore = Math.round(results.reduce((s, r) => s + r.validationScore, 0) / results.length);
    const avgRiskScore = Math.round(results.reduce((s, r) => s + r.riskScore, 0) / results.length);

    // Overall parlay grade: anchor to worst leg, blend up by average
    const gradeIndices = results.map(r => gradeOrder.indexOf(r.parlayGrade));
    const worstIdx = Math.min(...gradeIndices);
    const avgIdx = Math.round(gradeIndices.reduce((s, v) => s + v, 0) / gradeIndices.length);
    const overallParlayGrade = gradeOrder[Math.max(0, Math.min(4, Math.min(worstIdx + 1, avgIdx)))];

    // Persist session row — returns the id so leg outcome rows can reference it
    let sessionId: number | null = null;
    try {
      const sessionRow = await pool.query(
        `INSERT INTO parlay_builder_sessions (legs, summary) VALUES ($1::jsonb, $2::jsonb) RETURNING id`,
        [JSON.stringify(results), JSON.stringify({ keepCount, borderlineCount, removeCount, avgValidationScore, avgRiskScore, overallParlayGrade })]
      );
      sessionId = (sessionRow.rows[0] as { id: number } | undefined)?.id ?? null;
    } catch (err) {
      logger.error({ err }, "Failed to insert parlay_builder_sessions row");
    }

    // Per-leg outcome rows — PRIMARY calibration data source; log loudly on failure.
    // Unlike the session insert above, a silent swallow here means permanent data loss.
    try {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const leg = legs[i];
        await pool.query(
          `INSERT INTO parlay_leg_outcomes
             (session_id, selected_player_id, opponent_id, selected_player_name, opponent_name,
              tournament_name, surface, validation_score, risk_score, reliability_grade,
              parlay_grade, decision, data_coverage, source_agreement, factor_scores, market_odds,
                matchup_closeness, removal_probability)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)`,
          [
            sessionId,
            leg.selectedPlayerId,
            leg.opponentId,
            result.selectedPlayerName,
            result.opponentName,
            result.tournamentName ?? null,
            result.surface ?? null,
            result.validationScore,
            result.riskScore,
            result.reliabilityGrade,
            result.parlayGrade,
            result.decision,
            result.dataCoverage,
            result.sourceAgreement,
            JSON.stringify(result.factorScores),
            leg.marketOdds ?? null,
            result.matchupCloseness ?? null,
            result.removalProbability,
          ]
        );
      }
    } catch (err) {
      logger.error({ err, sessionId, legCount: results.length },
        "CALIBRATION DATA LOSS: failed to insert parlay_leg_outcomes — outcome tracking interrupted"
      );
    }

    res.json({
      legs: results,
      summary: { keepCount, borderlineCount, removeCount, avgValidationScore, avgRiskScore, overallParlayGrade },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Validation failed" });
  }
});

// ── GET /admin/parlay/backtest-legs ───────────────────────────────────────────

router.get("/admin/parlay/backtest-legs", requireAdmin, async (req, res): Promise<void> => {
  const search = typeof req.query.search === "string" ? req.query.search : "";
  const limit = Math.min(100, parseInt(typeof req.query.limit === "string" ? req.query.limit : "60") || 60);
  try {
    const params: unknown[] = [];
    let where = `WHERE status = 'graded' AND included_in_accuracy = true AND calibrated_probability IS NOT NULL`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (player1_name ILIKE $${params.length} OR player2_name ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(`
      SELECT id, player1_id, player2_id, player1_name, player2_name,
             calibrated_probability, data_quality, data_quality_label,
             upset_risk_tier, model_agreement, feature_snapshot,
             actual_winner_id, tournament_name, surface, scheduled_start_at,
             odds_player1_decimal, odds_player2_decimal
      FROM evaluation_predictions
      ${where}
      ORDER BY scheduled_start_at DESC
      LIMIT ${limit}
    `, params);
    res.json({ legs: rows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// ── POST /admin/parlay/backtest ───────────────────────────────────────────────

router.post("/admin/parlay/backtest", requireAdmin, async (req, res): Promise<void> => {
  const { legs } = req.body as {
    legs: Array<{ predictionId: number; selectedSide: "1" | "2"; marketOdds?: number | null }>;
  };
  if (!Array.isArray(legs) || legs.length === 0) { res.status(400).json({ error: "legs required" }); return; }
  try {
    const ids = legs.map(l => l.predictionId);
    const { rows } = await pool.query(`
      SELECT id, player1_id, player2_id, player1_name, player2_name,
             calibrated_probability, data_quality, data_quality_label,
             upset_risk_tier, model_agreement, feature_snapshot,
             actual_winner_id, tournament_name, surface, scheduled_start_at
      FROM evaluation_predictions
      WHERE id = ANY($1::int[])
    `, [ids]);

    const rowMap = new Map(rows.map(r => [r.id as number, r]));

    const evaluated = legs.map(leg => {
      const row = rowMap.get(leg.predictionId);
      if (!row) return { predictionId: leg.predictionId, error: "Not found", decision: "Caution" as const, score: 5, selectedWon: null as boolean | null };

      const selectedIsP1 = leg.selectedSide === "1";
      const eng = (row.feature_snapshot as Record<string, unknown>) ?? {};
      const calibP1 = parseFloat(String(row.calibrated_probability));
      const winnerProb = selectedIsP1 ? calibP1 : 100 - calibP1;
      const modelAgreement = (eng.modelAgreement as string | null) ?? (row.model_agreement as string | null) ?? "Unknown";
      const closenessTo50 = typeof eng.closenessTo50 === "number" ? eng.closenessTo50 : null;
      const upsetRisk = (row.upset_risk_tier as string) ?? "UNKNOWN";

      const { score, reasons, checks } = computeSafetyScore({
        winnerProb,
        dataQuality: row.data_quality as number,
        dataQualityLabel: row.data_quality_label as string,
        upsetRisk,
        modelAgreement,
        closenessTo50,
        marketOdds: leg.marketOdds ?? null,
      });

      const selectedWon = row.actual_winner_id == null ? null
        : (row.actual_winner_id === (selectedIsP1 ? row.player1_id : row.player2_id));

      return {
        predictionId: leg.predictionId,
        player1Name: row.player1_name as string,
        player2Name: row.player2_name as string,
        selectedName: selectedIsP1 ? (row.player1_name as string) : (row.player2_name as string),
        tournamentName: row.tournament_name as string | null,
        surface: row.surface as string | null,
        matchDate: row.scheduled_start_at,
        winnerProb: parseFloat(winnerProb.toFixed(1)),
        score, decision: getDecision(score), reasons, checks,
        selectedWon,
        dataQuality: row.data_quality as number,
        upsetRisk, modelAgreement,
      };
    });

    const withOutcomes = evaluated.filter(l => l.selectedWon !== null);
    const approved = withOutcomes.filter(l => l.decision === "Approved");
    const removed = withOutcomes.filter(l => l.decision === "Remove");
    const caution = withOutcomes.filter(l => l.decision === "Caution");
    const losses = withOutcomes.filter(l => !l.selectedWon);

    const lossCaptureRate = losses.length > 0 ? parseFloat((losses.filter(l => l.decision !== "Approved").length / losses.length * 100).toFixed(1)) : null;
    const falseRemovalRate = removed.length > 0 ? parseFloat((removed.filter(l => l.selectedWon).length / removed.length * 100).toFixed(1)) : null;
    const approvedAccuracy = approved.length > 0 ? parseFloat((approved.filter(l => l.selectedWon).length / approved.length * 100).toFixed(1)) : null;
    const filteredProbs = withOutcomes.filter(l => l.decision !== "Remove").map(l => ((l.winnerProb ?? 50) / 100));
    const allProbs = withOutcomes.map(l => ((l.winnerProb ?? 50) / 100));
    const survivalImprovement = parseFloat(((filteredProbs.reduce((p, v) => p * v, 1) - allProbs.reduce((p, v) => p * v, 1)) * 100).toFixed(1));

    res.json({
      legs: evaluated,
      metrics: { lossCaptureRate, falseRemovalRate, approvedAccuracy, survivalImprovement, totalLegs: evaluated.length, removeCount: removed.length, cautionCount: caution.length, approvedCount: approved.length },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Backtest failed" });
  }
});

// ── GET /admin/parlay/calibration ─────────────────────────────────────────────
//
// Returns calibration bucket data from parlay_leg_outcomes for the UI dashboard.
// Includes per-decile validation-score buckets, per-decision-tier stats,
// per-parlay-grade stats, and a before/after REMOVE-filter comparison.

router.get("/admin/parlay/calibration", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const { rows } = await pool.query<{
      id: number;
      selected_player_id: string;
      validation_score: number;
      risk_score: number;
      decision: string;
      parlay_grade: string;
      reliability_grade: string;
      data_coverage: number;
      source_agreement: number;
      actual_winner_id: string | null;
      source: string;
    }>(`
      SELECT id, selected_player_id, validation_score, risk_score,
             decision, parlay_grade, reliability_grade,
             data_coverage, source_agreement, actual_winner_id, source
      FROM parlay_leg_outcomes
      WHERE actual_winner_id IS NOT NULL
      ORDER BY created_at ASC
    `);

    if (rows.length === 0) {
      res.json({
        summary: null,
        buckets: [],
        decisionTiers: [],
        parlayGrades: [],
        message: "No resolved legs yet — run the historical backfill first.",
      });
      return;
    }

    const legs = rows.map(r => ({
      ...r,
      won: r.actual_winner_id === r.selected_player_id,
    }));

    const total = legs.length;
    const wins = legs.filter(l => l.won).length;
    const overallWinRate = parseFloat(((wins / total) * 100).toFixed(1));

    // Per validation-score decile (0–10, 10–20, …, 90–100)
    const buckets = [];
    for (let lo = 0; lo < 100; lo += 10) {
      const hi = lo + 10;
      const bucket = legs.filter(l => l.validation_score >= lo && l.validation_score < hi);
      const bWins = bucket.filter(l => l.won).length;
      buckets.push({
        range: `${lo}–${hi}`,
        lo, hi,
        count: bucket.length,
        wins: bWins,
        losses: bucket.length - bWins,
        winRate: bucket.length > 0 ? parseFloat(((bWins / bucket.length) * 100).toFixed(1)) : null,
        expected: lo + 5, // midpoint as % — visual diagonal reference
      });
    }

    // Per decision tier
    const decisionTiers = (["KEEP", "BORDERLINE", "REMOVE"] as const).map(tier => {
      const g = legs.filter(l => l.decision === tier);
      const gWins = g.filter(l => l.won).length;
      return {
        decision: tier,
        count: g.length,
        wins: gWins,
        losses: g.length - gWins,
        winRate: g.length > 0 ? parseFloat(((gWins / g.length) * 100).toFixed(1)) : null,
        avgValidation: g.length > 0 ? Math.round(g.reduce((s, l) => s + l.validation_score, 0) / g.length) : null,
        avgRisk: g.length > 0 ? Math.round(g.reduce((s, l) => s + l.risk_score, 0) / g.length) : null,
      };
    });

    // Per parlay grade
    const parlayGrades = (["Elite", "Strong", "Moderate", "Weak", "Reject"] as const).map(grade => {
      const g = legs.filter(l => l.parlay_grade === grade);
      const gWins = g.filter(l => l.won).length;
      return {
        grade,
        count: g.length,
        wins: gWins,
        losses: g.length - gWins,
        winRate: g.length > 0 ? parseFloat(((gWins / g.length) * 100).toFixed(1)) : null,
      };
    });

    // Before vs after REMOVE filter
    const kept = legs.filter(l => l.decision !== "REMOVE");
    const removed = legs.filter(l => l.decision === "REMOVE");
    const keptWins = kept.filter(l => l.won).length;
    const removedWins = removed.filter(l => l.won).length;
    const filteredWinRate = kept.length > 0 ? parseFloat(((keptWins / kept.length) * 100).toFixed(1)) : null;
    const removedWinRate = removed.length > 0 ? parseFloat(((removedWins / removed.length) * 100).toFixed(1)) : null;
    const keepTier = decisionTiers.find(t => t.decision === "KEEP");
    const removeTier = decisionTiers.find(t => t.decision === "REMOVE");
    const keepVsRemoveSeparation =
      keepTier?.winRate != null && removeTier?.winRate != null
        ? parseFloat((keepTier.winRate - removeTier.winRate).toFixed(1))
        : null;

    // REMOVE-filter loss-capture rate: what fraction of losses are REMOVE decisions?
    const losses = legs.filter(l => !l.won);
    const removedLosses = removed.filter(l => !l.won);
    const lossCaptureRate = losses.length > 0 ? parseFloat(((removedLosses.length / losses.length) * 100).toFixed(1)) : null;
    const falseRemovalRate = removed.length > 0 ? parseFloat(((removedWins / removed.length) * 100).toFixed(1)) : null;

    // Backfill vs live split
    const backfillCount = legs.filter(l => l.source === "backfill").length;
    const liveCount = legs.filter(l => l.source !== "backfill").length;

    res.json({
      summary: {
        totalLegs: total,
        backfillLegs: backfillCount,
        liveLegs: liveCount,
        overallWinRate,
        filteredWinRate,
        removedWinRate,
        removeFilterImprovement: filteredWinRate != null ? parseFloat((filteredWinRate - overallWinRate).toFixed(1)) : null,
        keepVsRemoveSeparation,
        lossCaptureRate,
        falseRemovalRate,
        keepCount: keepTier?.count ?? 0,
        borderlineCount: decisionTiers.find(t => t.decision === "BORDERLINE")?.count ?? 0,
        removeCount: removeTier?.count ?? 0,
      },
      buckets,
      decisionTiers,
      parlayGrades,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Calibration query failed" });
  }
});

// ── POST /admin/parlay/backfill ────────────────────────────────────────────────
//
// Triggers the historical parlay backfill in the background (responds immediately).
// Scores graded evaluation_predictions through the Parlay Builder engine and
// inserts results into parlay_leg_outcomes with temporal isolation (asOfDate).

let parlayBackfillRunning = false;
let parlayBackfillLastResult: { inserted: number; skipped: number; errors: number; finishedAt: string } | null = null;

router.post("/admin/parlay/backfill", requireAdmin, (req, res): void => {
  if (parlayBackfillRunning) {
    res.json({ started: false, message: "Backfill already running" });
    return;
  }

  const limit  = typeof req.body?.limit  === "number" ? req.body.limit  : 500;
  const minDate = typeof req.body?.minDate === "string" ? req.body.minDate : "2022-01-01";

  parlayBackfillRunning = true;
  res.json({ started: true, limit, minDate });

  // Run fully in the background — import lazily to avoid circular deps
  void (async () => {
    const { computeBuilderScore } = await import("../services/parlayBuilder/builderScoringService.js");
    const client = await pool.connect();
    let inserted = 0, skipped = 0, errors = 0;
    try {
      const { rows: existing } = await client.query<{ backfill_match_id: number }>(
        `SELECT backfill_match_id FROM parlay_leg_outcomes WHERE backfill_match_id IS NOT NULL`
      );
      const alreadyDone = new Set(existing.map(r => r.backfill_match_id));

      const { rows: candidates } = await client.query(`
        SELECT id, player1_id, player2_id, player1_name, player2_name,
               actual_winner_id, scheduled_start_at, surface, tournament_name,
               odds_player1_decimal, odds_player2_decimal,
               calibrated_probability
        FROM evaluation_predictions
        WHERE actual_winner_id IS NOT NULL
          AND player1_id IS NOT NULL AND player2_id IS NOT NULL
          AND player1_name IS NOT NULL AND player2_name IS NOT NULL
          AND scheduled_start_at IS NOT NULL
          AND player1_name NOT LIKE 'wf-player%'
          AND scheduled_start_at >= $1
          AND calibrated_probability IS NOT NULL
          AND calibrated_probability != 50
        ORDER BY scheduled_start_at ASC
        LIMIT $2
      `, [minDate, limit + alreadyDone.size]);

      const toProcess = candidates.filter((r: { id: number }) => !alreadyDone.has(r.id)).slice(0, limit);
      logger.info({ total: toProcess.length }, "Parlay backfill started (using model-predicted winner as selected player)");

      for (const match of toProcess) {
        const asOfDate = new Date(match.scheduled_start_at);
        try {
          const { rows: dup } = await client.query(
            `SELECT 1 FROM parlay_leg_outcomes WHERE backfill_match_id = $1 LIMIT 1`, [match.id]
          );
          if (dup.length > 0) { skipped++; continue; }

          // Use the model's predicted winner as the selected player (calibrated_probability > 50 → player1 wins).
          // This gives a realistic baseline: the calibration test is "does our KEEP filter help
          // when the user backs the model's recommended pick?"
          const modelPicksP1 = (match.calibrated_probability ?? 50) > 50;
          const selectedPlayerId   = modelPicksP1 ? match.player1_id   : match.player2_id;
          const selectedPlayerName = modelPicksP1 ? match.player1_name : match.player2_name;
          const opponentId         = modelPicksP1 ? match.player2_id   : match.player1_id;
          const opponentName       = modelPicksP1 ? match.player2_name : match.player1_name;
          const marketOdds         = modelPicksP1 ? (match.odds_player1_decimal ?? null)
                                                  : (match.odds_player2_decimal ?? null);

          const result = await computeBuilderScore({
            selectedPlayerId, selectedPlayerName,
            opponentId, opponentName,
            surface: match.surface, tournamentName: match.tournament_name,
            marketOdds,
            asOfDate,
          });

          await client.query(
            `INSERT INTO parlay_leg_outcomes
               (session_id, selected_player_id, opponent_id, selected_player_name, opponent_name,
                tournament_name, surface, validation_score, risk_score, reliability_grade,
                parlay_grade, decision, data_coverage, source_agreement, factor_scores,
                market_odds, actual_winner_id, resolved_at, source, backfill_match_id,
                 matchup_closeness, removal_probability)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,'backfill',$19,$20,$21)`,
            [null, selectedPlayerId, opponentId, selectedPlayerName, opponentName,
             match.tournament_name ?? null, match.surface ?? null,
             result.validationScore, result.riskScore, result.reliabilityGrade,
             result.parlayGrade, result.decision, result.dataCoverage, result.sourceAgreement,
             JSON.stringify(result.factorScores), marketOdds,
             match.actual_winner_id, asOfDate, match.id,
             result.matchupCloseness ?? null, result.removalProbability]
          );
          inserted++;
        } catch (err) {
          logger.warn({ matchId: match.id, err }, "Parlay backfill row error");
          errors++;
        }
      }
    } finally {
      client.release();
      parlayBackfillRunning = false;
      parlayBackfillLastResult = { inserted, skipped, errors, finishedAt: new Date().toISOString() };
      logger.info(parlayBackfillLastResult, "Parlay backfill complete");
    }
  })();
});

router.get("/admin/parlay/backfill/status", requireAdmin, (_req, res): void => {
  res.json({ running: parlayBackfillRunning, lastResult: parlayBackfillLastResult });
});

// ── Screenshot Import Service — Health & Cache endpoints ─────────────────────

/**
 * GET /api/admin/screenshot-import/health
 * Returns live health state for every OCR provider and image cache statistics.
 */
router.get("/screenshot-import/health", requireAdmin, (_req, res): void => {
  // Lazy import — the service module is ESM, same process
  import("../services/screenshotImport/ScreenshotImportService.js").then(({ screenshotImportService }) => {
    res.json(screenshotImportService.getProviderHealthReport());
  }).catch((err) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load service" });
  });
});

/**
 * POST /api/admin/screenshot-import/cache/clear
 * Clears the in-memory image hash cache. Useful after updating an OCR provider key
 * or when forcing fresh re-extraction of already-processed images.
 */
router.post("/screenshot-import/cache/clear", requireAdmin, (_req, res): void => {
  import("../services/screenshotImport/ScreenshotImportService.js").then(({ screenshotImportService }) => {
    screenshotImportService.clearCache();
    res.json({ ok: true, message: "Screenshot import cache cleared" });
  }).catch((err) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load service" });
  });
});

/**
 * POST /api/admin/screenshot-import/health/reset/:label
 * Resets a provider's health state to "healthy" (e.g. after adding a new quota).
 */
router.post("/screenshot-import/health/reset/:label", requireAdmin, (req, res): void => {
  const label = String(req.params["label"] ?? "");
  import("../services/screenshotImport/providerHealthMonitor.js").then(({ resetProviderHealth }) => {
    resetProviderHealth(label);
    res.json({ ok: true, label });
  }).catch((err) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  });
});

// ── Saved Parlay Legs ─────────────────────────────────────────────────────────
// Separate from parlay_leg_outcomes (calibration). These are user-bookmarked
// BuilderLegResult snapshots for the "Saved Parlays" folder in the UI.

router.get("/admin/parlay/saved-legs", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, saved_at, leg_payload FROM parlay_saved_legs ORDER BY saved_at DESC`
    );
    res.json({ legs: rows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.post("/admin/parlay/saved-legs", requireAdmin, async (req, res): Promise<void> => {
  const { legPayload } = req.body as { legPayload: unknown };
  if (!legPayload || typeof legPayload !== "object") {
    res.status(400).json({ error: "legPayload required" });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO parlay_saved_legs (leg_payload) VALUES ($1::jsonb) RETURNING id, saved_at`,
      [JSON.stringify(legPayload)]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.delete("/admin/parlay/saved-legs/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  try {
    await pool.query(`DELETE FROM parlay_saved_legs WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.delete("/admin/parlay/saved-legs", requireAdmin, async (_req, res): Promise<void> => {
  try {
    await pool.query(`DELETE FROM parlay_saved_legs`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// ── Active Parlay Session ─────────────────────────────────────────────────────
// Single-row (id=1 singleton) store for the in-progress parlay session.
// Survives browser close / device switches for the single-owner admin model.

router.get("/admin/parlay/session", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT session_payload FROM parlay_active_session WHERE id = 1`
    );
    res.json(rows[0]?.session_payload ?? null);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

router.put("/admin/parlay/session", requireAdmin, async (req, res): Promise<void> => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "payload required" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO parlay_active_session (id, session_payload, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET session_payload = EXCLUDED.session_payload, updated_at = now()`,
      [JSON.stringify(payload)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// ── Parlay History ────────────────────────────────────────────────────────────
// Reads from parlay_leg_outcomes (the calibration/backfill table) — read-only.
// The write path for that table is unchanged (adminParlay /validate + backfill routes).

router.get("/admin/parlay/history", requireAdmin, async (req, res): Promise<void> => {
  const limit = Math.min(200, parseInt(typeof req.query.limit === "string" ? req.query.limit : "100") || 100);
  const offset = parseInt(typeof req.query.offset === "string" ? req.query.offset : "0") || 0;
  try {
    const { rows } = await pool.query(`
      SELECT id, selected_player_name, opponent_name, tournament_name, surface,
             validation_score, risk_score, reliability_grade, parlay_grade, decision,
             data_coverage, source_agreement, removal_probability, matchup_closeness, market_odds, source,
             actual_winner_id, selected_player_id,
             created_at, resolved_at
      FROM parlay_leg_outcomes
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const { rows: [countRow] } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM parlay_leg_outcomes`
    );
    res.json({ legs: rows, total: parseInt(countRow?.count ?? "0") });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// Read-only bridge to the shared predictions store. This does not invoke the prediction engine
// or parlay scoring logic; it only returns the latest stored engine winner for each requested leg.
router.get("/admin/parlay/engine-agreement", requireAdmin, async (req, res): Promise<void> => {
  const rawLegs = typeof req.query.legs === "string" ? req.query.legs : "[]";
  let requestedLegs: Array<{ key: string; player1Id: string | null; player2Id: string | null }>;
  try {
    const parsed: unknown = JSON.parse(rawLegs);
    if (!Array.isArray(parsed)) throw new Error("legs must be an array");
    requestedLegs = parsed.filter((leg): leg is { key: string; player1Id: string | null; player2Id: string | null } =>
      typeof leg === "object" && leg !== null &&
      typeof (leg as { key?: unknown }).key === "string" &&
      (typeof (leg as { player1Id?: unknown }).player1Id === "string" || (leg as { player1Id?: unknown }).player1Id == null) &&
      (typeof (leg as { player2Id?: unknown }).player2Id === "string" || (leg as { player2Id?: unknown }).player2Id == null)
    );
  } catch {
    res.status(400).json({ error: "Invalid legs query" });
    return;
  }

  try {
    const rows = await Promise.all(requestedLegs.map(async leg => {
      if (!leg.player1Id || !leg.player2Id) return { key: leg.key, predictedWinnerId: null };
      const { rows: matches } = await pool.query<{ predicted_winner_id: string }>(
        `SELECT predicted_winner_id
           FROM predictions
          WHERE (player1_id = $1 AND player2_id = $2)
             OR (player1_id = $2 AND player2_id = $1)
          ORDER BY created_at DESC
          LIMIT 1`,
        [leg.player1Id, leg.player2Id]
      );
      return { key: leg.key, predictedWinnerId: matches[0]?.predicted_winner_id ?? null };
    }));
    res.json({ predictions: rows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to read engine predictions" });
  }
});

export default router;
