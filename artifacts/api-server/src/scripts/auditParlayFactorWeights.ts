/**
 * auditParlayFactorWeights.ts — Parlay Builder Factor Weight Ablation
 *
 * Derives empirically-backed weights for DEFAULT_WEIGHTS in builderScoringService.ts
 * by running a leave-one-out ablation over parlay_leg_outcomes backfill rows.
 *
 * Methodology:
 *   1. Report per-factor data coverage (how many rows have non-neutral data).
 *   2. Directional edge: win_rate(factor agrees with pick) − win_rate(factor disagrees).
 *      A factor with positive edge correctly confirms the model's picks; negative edge
 *      means it's inverting signal (reduce/remove).
 *   3. Leave-one-out: re-score each training row without factor X (recomputing
 *      sourceAgreement from remaining factors), check whether the revised validationScore
 *      changes the KEEP/BORDERLINE/REMOVE decision AND whether accuracy changes.
 *   4. Derive new weights proportional to measured edge magnitude; normalize to 1.0.
 *   5. Validate on held-out 20% slice: overall win rate vs. 53.3% baseline.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/auditParlayFactorWeights.ts
 *
 * Optional env vars:
 *   MIN_DATE=2020-01-01   restrict training rows to a date range
 *   MIN_FACTOR_N=30       minimum non-neutral rows to include a factor in ablation (default 30)
 */

import { pool } from "@workspace/db";

const MIN_FACTOR_N = parseInt(process.env["MIN_FACTOR_N"] ?? "30");

// ---------------------------------------------------------------------------
// Prior (hand-set) weights from commit c075d53, before the Aug-2026 ablation.
// Used only in Step 5b's isolated old-vs-new comparison.
// ---------------------------------------------------------------------------
const PRIOR_WEIGHTS: Record<string, number> = {
  overallAdvantage:      0.18,
  surfaceAdvantage:      0.10,
  utr:                   0.10,
  recentForm:            0.10,
  surfaceRecord:         0.08,
  serveAdvantage:        0.06,
  returnAdvantage:       0.06,
  holdBreak:             0.05,
  strengthOfSchedule:    0.05,
  marketConsensus:       0.05,
  currentRanking:        0.04,
  headToHead:            0.03,
  travelFatigue:         0.03,
  injuryRisk:            0.03,
  tournamentExperience:  0.02,
  historicalConsistency: 0.02,
  historicalVolatility:  0.02,
  dataQuality:           0.02,
  sourceAgreement:       0.06,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredFactor {
  key: string;
  label: string;
  score: number;
  weight: number;
  status: "available" | "unavailable" | "limited";
  supportsSelected: boolean | null;
}

interface LegRow {
  id: number;
  selected_player_id: string;
  actual_winner_id: string;
  validation_score: number;
  risk_score: number;
  reliability_grade: string;
  data_coverage: number;
  factor_scores: StoredFactor[];
  created_at: Date;
  decision: string;
  parlay_grade: string;
}

interface AnnotatedLeg extends LegRow {
  won: boolean;
}

// ---------------------------------------------------------------------------
// Scoring helpers (mirror of builderScoringService.ts)
// ---------------------------------------------------------------------------

/** Structural unavailable factors: weight counts in total but score never activates.
 * utr and holdBreak removed from DEFAULT_WEIGHTS 2026-08-11 — no longer tracked as structural.
 * serveAdvantage/returnAdvantage are now computed, so they are variable (not structural) too.
 * Empty set means all unavailability is genuine variable-data absence, not structural gaps. */
const STRUCTURAL_UNAVAILABLE = new Set<string>([]);
const STRUCTURAL_MAX_UNAVAIL_WEIGHT = 0.0; // no permanently-unavailable factors remain

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Re-compute validationScore from a factor array, optionally excluding one factor key. */
function computeScoreWithout(
  factors: StoredFactor[],
  excludeKey: string | null = null,
): { validationScore: number; dataCoverage: number } {
  // Build the factor list excluding the target + the old sourceAgreement (we'll recompute it)
  const base = factors.filter(
    f => f.key !== "sourceAgreement" && (excludeKey === null || f.key !== excludeKey),
  );

  // Re-derive sourceAgreement if we're not excluding it
  let sourceAgreementFactor: StoredFactor | null = null;
  if (excludeKey !== "sourceAgreement") {
    const opinionated = base.filter(
      f => f.status !== "unavailable" && f.supportsSelected !== null,
    );
    const agreeing = opinionated.filter(f => f.supportsSelected === true).length;
    const available = opinionated.length;
    const agreementRate = available > 0 ? agreeing / available : 0.5;
    const saScore = clamp(
      50 + Math.round((2 * agreementRate - 1) * 100),
      0,
      100,
    );
    sourceAgreementFactor = {
      key: "sourceAgreement",
      label: "Source Agreement",
      score: saScore,
      weight: 0.06, // DEFAULT_WEIGHTS.sourceAgreement
      status: "available",
      supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null,
    };
  }

  const allFactors = sourceAgreementFactor ? [...base, sourceAgreementFactor] : base;
  const availF = allFactors.filter(f => f.status !== "unavailable");
  const totalW = availF.reduce((s, f) => s + f.weight, 0);
  const validationScore = totalW > 0
    ? Math.round(availF.reduce((s, f) => s + f.score * (f.weight / totalW), 0))
    : 50;

  // dataCoverage (simplified: no structural-unavailable floor since utr/holdBreak removed)
  const unavailW = allFactors.filter(f => f.status === "unavailable").reduce((s, f) => s + f.weight, 0);
  const dataCoverage = clamp(Math.round((1 - unavailW) * 100), 0, 100);

  return { validationScore, dataCoverage };
}

/** Derive decision from scores (mirrors toDecision in builderScoringService). */
function toDecision(
  validationScore: number,
  riskScore: number,
  reliabilityGrade: string,
  dataCoverage: number,
): string {
  if (reliabilityGrade === "F" || validationScore <= 33 || riskScore >= 70) return "REMOVE";
  if (validationScore >= 58 && riskScore <= 44 && reliabilityGrade !== "D" && dataCoverage >= 50) return "KEEP";
  return "BORDERLINE";
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function winRate(legs: AnnotatedLeg[]): number {
  if (legs.length === 0) return NaN;
  return legs.filter(l => l.won).length / legs.length;
}

function pct(v: number): string {
  if (isNaN(v)) return "   n/a";
  return `${(v * 100).toFixed(1).padStart(5)}%`;
}

function ppDelta(a: number, b: number): string {
  if (isNaN(a) || isNaN(b)) return "   n/a";
  const d = (a - b) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp`;
}

function bar(v: number, width = 16): string {
  if (isNaN(v)) return "░".repeat(width);
  const filled = Math.round(clamp(v, 0, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<LegRow>(`
      SELECT id, selected_player_id, actual_winner_id,
             validation_score, risk_score, reliability_grade,
             data_coverage, factor_scores, created_at, decision, parlay_grade
      FROM parlay_leg_outcomes
      WHERE actual_winner_id IS NOT NULL
        AND factor_scores IS NOT NULL
        AND jsonb_array_length(factor_scores) > 0
      ORDER BY created_at ASC
    `);

    const total = rows.length;
    if (total < 50) {
      console.log(`Only ${total} resolved legs with factor data — run the parlay backfill first.`);
      console.log("POST /api/admin/parlay/backfill with {\"limit\": 10000, \"minDate\": \"2015-01-01\"}");
      return;
    }

    const legs: AnnotatedLeg[] = rows.map(r => ({
      ...r,
      won: r.actual_winner_id === r.selected_player_id,
    }));

    // Chronological 80/20 train/held-out split
    const splitIdx = Math.floor(total * 0.8);
    const train = legs.slice(0, splitIdx);
    const heldOut = legs.slice(splitIdx);

    const overallWR = winRate(legs);
    const trainWR = winRate(train);
    const heldOutWR = winRate(heldOut);

    console.log(`\n${"═".repeat(80)}`);
    console.log(` PARLAY BUILDER — FACTOR WEIGHT ABLATION`);
    console.log(`${"═".repeat(80)}`);
    console.log(` Total resolved legs:   ${total}`);
    console.log(` Training rows:         ${train.length}  (80%, chronological)`);
    console.log(` Held-out rows:         ${heldOut.length}  (20%, chronological)`);
    console.log(` Overall win rate:      ${pct(overallWR)}`);
    console.log(` Training win rate:     ${pct(trainWR)}`);
    console.log(` Held-out win rate:     ${pct(heldOutWR)}`);
    console.log(` Prior baseline:        53.3%  (1,500-row backfill, July 2026)`);
    console.log(`${"═".repeat(80)}\n`);

    // ── Step 1: Factor coverage report ─────────────────────────────────────
    console.log("── STEP 1: Factor Coverage (how many rows have real, non-neutral data) ──");
    console.log(` ${"Factor".padEnd(26)} ${"Weight".padStart(6)} ${"n_real".padStart(7)} ${"n_agrees".padStart(9)} ${"n_disagrees".padStart(12)} ${"n_neutral".padStart(10)} ${"Coverage".padStart(9)}`);
    console.log(` ${"─".repeat(26)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(9)} ${"─".repeat(12)} ${"─".repeat(10)} ${"─".repeat(9)}`);

    // Collect all unique factor keys
    const allKeys = new Set<string>();
    for (const leg of train) {
      for (const f of leg.factor_scores) allKeys.add(f.key);
    }

    interface FactorStats {
      key: string;
      label: string;
      weight: number;
      nReal: number;       // rows where supportsSelected !== null
      nAgrees: number;     // supportsSelected === true
      nDisagrees: number;  // supportsSelected === false
      nNeutral: number;    // supportsSelected === null (includes unavailable + 48-52 neutral)
      agreesWR: number;
      disagreesWR: number;
      edge: number;        // agreesWR - disagreesWR
      structural: boolean;
    }

    const factorStats: FactorStats[] = [];

    for (const key of Array.from(allKeys).sort()) {
      const agreesLegs: AnnotatedLeg[] = [];
      const disagreesLegs: AnnotatedLeg[] = [];
      let nReal = 0, nNeutral = 0, weight = 0, label = key;

      for (const leg of train) {
        const f = leg.factor_scores.find(x => x.key === key);
        if (!f) { nNeutral++; continue; }
        weight = f.weight;
        label = f.label;
        if (f.supportsSelected === true) { nReal++; agreesLegs.push(leg); }
        else if (f.supportsSelected === false) { nReal++; disagreesLegs.push(leg); }
        else nNeutral++;
      }

      const aWR = winRate(agreesLegs);
      const dWR = winRate(disagreesLegs);
      const edge = isNaN(aWR) || isNaN(dWR) ? NaN : aWR - dWR;
      const coverage = nReal / train.length;

      factorStats.push({
        key, label, weight,
        nReal, nAgrees: agreesLegs.length, nDisagrees: disagreesLegs.length, nNeutral,
        agreesWR: aWR, disagreesWR: dWR,
        edge,
        structural: STRUCTURAL_UNAVAILABLE.has(key),
      });

      const coverageStr = `${(coverage * 100).toFixed(1).padStart(4)}%`;
      const structLabel = STRUCTURAL_UNAVAILABLE.has(key) ? "★STRUCT" : "";
      console.log(
        ` ${(label.slice(0, 25)).padEnd(26)}` +
        ` ${weight.toFixed(2).padStart(6)}` +
        ` ${String(nReal).padStart(7)}` +
        ` ${String(agreesLegs.length).padStart(9)}` +
        ` ${String(disagreesLegs.length).padStart(12)}` +
        ` ${String(nNeutral).padStart(10)}` +
        ` ${coverageStr.padStart(9)}` +
        (structLabel ? `  ${structLabel}` : ""),
      );
    }

    // ── Step 2: Directional edge per factor ────────────────────────────────
    console.log(`\n── STEP 2: Directional Edge (agrees win rate − disagrees win rate) ─────`);
    console.log(` ${"Factor".padEnd(26)} ${"n≥min?".padStart(7)} ${"Agrees WR".padStart(10)} ${"Disagree WR".padStart(12)} ${"Edge".padStart(9)} ${"Signal".padStart(8)} │ Bar`);
    console.log(` ${"─".repeat(26)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(12)} ${"─".repeat(9)} ${"─".repeat(8)} ┼ ${"─".repeat(20)}`);

    const baselineWR = trainWR;
    const edgeSignificant: FactorStats[] = [];

    for (const fs of factorStats.sort((a, b) => {
      // Sort by edge magnitude descending, NaN last
      if (isNaN(a.edge)) return 1;
      if (isNaN(b.edge)) return -1;
      return Math.abs(b.edge) - Math.abs(a.edge);
    })) {
      const hasEnoughData = fs.nReal >= MIN_FACTOR_N;
      const signal =
        !hasEnoughData ? "THIN    " :
        isNaN(fs.edge) ? "NO DATA " :
        fs.edge >= 0.08 ? "STRONG+ " :
        fs.edge >= 0.03 ? "MILD+   " :
        fs.edge >= -0.03 ? "FLAT    " :
        fs.edge >= -0.08 ? "MILD−   " :
        "STRONG− ";

      if (hasEnoughData && !isNaN(fs.edge)) edgeSignificant.push(fs);

      console.log(
        ` ${fs.label.slice(0, 25).padEnd(26)}` +
        ` ${(hasEnoughData ? "✓" : `n=${fs.nReal}`).padStart(7)}` +
        ` ${pct(fs.agreesWR).padStart(10)}` +
        ` ${pct(fs.disagreesWR).padStart(12)}` +
        ` ${ppDelta(fs.agreesWR, fs.disagreesWR).padStart(9)}` +
        ` ${signal.padStart(8)}` +
        ` │ ${bar(isNaN(fs.agreesWR) ? 0.5 : fs.agreesWR)}`,
      );
    }

    // ── Step 3: Leave-one-out ablation ─────────────────────────────────────
    console.log(`\n── STEP 3: Leave-One-Out Ablation (re-score training rows without each factor) ─`);
    console.log(` ${"Factor".padEnd(26)} ${"Base acc".padStart(9)} ${"LOO acc".padStart(9)} ${"Δacc".padStart(8)} ${"KEEP→change".padStart(12)} ${"REMOVE→change".padStart(14)}`);
    console.log(` ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(14)}`);

    const baseAccTrain = trainWR;

    for (const fs of factorStats.sort((a, b) => a.label.localeCompare(b.label))) {
      if (fs.structural) continue; // structurally unavailable — skip LOO
      if (fs.nReal < 10) continue; // too few rows to matter

      let correctWith = 0, correctWithout = 0;
      let keepChanges = 0, removeChanges = 0;
      const looLegs = train.filter(l => l.factor_scores.some(f => f.key === fs.key));

      for (const leg of looLegs) {
        const decisionWith = leg.decision;
        const { validationScore: newVS, dataCoverage: newDC } = computeScoreWithout(leg.factor_scores, fs.key);
        const decisionWithout = toDecision(newVS, leg.risk_score, leg.reliability_grade, newDC);

        if (leg.won) correctWith++;
        if ((decisionWithout === "KEEP") === (decisionWith === "KEEP") ? leg.won : !leg.won) {
          // Use simple accuracy metric: did the selected player win?
          // Re-derive: if removing factor doesn't change decision, outcome is same
        }
        if (decisionWith !== decisionWithout) {
          if (decisionWith === "KEEP" || decisionWithout === "KEEP") keepChanges++;
          if (decisionWith === "REMOVE" || decisionWithout === "REMOVE") removeChanges++;
        }
      }

      // Simpler approach: overall accuracy doesn't change (we're not filtering on decision)
      // The decision change is the metric. Also compute win rate among KEEP rows with/without
      const keepWithLegs = looLegs.filter(l => l.decision === "KEEP");
      const keepWithoutLegs = looLegs.filter(l => {
        const { validationScore: newVS, dataCoverage: newDC } = computeScoreWithout(l.factor_scores, fs.key);
        return toDecision(newVS, l.risk_score, l.reliability_grade, newDC) === "KEEP";
      });

      const keepWRWith = winRate(keepWithLegs);
      const keepWRWithout = winRate(keepWithoutLegs);

      console.log(
        ` ${fs.label.slice(0, 25).padEnd(26)}` +
        ` ${pct(keepWRWith).padStart(9)}` +
        ` ${pct(keepWRWithout).padStart(9)}` +
        ` ${ppDelta(keepWRWithout, keepWRWith).padStart(8)}` +
        ` ${String(keepChanges).padStart(12)}` +
        ` ${String(removeChanges).padStart(14)}`,
      );
    }

    // ── Step 4: Derived weight recommendations ─────────────────────────────
    console.log(`\n── STEP 4: Derived Weight Recommendations ────────────────────────────────`);
    console.log(` (Based on directional edge. Structural-unavailable factors kept at spec weight.)`);
    console.log(` ${"Factor".padEnd(26)} ${"Old Weight".padStart(11)} ${"Edge".padStart(9)} ${"New Weight".padStart(11)} ${"Action".padStart(10)}`);
    console.log(` ${"─".repeat(26)} ${"─".repeat(11)} ${"─".repeat(9)} ${"─".repeat(11)} ${"─".repeat(10)}`);

    // Weight derivation:
    //   - Structural unavailable: keep as-is (they're in the spec, even if unavailable)
    //   - Factors with insufficient data (n < MIN_FACTOR_N): keep as-is (can't decide)
    //   - Factors with negative edge: set to 0.005 (minimal — keep in schema but near-zero)
    //   - Factors with positive edge: scale proportionally to edge magnitude, min 0.01
    //   - sourceAgreement: meta-factor, keep at 0.06 unless edge is clearly negative

    const newWeights: Record<string, number> = {};

    // First pass: assign raw weights
    for (const fs of factorStats) {
      if (fs.structural) {
        newWeights[fs.key] = fs.weight; // keep as spec
        continue;
      }
      if (fs.nReal < MIN_FACTOR_N || isNaN(fs.edge)) {
        newWeights[fs.key] = fs.weight; // insufficient data — keep old
        continue;
      }
      if (fs.edge < -0.03) {
        newWeights[fs.key] = 0.005; // strong negative → near-zero
      } else if (fs.edge < 0.03) {
        newWeights[fs.key] = Math.max(0.01, fs.weight * 0.5); // flat → halve
      } else if (fs.edge < 0.08) {
        newWeights[fs.key] = fs.weight; // mild positive → keep
      } else {
        newWeights[fs.key] = fs.weight * 1.5; // strong positive → 1.5×
      }
    }

    // Normalize: sum of all weights = 1.0
    // (no structural-unavailable factors remain; normalise all weights to sum to 1.0)
    const structuralTotal = factorStats
      .filter(fs => fs.structural)
      .reduce((s, fs) => s + (newWeights[fs.key] ?? fs.weight), 0);
    const nonStructuralTotal = Object.entries(newWeights)
      .filter(([k]) => !STRUCTURAL_UNAVAILABLE.has(k))
      .reduce((s, [, w]) => s + w, 0);
    const targetNonStructural = 1 - structuralTotal;
    const normalizer = nonStructuralTotal > 0 ? targetNonStructural / nonStructuralTotal : 1;

    for (const [k, w] of Object.entries(newWeights)) {
      if (!STRUCTURAL_UNAVAILABLE.has(k)) {
        newWeights[k] = Math.round(w * normalizer * 1000) / 1000;
      }
    }

    // Print comparison table
    for (const fs of factorStats.sort((a, b) => b.weight - a.weight)) {
      const oldW = fs.weight;
      const newW = newWeights[fs.key] ?? oldW;
      const edgeStr = isNaN(fs.edge) ? "  n/a " : ppDelta(fs.agreesWR, fs.disagreesWR);
      const dataNote = fs.nReal < MIN_FACTOR_N ? " (thin)" : "";
      const action =
        fs.structural ? "KEEP(spec)" :
        fs.nReal < MIN_FACTOR_N ? "KEEP(thin)" :
        newW < 0.01 ? "REMOVE" :
        newW < oldW * 0.7 ? "REDUCE" :
        newW > oldW * 1.3 ? "BOOST" :
        "KEEP";

      console.log(
        ` ${fs.label.slice(0, 25).padEnd(26)}` +
        ` ${oldW.toFixed(3).padStart(11)}` +
        ` ${edgeStr.padStart(9)}` +
        ` ${newW.toFixed(3).padStart(11)}` +
        ` ${action.padStart(10)}` +
        dataNote,
      );
    }

    // Sum check
    const newTotal = Object.values(newWeights).reduce((s, w) => s + w, 0);
    console.log(`\n New weight total: ${newTotal.toFixed(3)} (should be ≈1.000)`);

    // ── Step 5: Held-out validation ────────────────────────────────────────
    console.log(`\n── STEP 5: Held-Out Validation (last 20% of rows) ────────────────────────`);

    // Re-score held-out rows with new weights via the simple proxy:
    // Compute a new "validationScore" weighting factor directional votes by new weights
    // Then check if KEEP accuracy improves vs baseline

    function reScoreWithNewWeights(factors: StoredFactor[]): number {
      const base = factors.filter(f => f.key !== "sourceAgreement");
      const opinionated = base.filter(f => f.status !== "unavailable" && f.supportsSelected !== null);
      const agreeing = opinionated.filter(f => f.supportsSelected === true).length;
      const agreementRate = opinionated.length > 0 ? agreeing / opinionated.length : 0.5;
      const saScore = clamp(50 + Math.round((2 * agreementRate - 1) * 100), 0, 100);
      const saWeight = newWeights["sourceAgreement"] ?? 0.06;

      const allF = [
        ...base,
        {
          key: "sourceAgreement", label: "Source Agreement", score: saScore,
          weight: saWeight, status: "available" as const,
          supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null,
        },
      ].map(f => ({
        ...f,
        weight: newWeights[f.key] ?? f.weight,
      }));

      const availF = allF.filter(f => f.status !== "unavailable");
      const totalW = availF.reduce((s, f) => s + f.weight, 0);
      return totalW > 0
        ? Math.round(availF.reduce((s, f) => s + f.score * (f.weight / totalW), 0))
        : 50;
    }

    // ── Step 5b: Isolated Effect — Old vs. New Weights (full dataset) ─────────
    // Both arms score the SAME n=total rows from stored factor_scores.
    // This isolates the weight-change contribution from the data-quality
    // improvement: if old weights and new weights give the same win rate on
    // the identical dataset, the jump was entirely a data-quality change.
    // (We can't use the stored `decision` column because some rows may have
    // been scored after the weights were updated — re-derive both from scratch.)

    console.log(`\n── STEP 5b: Isolated Weight-Change Effect (ALL ${total} rows) ─────────────`);
    console.log(` Prior weights  = hand-set values from commit c075d53 (before Aug-2026 ablation)`);
    console.log(` Derived weights = Step-4 LOO result (current DEFAULT_WEIGHTS in code)\n`);

    function reScoreWithWeights(factors: StoredFactor[], weights: Record<string, number>): string {
      const base = factors.filter(f => f.key !== "sourceAgreement");
      const opinionated = base.filter(f => f.status !== "unavailable" && f.supportsSelected !== null);
      const agreeing = opinionated.filter(f => f.supportsSelected === true).length;
      const agreementRate = opinionated.length > 0 ? agreeing / opinionated.length : 0.5;
      const saScore = clamp(50 + Math.round((2 * agreementRate - 1) * 100), 0, 100);
      const saWeight = weights["sourceAgreement"] ?? 0.06;

      const allF = [
        ...base,
        {
          key: "sourceAgreement", label: "Source Agreement", score: saScore,
          weight: saWeight, status: "available" as const,
          supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null,
        },
      ].map(f => ({ ...f, weight: weights[f.key] ?? f.weight }));

      const availF = allF.filter(f => f.status !== "unavailable");
      const totalW = availF.reduce((s, f) => s + f.weight, 0);
      const newVS = totalW > 0
        ? Math.round(availF.reduce((s, f) => s + f.score * (f.weight / totalW), 0))
        : 50;

      // dataCoverage (for toDecision)
      const unavailW = allF.filter(f => f.status === "unavailable").reduce((s, f) => s + f.weight, 0);
      const dc = clamp(Math.round((1 - unavailW) * 100), 0, 100);
      return toDecision(newVS, 0 /* riskScore not re-derived here */, "B", dc);
      // Note: riskScore and reliabilityGrade are stored on the leg and don't depend on weights.
      // We access them from the leg directly in the loop below.
    }

    interface TierResult { overall: AnnotatedLeg[]; keep: AnnotatedLeg[]; borderline: AnnotatedLeg[]; remove: AnnotatedLeg[] }

    function classifyAll(legSet: AnnotatedLeg[], weights: Record<string, number>): TierResult {
      const keep: AnnotatedLeg[] = [], borderline: AnnotatedLeg[] = [], remove: AnnotatedLeg[] = [];
      for (const leg of legSet) {
        const base = leg.factor_scores.filter(f => f.key !== "sourceAgreement");
        const opinionated = base.filter(f => f.status !== "unavailable" && f.supportsSelected !== null);
        const agreeing = opinionated.filter(f => f.supportsSelected === true).length;
        const agreementRate = opinionated.length > 0 ? agreeing / opinionated.length : 0.5;
        const saScore = clamp(50 + Math.round((2 * agreementRate - 1) * 100), 0, 100);
        const saWeight = weights["sourceAgreement"] ?? 0.06;

        const allF = [
          ...base,
          { key: "sourceAgreement", score: saScore, weight: saWeight, status: "available" as const,
            label: "Source Agreement", supportsSelected: agreementRate > 0.55 ? true : agreementRate < 0.45 ? false : null },
        ].map(f => ({ ...f, weight: weights[f.key] ?? f.weight }));

        const availF = allF.filter(f => f.status !== "unavailable");
        const totalW = availF.reduce((s, f) => s + f.weight, 0);
        const newVS = totalW > 0
          ? Math.round(availF.reduce((s, f) => s + f.score * (f.weight / totalW), 0))
          : 50;
        const unavailW = allF.filter(f => f.status === "unavailable").reduce((s, f) => s + f.weight, 0);
        const dc = clamp(Math.round((1 - unavailW) * 100), 0, 100);
        const dec = toDecision(newVS, leg.risk_score, leg.reliability_grade, dc);
        if (dec === "KEEP") keep.push(leg);
        else if (dec === "BORDERLINE") borderline.push(leg);
        else remove.push(leg);
      }
      return { overall: legSet, keep, borderline, remove };
    }

    const priorResult  = classifyAll(legs, PRIOR_WEIGHTS);
    const derivedResult = classifyAll(legs, newWeights);

    const fmt6 = (n: number, d: number) => `${(n / d * 100).toFixed(1).padStart(5)}%  (n=${n})`;

    console.log(` ${"Tier".padEnd(12)} ${"Prior weights".padStart(20)} ${"Derived weights".padStart(22)} ${"Δ (derived−prior)".padStart(20)}`);
    console.log(` ${"─".repeat(12)} ${"─".repeat(20)} ${"─".repeat(22)} ${"─".repeat(20)}`);

    const tiers: Array<{ label: string; prior: AnnotatedLeg[]; derived: AnnotatedLeg[] }> = [
      { label: "Overall",    prior: priorResult.overall,    derived: derivedResult.overall },
      { label: "KEEP",       prior: priorResult.keep,       derived: derivedResult.keep },
      { label: "BORDERLINE", prior: priorResult.borderline, derived: derivedResult.borderline },
      { label: "REMOVE",     prior: priorResult.remove,     derived: derivedResult.remove },
    ];

    for (const { label, prior: p, derived: d } of tiers) {
      const pWR = winRate(p), dWR = winRate(d);
      const delta = isNaN(pWR) || isNaN(dWR) ? "  n/a" : ppDelta(dWR, pWR);
      console.log(
        ` ${label.padEnd(12)}` +
        ` ${(isNaN(pWR) ? "  n/a" : fmt6(p.filter(x => x.won).length, p.length)).padStart(20)}` +
        ` ${(isNaN(dWR) ? "  n/a" : fmt6(d.filter(x => x.won).length, d.length)).padStart(22)}` +
        ` ${delta.padStart(20)}`
      );
    }

    // Show how tier membership shifted
    console.log(`\n Tier membership change (prior → derived):`);
    console.log(`   KEEP:       ${priorResult.keep.length} → ${derivedResult.keep.length}  (${derivedResult.keep.length - priorResult.keep.length >= 0 ? "+" : ""}${derivedResult.keep.length - priorResult.keep.length})`);
    console.log(`   BORDERLINE: ${priorResult.borderline.length} → ${derivedResult.borderline.length}  (${derivedResult.borderline.length - priorResult.borderline.length >= 0 ? "+" : ""}${derivedResult.borderline.length - priorResult.borderline.length})`);
    console.log(`   REMOVE:     ${priorResult.remove.length} → ${derivedResult.remove.length}  (${derivedResult.remove.length - priorResult.remove.length >= 0 ? "+" : ""}${derivedResult.remove.length - priorResult.remove.length})`);

    console.log(`\n NOTE: The overall win-rate jump (53.3% baseline → current) has two components:`);
    console.log(`   Data-quality improvement:  overall win rate at prior weights on current dataset`);
    console.log(`   Weight-change contribution: Δ between prior and derived weights (table above)`);
    console.log(`   Prior 53.3% was measured on an older, smaller dataset — not directly comparable.`);

    // ── Step 5 (original): Held-out validation ──────────────────────────────

    // Held-out with original weights
    const heldOutKeepOld = heldOut.filter(l => l.decision === "KEEP");
    const heldOutBorderlineOld = heldOut.filter(l => l.decision === "BORDERLINE");

    // Held-out with new weights
    const heldOutNewKeep: AnnotatedLeg[] = [];
    const heldOutNewBorderline: AnnotatedLeg[] = [];
    for (const leg of heldOut) {
      const newVS = reScoreWithNewWeights(leg.factor_scores);
      const { dataCoverage: newDC } = computeScoreWithout(leg.factor_scores, null);
      const newDecision = toDecision(newVS, leg.risk_score, leg.reliability_grade, newDC);
      if (newDecision === "KEEP") heldOutNewKeep.push(leg);
      else if (newDecision === "BORDERLINE") heldOutNewBorderline.push(leg);
    }

    console.log(` Held-out overall win rate: ${pct(winRate(heldOut))}`);
    console.log(``);
    console.log(` ── Decision-tier comparison (old weights → new weights) ──`);
    console.log(` ${"Tier".padEnd(12)} ${"Old n".padStart(6)} ${"Old WR".padStart(7)} ${"New n".padStart(6)} ${"New WR".padStart(7)} ${"Δacc".padStart(8)}`);
    console.log(` ${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(8)}`);
    console.log(
      ` ${"KEEP".padEnd(12)}` +
      ` ${String(heldOutKeepOld.length).padStart(6)}` +
      ` ${pct(winRate(heldOutKeepOld)).padStart(7)}` +
      ` ${String(heldOutNewKeep.length).padStart(6)}` +
      ` ${pct(winRate(heldOutNewKeep)).padStart(7)}` +
      ` ${ppDelta(winRate(heldOutNewKeep), winRate(heldOutKeepOld)).padStart(8)}`,
    );
    console.log(
      ` ${"BORDERLINE".padEnd(12)}` +
      ` ${String(heldOutBorderlineOld.length).padStart(6)}` +
      ` ${pct(winRate(heldOutBorderlineOld)).padStart(7)}` +
      ` ${String(heldOutNewBorderline.length).padStart(6)}` +
      ` ${pct(winRate(heldOutNewBorderline)).padStart(7)}` +
      ` ${ppDelta(winRate(heldOutNewBorderline), winRate(heldOutBorderlineOld)).padStart(8)}`,
    );

    // ── Step 6: New DEFAULT_WEIGHTS block ──────────────────────────────────
    console.log(`\n── STEP 6: Proposed DEFAULT_WEIGHTS block (copy into builderScoringService.ts) ─`);
    console.log(`\nconst DEFAULT_WEIGHTS: Record<string, number> = {`);
    const sortedByNewWeight = factorStats.sort((a, b) => (newWeights[b.key] ?? 0) - (newWeights[a.key] ?? 0));
    for (const fs of sortedByNewWeight) {
      const newW = newWeights[fs.key] ?? fs.weight;
      const commentParts: string[] = [];
      if (fs.structural) commentParts.push("no public API — unavailable");
      else if (fs.nReal < MIN_FACTOR_N) commentParts.push(`thin data (n=${fs.nReal}) — kept at prior weight`);
      else {
        const edgeStr = isNaN(fs.edge) ? "n/a" : `${(fs.edge * 100).toFixed(1)}pp edge`;
        commentParts.push(`${edgeStr} (n=${fs.nReal})`);
      }
      const comment = commentParts.length > 0 ? `  // ${commentParts.join("; ")}` : "";
      console.log(`  ${fs.key.padEnd(24)}: ${newW.toFixed(3)},${comment}`);
    }
    console.log(`};\n`);

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`── SUMMARY ──────────────────────────────────────────────────────────────`);
    const zeroedFactors = factorStats.filter(fs => (newWeights[fs.key] ?? 0) < 0.01 && !fs.structural);
    const boostedFactors = factorStats.filter(fs => (newWeights[fs.key] ?? 0) > (fs.weight * 1.25) && !fs.structural && fs.nReal >= MIN_FACTOR_N);
    const reducedFactors = factorStats.filter(fs => (newWeights[fs.key] ?? 0) < (fs.weight * 0.75) && !fs.structural && fs.nReal >= MIN_FACTOR_N && (newWeights[fs.key] ?? 0) >= 0.01);

    if (zeroedFactors.length > 0) {
      console.log(` NEAR-ZERO (negative/flat edge):`);
      for (const fs of zeroedFactors) {
        console.log(`   - ${fs.label}: ${ppDelta(fs.agreesWR, fs.disagreesWR)} edge, n=${fs.nReal}`);
      }
    }
    if (reducedFactors.length > 0) {
      console.log(` REDUCED (mild edge):`);
      for (const fs of reducedFactors) {
        console.log(`   - ${fs.label}: ${ppDelta(fs.agreesWR, fs.disagreesWR)} edge, n=${fs.nReal}`);
      }
    }
    if (boostedFactors.length > 0) {
      console.log(` BOOSTED (strong positive edge):`);
      for (const fs of boostedFactors) {
        console.log(`   - ${fs.label}: ${ppDelta(fs.agreesWR, fs.disagreesWR)} edge, n=${fs.nReal}`);
      }
    }

    console.log(`\n NOTE: Run pnpm --filter @workspace/api-server exec tsx src/scripts/analyzeParlayCalibration.ts`);
    console.log(`       to validate the composite score after updating DEFAULT_WEIGHTS.`);
    console.log(`${"═".repeat(80)}\n`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Parlay factor ablation failed:", err);
  process.exit(1);
});
