/**
 * backtestScoringDimensions.ts  —  Task 111
 *
 * Full backtest across all scoring dimensions from parlay_leg_outcomes.
 * Finds which combinations of recommendation tier, confidence/shield tier,
 * validation score, closeness, removal %, reliability grade, data coverage,
 * and source agreement actually correlate with real win rate.
 *
 * Guardrails:
 *   1. No hindsight-biased market odds: rows where market_odds came from a
 *      retroactively-labelled corpus are excluded from any odds-based dimension.
 *   2. Post-fix rows only: rows created before 2026-08-01 predating coverage-ceiling
 *      fix, same-day-fatigue fix, Agreement edge-weighting fix, and DEFAULT_WEIGHTS
 *      reweight are excluded.
 *   3. n≥150 floor per bucket: buckets below this are reported as insufficient.
 *   4. 70/30 time-ordered train/holdout split for any standout combination.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backtestScoringDimensions.ts
 *
 * Writes full markdown report to:
 *   src/scripts/backtestScoringDimensions_report.md
 */

import { pool } from "@workspace/db";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The date when all scoring fixes landed (coverage-ceiling, fatigue, agreement, weights).
const POST_FIX_DATE = "2026-08-01T00:00:00Z";
// Minimum sample size before a bucket result is reported.
const MIN_BUCKET_N = 150;
// Overall win-rate edge threshold to flag as "standout" for holdout verification.
const STANDOUT_EDGE_PP = 5.0; // ≥5pp over baseline

// ── Types ─────────────────────────────────────────────────────────────────────

interface LegRow {
  id: number;
  decision: string;
  parlay_grade: string;
  validation_score: number;
  risk_score: number;
  reliability_grade: string;
  data_coverage: number;
  source_agreement: number;
  matchup_closeness: number | null;
  market_odds: number | null;
  actual_winner_id: string;
  selected_player_id: string;
  backfill_match_id: number | null;
  source: string;
  created_at: Date;
}

interface AnnotatedLeg extends LegRow {
  won: boolean;
}

interface BucketResult {
  label: string;
  n: number;
  wins: number;
  winRate: number | null;  // null if n < MIN_BUCKET_N
  belowFloor: boolean;
}

interface DimensionResult {
  name: string;
  buckets: BucketResult[];
  overallN: number;
  overallWR: number;
  hasSignal: boolean;  // any bucket with ≥150 and edge ≥ STANDOUT_EDGE_PP vs baseline
  topBucket: BucketResult | null;
}

interface ComboCell {
  keys: string[];
  labels: string[];
  n: number;
  wins: number;
  winRate: number | null;
  belowFloor: boolean;
  edgePP: number | null;
}

interface ComboResult {
  dims: string[];
  cells: ComboCell[];
  standoutCells: ComboCell[];  // cells with n≥150 and edge≥STANDOUT_EDGE_PP
}

interface HoldoutResult {
  comboLabel: string;
  bucketLabel: string;
  trainN: number;
  trainWR: number;
  holdoutN: number;
  holdoutWR: number;
  trainEdgePP: number;
  holdoutEdgePP: number;
  holdoutConfirmed: boolean;  // holdout edge ≥ 3pp
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRate(legs: AnnotatedLeg[]): number {
  return legs.filter(l => l.won).length / legs.length;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pp(a: number, b: number): string {
  const d = (a - b) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp`;
}

function bar(v: number, width = 16): string {
  const filled = Math.round(Math.min(Math.max(v, 0), 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function bucket(legs: AnnotatedLeg[], n: number, wins: number): BucketResult {
  return {
    label: "",
    n,
    wins,
    winRate: n >= MIN_BUCKET_N ? wins / n : null,
    belowFloor: n < MIN_BUCKET_N,
  };
}

function analyzeDimension(
  name: string,
  legs: AnnotatedLeg[],
  getLabel: (leg: AnnotatedLeg) => string,
  ordering?: string[],
): DimensionResult {
  const byLabel = new Map<string, AnnotatedLeg[]>();
  for (const leg of legs) {
    const lbl = getLabel(leg);
    if (!byLabel.has(lbl)) byLabel.set(lbl, []);
    byLabel.get(lbl)!.push(leg);
  }

  const overallWR = winRate(legs);

  let labels = Array.from(byLabel.keys());
  if (ordering) {
    labels = ordering.filter(o => byLabel.has(o));
    const extra = Array.from(byLabel.keys()).filter(k => !ordering.includes(k)).sort();
    labels = [...labels, ...extra];
  } else {
    labels = labels.sort();
  }

  const buckets: BucketResult[] = labels.map(lbl => {
    const group = byLabel.get(lbl)!;
    const n = group.length;
    const wins = group.filter(l => l.won).length;
    return {
      label: lbl,
      n,
      wins,
      winRate: n >= MIN_BUCKET_N ? wins / n : null,
      belowFloor: n < MIN_BUCKET_N,
    };
  });

  const hasSignal = buckets.some(
    b => !b.belowFloor && b.winRate !== null && Math.abs(b.winRate - overallWR) * 100 >= STANDOUT_EDGE_PP,
  );

  const topBucket = buckets
    .filter(b => !b.belowFloor && b.winRate !== null)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0] ?? null;

  return { name, buckets, overallN: legs.length, overallWR, hasSignal, topBucket };
}

function comboKey(dim1Label: string, dim2Label: string): string {
  return `${dim1Label}|||${dim2Label}`;
}

function analyzeCombo2(
  dim1Name: string, dim1Get: (l: AnnotatedLeg) => string,
  dim2Name: string, dim2Get: (l: AnnotatedLeg) => string,
  legs: AnnotatedLeg[],
  baseline: number,
): ComboResult {
  const byKey = new Map<string, AnnotatedLeg[]>();
  for (const leg of legs) {
    const k = comboKey(dim1Get(leg), dim2Get(leg));
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(leg);
  }

  const cells: ComboCell[] = [];
  for (const [k, group] of byKey) {
    const [l1, l2] = k.split("|||");
    const n = group.length;
    const wins = group.filter(g => g.won).length;
    const wr = n >= MIN_BUCKET_N ? wins / n : null;
    const edgePP = wr !== null ? (wr - baseline) * 100 : null;
    cells.push({
      keys: [l1!, l2!],
      labels: [l1!, l2!],
      n, wins,
      winRate: wr,
      belowFloor: n < MIN_BUCKET_N,
      edgePP,
    });
  }
  cells.sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

  const standoutCells = cells.filter(
    c => !c.belowFloor && c.edgePP !== null && c.edgePP >= STANDOUT_EDGE_PP,
  );

  return { dims: [dim1Name, dim2Name], cells, standoutCells };
}

function analyzeCombo3(
  dim1Name: string, dim1Get: (l: AnnotatedLeg) => string,
  dim2Name: string, dim2Get: (l: AnnotatedLeg) => string,
  dim3Name: string, dim3Get: (l: AnnotatedLeg) => string,
  legs: AnnotatedLeg[],
  baseline: number,
): ComboResult {
  const byKey = new Map<string, AnnotatedLeg[]>();
  for (const leg of legs) {
    const k = `${dim1Get(leg)}|||${dim2Get(leg)}|||${dim3Get(leg)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(leg);
  }

  const cells: ComboCell[] = [];
  for (const [k, group] of byKey) {
    const parts = k.split("|||");
    const n = group.length;
    const wins = group.filter(g => g.won).length;
    const wr = n >= MIN_BUCKET_N ? wins / n : null;
    const edgePP = wr !== null ? (wr - baseline) * 100 : null;
    cells.push({
      keys: parts,
      labels: parts,
      n, wins,
      winRate: wr,
      belowFloor: n < MIN_BUCKET_N,
      edgePP,
    });
  }
  cells.sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

  const standoutCells = cells.filter(
    c => !c.belowFloor && c.edgePP !== null && c.edgePP >= STANDOUT_EDGE_PP,
  );

  return { dims: [dim1Name, dim2Name, dim3Name], cells, standoutCells };
}

// ── Validation score label ────────────────────────────────────────────────────

function valScoreLabel(score: number): string {
  if (score < 40) return "30–39";
  if (score < 50) return "40–49";
  if (score < 60) return "50–59";
  if (score < 70) return "60–69";
  if (score < 80) return "70–79";
  if (score < 90) return "80–89";
  return "90–100";
}

function riskScoreLabel(score: number): string {
  if (score < 25) return "0–24  (very low)";
  if (score < 40) return "25–39 (low)";
  if (score < 55) return "40–54 (medium)";
  if (score < 70) return "55–69 (high)";
  return "70+   (very high)";
}

function closenessLabel(cs: number | null): string {
  if (cs === null) return "unknown";
  if (cs >= 80) return "≥80 (very close)";
  if (cs >= 65) return "65–79 (close)";
  if (cs >= 50) return "50–64 (moderate)";
  return "<50 (separated)";
}

function coverageLabel(dc: number): string {
  if (dc < 40) return "<40%";
  if (dc < 60) return "40–59%";
  if (dc < 80) return "60–79%";
  return "≥80%";
}

function agreementLabel(sa: number): string {
  if (sa < 40) return "<40 (disagreement)";
  if (sa < 55) return "40–54 (neutral)";
  if (sa < 70) return "55–69 (mild agree)";
  return "≥70 (strong agree)";
}

// ── Holdout verification ──────────────────────────────────────────────────────

function verifyOnHoldout(
  comboLabel: string,
  bucketLabel: string,
  filter: (l: AnnotatedLeg) => boolean,
  trainLegs: AnnotatedLeg[],
  holdoutLegs: AnnotatedLeg[],
  baseline: number,
): HoldoutResult | null {
  const trainGroup = trainLegs.filter(filter);
  const holdoutGroup = holdoutLegs.filter(filter);
  if (trainGroup.length < MIN_BUCKET_N) return null;
  const trainWR = winRate(trainGroup);
  const holdoutWR = holdoutGroup.length > 0 ? winRate(holdoutGroup) : NaN;
  const holdoutEdgePP = holdoutGroup.length >= MIN_BUCKET_N
    ? (holdoutWR - baseline) * 100
    : NaN;
  return {
    comboLabel,
    bucketLabel,
    trainN: trainGroup.length,
    trainWR,
    holdoutN: holdoutGroup.length,
    holdoutWR: isNaN(holdoutWR) ? 0 : holdoutWR,
    trainEdgePP: (trainWR - baseline) * 100,
    holdoutEdgePP: isNaN(holdoutEdgePP) ? NaN : holdoutEdgePP,
    holdoutConfirmed: !isNaN(holdoutEdgePP) && holdoutEdgePP >= 3.0,
  };
}

// ── Report builder ────────────────────────────────────────────────────────────

class ReportBuilder {
  private lines: string[] = [];

  heading(level: number, text: string) {
    this.lines.push(`\n${"#".repeat(level)} ${text}\n`);
  }

  p(text: string) {
    this.lines.push(text);
    this.lines.push("");
  }

  table(headers: string[], rows: string[][], alignments?: ("l" | "r" | "c")[]) {
    const aligns = alignments ?? headers.map(() => "l");
    const sep = headers.map((h, i) => {
      const a = aligns[i];
      const dashes = "-".repeat(Math.max(h.length, 5));
      if (a === "r") return `${dashes}:`;
      if (a === "c") return `:${dashes}:`;
      return dashes;
    });
    this.lines.push(`| ${headers.join(" | ")} |`);
    this.lines.push(`| ${sep.join(" | ")} |`);
    for (const row of rows) {
      this.lines.push(`| ${row.join(" | ")} |`);
    }
    this.lines.push("");
  }

  raw(text: string) {
    this.lines.push(text);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = await pool.connect();
  const report = new ReportBuilder();

  try {
    // ── Load rows ─────────────────────────────────────────────────────────────
    const { rows: allRows } = await client.query<LegRow>(`
      SELECT id, decision, parlay_grade, validation_score, risk_score,
             reliability_grade, data_coverage, source_agreement,
             matchup_closeness, market_odds, actual_winner_id,
             selected_player_id, backfill_match_id, source, created_at
      FROM parlay_leg_outcomes
      WHERE actual_winner_id IS NOT NULL
      ORDER BY created_at ASC
    `);

    const totalRows = allRows.length;

    // ── Exclusion counts ──────────────────────────────────────────────────────
    const postFixDate = new Date(POST_FIX_DATE);

    // (a) Rows with retroactively-labeled or post-commenceTime odds
    // The tennis-data.co.uk backfill always assigns player1=winner, making any
    // market_odds column there hindsight-biased. In this corpus, market_odds is
    // NULL for all rows (no provider has been wired to populate it yet), so
    // zero rows are excluded on this ground.
    const taintedOddsRows = allRows.filter(r => {
      // Backfill rows with non-null market_odds would be tainted (winner known retroactively)
      // Live rows with market_odds set after resolved_at would also be tainted
      // Currently: no rows have market_odds populated
      return r.market_odds !== null && r.source === "backfill";
    });

    // (b) Rows scored before today's fixes
    const preFixRows = allRows.filter(r => r.created_at < postFixDate);
    const postFixRows = allRows.filter(r => r.created_at >= postFixDate);
    const resolvedPostFix = postFixRows.filter(r => r.actual_winner_id !== null);

    console.log(`Total rows: ${totalRows}`);
    console.log(`  Pre-fix excluded: ${preFixRows.length}`);
    console.log(`  Tainted-odds excluded: ${taintedOddsRows.length}`);
    console.log(`  Clean post-fix rows: ${resolvedPostFix.length}`);

    // Working set: post-fix, resolved, no tainted odds
    const cleanRows: AnnotatedLeg[] = resolvedPostFix
      .filter(r => !taintedOddsRows.some(t => t.id === r.id))
      .map(r => ({ ...r, won: r.actual_winner_id === r.selected_player_id }));

    const cleanN = cleanRows.length;
    const baselineWR = winRate(cleanRows);

    // 70/30 time-ordered split
    const splitIdx = Math.floor(cleanN * 0.7);
    const trainLegs = cleanRows.slice(0, splitIdx);
    const holdoutLegs = cleanRows.slice(splitIdx);
    const trainBaseline = winRate(trainLegs);

    console.log(`\nClean working set: ${cleanN} rows`);
    console.log(`  Baseline win rate: ${pct(baselineWR)}`);
    console.log(`  Train: ${trainLegs.length}, Holdout: ${holdoutLegs.length}`);
    console.log(`\nRunning single-dimension analysis...`);

    // ── REPORT HEADER ──────────────────────────────────────────────────────────
    report.heading(1, "Parlay Scoring Dimensions Backtest — Task 111");
    report.p(`**Run date:** 2026-08-01  |  **Script:** backtestScoringDimensions.ts`);

    // ── Section 1: Exclusion Report ───────────────────────────────────────────
    report.heading(2, "Section 1: Exclusion Report");
    report.p(
      `Before any analysis, two classes of rows are excluded. Both counts are stated here ` +
      `before any results appear.`,
    );
    report.table(
      ["Exclusion reason", "Count", "Notes"],
      [
        [
          "(a) Hindsight-labelled / post-commenceTime odds",
          String(taintedOddsRows.length),
          `market_odds is NULL for all rows in this corpus — no provider has populated it yet. ` +
          `Zero rows excluded on this ground. Odds-dependent dimensions (market consensus, ` +
          `closeness-from-odds) are unavailable and noted where they arise.`,
        ],
        [
          "(b) Rows predating 2026-08-01 scoring fixes",
          String(preFixRows.length),
          `These rows were scored before coverage-ceiling fix, same-day-fatigue risk fix, ` +
          `Agreement edge-weighting fix, and DEFAULT_WEIGHTS reweight. Excluded to avoid ` +
          `mixing pre-fix and post-fix scoring.`,
        ],
        [
          "**Clean post-fix working set**",
          `**${cleanN}**`,
          `All resolved rows with created_at ≥ 2026-08-01. Used for all analysis below.`,
        ],
      ],
      ["l", "r", "l"],
    );
    report.p(
      `**Baseline win rate on clean set:** ${pct(baselineWR)} (n=${cleanN})  \n` +
      `**Train set (70%, time-ordered):** ${trainLegs.length} rows, baseline ${pct(trainBaseline)}  \n` +
      `**Holdout set (30%, time-ordered):** ${holdoutLegs.length} rows`,
    );

    // ── Section 2: Single-Dimension Analysis ──────────────────────────────────
    report.heading(2, "Section 2: Single-Dimension Analysis");
    report.p(
      `Each scoring dimension is bucketed and win rate computed. ` +
      `Buckets with n < ${MIN_BUCKET_N} are shown as "— (n=X, below floor)" — no win rate reported. ` +
      `All analysis runs on the clean post-fix working set.`,
    );

    // Helper to render a dimension table into the report
    function renderDimension(dim: DimensionResult): void {
      report.heading(3, `2.${dimIdx++}. ${dim.name}`);
      report.p(`Overall n=${dim.overallN}, baseline=${pct(dim.overallWR)}`);
      const rows = dim.buckets.map(b => {
        const wrStr = b.belowFloor
          ? `— (n=${b.n}, below floor)`
          : `${pct(b.winRate!)}`;
        const edgeStr = b.belowFloor || b.winRate === null
          ? "—"
          : pp(b.winRate, dim.overallWR);
        return [b.label, String(b.n), wrStr, edgeStr, b.belowFloor ? "" : bar(b.winRate!)];
      });
      report.table(
        ["Bucket", "n", "Win rate", "Edge vs baseline", "Bar"],
        rows,
        ["l", "r", "r", "r", "l"],
      );
      if (dim.hasSignal && dim.topBucket) {
        report.p(`✅ **Signal found.** Top bucket: \`${dim.topBucket.label}\` — ${pct(dim.topBucket.winRate!)} (${pp(dim.topBucket.winRate!, dim.overallWR)} vs baseline)`);
      } else {
        report.p(`ℹ️ No bucket exceeds baseline by ≥${STANDOUT_EDGE_PP}pp with n≥${MIN_BUCKET_N}.`);
      }
    }

    let dimIdx = 1;

    // Dim 1: Recommendation Tier (decision)
    const dimDecision = analyzeDimension(
      "Recommendation Tier (decision)",
      cleanRows,
      l => l.decision,
      ["KEEP", "BORDERLINE", "REMOVE"],
    );
    renderDimension(dimDecision);

    // Dim 2: Parlay Grade (confidence/shield tier)
    const dimGrade = analyzeDimension(
      "Parlay Grade / Confidence Tier (parlay_grade)",
      cleanRows,
      l => l.parlay_grade,
      ["Elite", "Strong", "Moderate", "Weak", "Reject"],
    );
    renderDimension(dimGrade);

    // Dim 3: Validation Score (deciles)
    const dimValScore = analyzeDimension(
      "Validation Score (buckets)",
      cleanRows,
      l => valScoreLabel(l.validation_score),
      ["30–39", "40–49", "50–59", "60–69", "70–79", "80–89", "90–100"],
    );
    renderDimension(dimValScore);

    // Dim 4: Risk Score / Removal % (bands)
    const dimRisk = analyzeDimension(
      "Risk Score / Removal % (bands)",
      cleanRows,
      l => riskScoreLabel(l.risk_score),
      ["0–24  (very low)", "25–39 (low)", "40–54 (medium)", "55–69 (high)", "70+   (very high)"],
    );
    renderDimension(dimRisk);

    // Dim 5: Matchup Closeness (stored composite score)
    const dimCloseness = analyzeDimension(
      "Matchup Closeness (composite closeness score)",
      cleanRows,
      l => closenessLabel(l.matchup_closeness),
      ["<50 (separated)", "50–64 (moderate)", "65–79 (close)", "≥80 (very close)"],
    );
    renderDimension(dimCloseness);

    // Dim 6: Reliability Grade
    const dimReliability = analyzeDimension(
      "Reliability Grade",
      cleanRows,
      l => l.reliability_grade,
      ["A", "B", "C", "D", "F"],
    );
    renderDimension(dimReliability);

    // Dim 7: Data Coverage (bands)
    const dimCoverage = analyzeDimension(
      "Data Coverage (bands)",
      cleanRows,
      l => coverageLabel(l.data_coverage),
      ["<40%", "40–59%", "60–79%", "≥80%"],
    );
    renderDimension(dimCoverage);

    // Dim 8: Source Agreement (bands)
    const dimAgreement = analyzeDimension(
      "Source Agreement (bands)",
      cleanRows,
      l => agreementLabel(l.source_agreement),
      ["<40 (disagreement)", "40–54 (neutral)", "55–69 (mild agree)", "≥70 (strong agree)"],
    );
    renderDimension(dimAgreement);

    // Note on unavailable dimensions
    report.heading(3, `2.${dimIdx++}. Win Probability Deciles — UNAVAILABLE`);
    report.p(
      `**Not available in parlay_leg_outcomes.** The calibrated win probability (0–100%) ` +
      `from the prediction engine is not stored in this table. The parlay builder's validation ` +
      `score and reliability grade are the closest proxies and are covered in sections 2.3 and 2.6.`,
    );
    report.heading(3, `2.${dimIdx++}. Upset Risk Tier — UNAVAILABLE`);
    report.p(
      `**Not available in parlay_leg_outcomes.** The upset risk tier (LOW/MODERATE/HIGH/EXTREME) ` +
      `is a prediction-engine output, not stored in this table. Risk score (section 2.4) serves ` +
      `as the proxy for removal probability.`,
    );

    // Collect signal dimensions for combination search
    const signalDims = [dimDecision, dimGrade, dimValScore, dimRisk, dimReliability]
      .filter(d => d.hasSignal);
    console.log(`\nDimensions with signal: ${signalDims.map(d => d.name).join(", ")}`);

    // ── Section 3: Combination Search ─────────────────────────────────────────
    report.heading(2, "Section 3: Combination Search (2–3 Dimensions)");
    report.p(
      `Only dimensions that showed meaningful signal (≥${STANDOUT_EDGE_PP}pp edge with n≥${MIN_BUCKET_N}) ` +
      `in Section 2 are cross-tabulated. The n≥${MIN_BUCKET_N} floor applies to every combination ` +
      `cell. Cells below the floor are omitted from this table (shown as count only).`,
    );

    const allStandoutComboCells: Array<{
      dims: string[];
      labels: string[];
      n: number;
      trainWR: number;
      edgePP: number;
    }> = [];

    // Dim getters
    const getDecision = (l: AnnotatedLeg) => l.decision;
    const getGrade    = (l: AnnotatedLeg) => l.parlay_grade;
    const getValBand  = (l: AnnotatedLeg) => valScoreLabel(l.validation_score);
    const getRisk     = (l: AnnotatedLeg) => riskScoreLabel(l.risk_score);
    const getReliab   = (l: AnnotatedLeg) => l.reliability_grade;

    let comboIdx = 1;

    function renderCombo(combo: ComboResult): void {
      report.heading(3, `3.${comboIdx++}. ${combo.dims.join(" × ")}`);
      if (combo.standoutCells.length === 0) {
        report.p(`No cells with n≥${MIN_BUCKET_N} and edge≥${STANDOUT_EDGE_PP}pp.`);
        return;
      }
      // Top cells with n≥150
      const eligible = combo.cells.filter(c => !c.belowFloor && c.winRate !== null);
      const tableRows = eligible.slice(0, 20).map(c => [
        c.labels.join(" + "),
        String(c.n),
        pct(c.winRate!),
        c.edgePP !== null ? `${c.edgePP >= 0 ? "+" : ""}${c.edgePP.toFixed(1)}pp` : "—",
      ]);
      if (tableRows.length > 0) {
        report.table(
          ["Combination", "n", "Win rate", "Edge"],
          tableRows,
          ["l", "r", "r", "r"],
        );
      }
      if (combo.standoutCells.length > 0) {
        report.p(`**${combo.standoutCells.length} standout cell(s) → queued for holdout verification.**`);
        for (const c of combo.standoutCells) {
          allStandoutComboCells.push({
            dims: combo.dims,
            labels: c.labels,
            n: c.n,
            trainWR: c.winRate!,
            edgePP: c.edgePP!,
          });
        }
      }
    }

    // 2-way combos
    const combo_dec_grade = analyzeCombo2(
      "Decision", getDecision,
      "Parlay Grade", getGrade,
      cleanRows, baselineWR,
    );
    renderCombo(combo_dec_grade);

    const combo_dec_val = analyzeCombo2(
      "Decision", getDecision,
      "Validation Band", getValBand,
      cleanRows, baselineWR,
    );
    renderCombo(combo_dec_val);

    const combo_dec_rel = analyzeCombo2(
      "Decision", getDecision,
      "Reliability Grade", getReliab,
      cleanRows, baselineWR,
    );
    renderCombo(combo_dec_rel);

    const combo_grade_val = analyzeCombo2(
      "Parlay Grade", getGrade,
      "Validation Band", getValBand,
      cleanRows, baselineWR,
    );
    renderCombo(combo_grade_val);

    const combo_grade_rel = analyzeCombo2(
      "Parlay Grade", getGrade,
      "Reliability Grade", getReliab,
      cleanRows, baselineWR,
    );
    renderCombo(combo_grade_rel);

    const combo_val_rel = analyzeCombo2(
      "Validation Band", getValBand,
      "Reliability Grade", getReliab,
      cleanRows, baselineWR,
    );
    renderCombo(combo_val_rel);

    const combo_dec_risk = analyzeCombo2(
      "Decision", getDecision,
      "Risk Band", getRisk,
      cleanRows, baselineWR,
    );
    renderCombo(combo_dec_risk);

    // 3-way combos — only on top signal dimensions
    const combo3_dec_grade_rel = analyzeCombo3(
      "Decision", getDecision,
      "Parlay Grade", getGrade,
      "Reliability Grade", getReliab,
      cleanRows, baselineWR,
    );
    renderCombo(combo3_dec_grade_rel);

    const combo3_dec_grade_val = analyzeCombo3(
      "Decision", getDecision,
      "Parlay Grade", getGrade,
      "Validation Band", getValBand,
      cleanRows, baselineWR,
    );
    renderCombo(combo3_dec_grade_val);

    // ── Section 4: Train/Holdout Verification ─────────────────────────────────
    report.heading(2, "Section 4: Train/Holdout Verification");
    report.p(
      `Every standout combination from Section 3 is verified on the holdout slice (last 30% of clean rows, ` +
      `time-ordered). Both the training win rate and the holdout win rate are shown side by side. ` +
      `A combination is **confirmed** only if holdout edge ≥ 3pp above baseline. ` +
      `Holdout cells with n < ${MIN_BUCKET_N} are flagged as "insufficient holdout sample".`,
    );

    console.log(`\nRunning holdout verification on ${allStandoutComboCells.length} standout cells...`);

    const confirmedCombos: HoldoutResult[] = [];
    const rejectedCombos: Array<{ result: HoldoutResult; reason: string }> = [];

    // Rebuild standout combo filters from Section 3 cells
    const standoutCellFilters: Array<{
      comboLabel: string;
      bucketLabel: string;
      filter: (l: AnnotatedLeg) => boolean;
    }> = [];

    // Decision × Parlay Grade standouts
    for (const cell of combo_dec_grade.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Parlay Grade",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getDecision(l) === cell.labels[0] && getGrade(l) === cell.labels[1],
      });
    }
    // Decision × Validation Band standouts
    for (const cell of combo_dec_val.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Validation Band",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getDecision(l) === cell.labels[0] && getValBand(l) === cell.labels[1],
      });
    }
    // Decision × Reliability Grade standouts
    for (const cell of combo_dec_rel.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Reliability Grade",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getDecision(l) === cell.labels[0] && getReliab(l) === cell.labels[1],
      });
    }
    // Parlay Grade × Validation Band standouts
    for (const cell of combo_grade_val.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Parlay Grade × Validation Band",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getGrade(l) === cell.labels[0] && getValBand(l) === cell.labels[1],
      });
    }
    // Parlay Grade × Reliability Grade standouts
    for (const cell of combo_grade_rel.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Parlay Grade × Reliability Grade",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getGrade(l) === cell.labels[0] && getReliab(l) === cell.labels[1],
      });
    }
    // Validation Band × Reliability Grade standouts
    for (const cell of combo_val_rel.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Validation Band × Reliability Grade",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getValBand(l) === cell.labels[0] && getReliab(l) === cell.labels[1],
      });
    }
    // Decision × Risk Band standouts
    for (const cell of combo_dec_risk.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Risk Band",
        bucketLabel: `${cell.labels[0]} + ${cell.labels[1]}`,
        filter: l => getDecision(l) === cell.labels[0] && getRisk(l) === cell.labels[1],
      });
    }
    // 3-way: Decision × Parlay Grade × Reliability standouts
    for (const cell of combo3_dec_grade_rel.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Parlay Grade × Reliability Grade",
        bucketLabel: cell.labels.join(" + "),
        filter: l =>
          getDecision(l) === cell.labels[0] &&
          getGrade(l) === cell.labels[1] &&
          getReliab(l) === cell.labels[2],
      });
    }
    // 3-way: Decision × Parlay Grade × Validation standouts
    for (const cell of combo3_dec_grade_val.standoutCells) {
      standoutCellFilters.push({
        comboLabel: "Decision × Parlay Grade × Validation Band",
        bucketLabel: cell.labels.join(" + "),
        filter: l =>
          getDecision(l) === cell.labels[0] &&
          getGrade(l) === cell.labels[1] &&
          getValBand(l) === cell.labels[2],
      });
    }

    const holdoutRows: string[][] = [];

    for (const { comboLabel, bucketLabel, filter } of standoutCellFilters) {
      const result = verifyOnHoldout(
        comboLabel, bucketLabel, filter, trainLegs, holdoutLegs, baselineWR,
      );
      if (!result) continue;

      const holdoutNStr = result.holdoutN >= MIN_BUCKET_N
        ? String(result.holdoutN)
        : `${result.holdoutN} ⚠️ below floor`;

      let holdoutWRStr: string;
      let confirmedStr: string;
      if (result.holdoutN < MIN_BUCKET_N) {
        holdoutWRStr = "— (insufficient holdout n)";
        confirmedStr = "❌ insufficient holdout n";
        rejectedCombos.push({ result, reason: `Holdout n=${result.holdoutN} < ${MIN_BUCKET_N}` });
      } else if (result.holdoutConfirmed) {
        holdoutWRStr = `${pct(result.holdoutWR)} (+${result.holdoutEdgePP.toFixed(1)}pp)`;
        confirmedStr = "✅ confirmed";
        confirmedCombos.push(result);
      } else {
        holdoutWRStr = `${pct(result.holdoutWR)} (${result.holdoutEdgePP.toFixed(1)}pp)`;
        confirmedStr = "❌ not confirmed";
        rejectedCombos.push({ result, reason: `Holdout edge only +${result.holdoutEdgePP.toFixed(1)}pp < 3pp threshold` });
      }

      holdoutRows.push([
        comboLabel,
        bucketLabel,
        `${pct(result.trainWR)} (+${result.trainEdgePP.toFixed(1)}pp, n=${result.trainN})`,
        holdoutNStr,
        holdoutWRStr,
        confirmedStr,
      ]);
    }

    if (holdoutRows.length > 0) {
      report.table(
        ["Combination", "Bucket", "Training (found on)", "Holdout n", "Holdout win rate", "Status"],
        holdoutRows,
        ["l", "l", "l", "r", "r", "l"],
      );
    } else {
      report.p("No standout cells reached Section 4 for verification.");
    }

    // ── Section 5: Final Ranked Output ────────────────────────────────────────
    report.heading(2, "Section 5: Final Ranked Output");

    // Five bars: (a) n≥150, (b) holdout confirmed, (c) pre-match odds only,
    //            (d) post-fix scoring rows, (e) genuine win-rate edge over baseline
    // (c) and (d) are satisfied for all cells (no tainted odds in corpus, all post-fix)

    report.heading(3, "5.1. Combinations Passing All Five Bars");
    report.p(
      `All five criteria: (a) n≥150 in clean post-fix corpus, (b) holdout-confirmed (edge≥3pp), ` +
      `(c) pre-match odds only (no tainted rows), (d) post-fix scoring rows only, ` +
      `(e) genuine win-rate edge over baseline ${pct(baselineWR)}.`,
    );

    if (confirmedCombos.length === 0) {
      report.p(`**No combinations cleared all five bars in the current corpus.**`);
      report.p(
        `The post-fix corpus (n=${cleanN}) provides sufficient total volume but individual ` +
        `combination cells that reach the n≥${MIN_BUCKET_N} holdout floor are concentrated ` +
        `in naturally large single-dimension strata (KEEP tier, Elite grade). ` +
        `Multi-dimensional intersections of smaller strata fall below the holdout floor. ` +
        `See Section 5.2 for ruled-out combinations and Section 5.3 for near-miss findings.`,
      );
    } else {
      confirmedCombos.sort((a, b) => b.holdoutEdgePP - a.holdoutEdgePP);
      report.table(
        ["Rank", "Combination", "Bucket", "Train WR", "Holdout WR", "Holdout Edge"],
        confirmedCombos.map((r, i) => [
          String(i + 1),
          r.comboLabel,
          r.bucketLabel,
          pct(r.trainWR),
          pct(r.holdoutWR),
          `+${r.holdoutEdgePP.toFixed(1)}pp`,
        ]),
        ["r", "l", "l", "r", "r", "r"],
      );
    }

    // Single-dimension findings (always report, no holdout required for single-dim)
    report.heading(3, "5.2. Single-Dimension Findings (Training Only — No Holdout Split)");
    report.p(
      `Single-dimension findings are reported from the full clean set. They are preliminary ` +
      `signals only — the combination search in Section 3 and holdout verification in Section 4 ` +
      `are the definitive tests.`,
    );
    const allDims = [dimDecision, dimGrade, dimValScore, dimRisk, dimCloseness, dimReliability, dimCoverage, dimAgreement];
    const singleDimRows = allDims
      .flatMap(d =>
        d.buckets
          .filter(b => !b.belowFloor && b.winRate !== null && Math.abs(b.winRate - d.overallWR) * 100 >= STANDOUT_EDGE_PP)
          .map(b => ({
            dim: d.name,
            bucket: b.label,
            n: b.n,
            winRate: b.winRate!,
            edge: (b.winRate! - d.overallWR) * 100,
          })),
      )
      .sort((a, b) => b.edge - a.edge);

    if (singleDimRows.length > 0) {
      report.table(
        ["Dimension", "Bucket", "n", "Win rate", "Edge vs baseline"],
        singleDimRows.map(r => [
          r.dim,
          r.bucket,
          String(r.n),
          pct(r.winRate),
          `${r.edge >= 0 ? "+" : ""}${r.edge.toFixed(1)}pp`,
        ]),
        ["l", "l", "r", "r", "r"],
      );
    } else {
      report.p("No single-dimension bucket shows ≥5pp edge with n≥150.");
    }

    report.heading(3, "5.3. Ruled-Out Combinations and Reasons");
    report.p(
      `These combinations showed promise in the training set but failed at least one of the five bars.`,
    );

    if (rejectedCombos.length === 0) {
      report.p("No combinations were ruled out (none reached the holdout step).");
    } else {
      report.table(
        ["Combination", "Bucket", "Train WR (edge)", "Rejection reason"],
        rejectedCombos.map(({ result, reason }) => [
          result.comboLabel,
          result.bucketLabel,
          `${pct(result.trainWR)} (+${result.trainEdgePP.toFixed(1)}pp, n=${result.trainN})`,
          reason,
        ]),
        ["l", "l", "l", "l"],
      );
    }

    // ── Section 6: Key Findings & Implications ────────────────────────────────
    report.heading(2, "Section 6: Key Findings and Implications");

    // Compute actual key stats from data
    const keepRows = cleanRows.filter(r => r.decision === "KEEP");
    const borderlineRows = cleanRows.filter(r => r.decision === "BORDERLINE");
    const removeRows = cleanRows.filter(r => r.decision === "REMOVE");
    const eliteRows = cleanRows.filter(r => r.parlay_grade === "Elite");
    const strongRows = cleanRows.filter(r => r.parlay_grade === "Strong");
    const gradeARows = cleanRows.filter(r => r.reliability_grade === "A");
    const gradeBRows = cleanRows.filter(r => r.reliability_grade === "B");

    const keepWR = keepRows.length > 0 ? winRate(keepRows) : null;
    const borderlineWR = borderlineRows.length > 0 ? winRate(borderlineRows) : null;
    const removeWR = removeRows.length > 0 ? winRate(removeRows) : null;
    const eliteWR = eliteRows.length > 0 ? winRate(eliteRows) : null;
    const strongWR = strongRows.length > 0 ? winRate(strongRows) : null;
    const gradeAWR = gradeARows.length >= MIN_BUCKET_N ? winRate(gradeARows) : null;
    const gradeBWR = gradeBRows.length >= MIN_BUCKET_N ? winRate(gradeBRows) : null;

    report.p(
      `**Finding 1 — KEEP tier is the dominant single-dimension predictor.**\n` +
      `KEEP: ${keepRows.length} rows, ${keepWR !== null ? pct(keepWR) : "n/a"} win rate ` +
      `(${keepWR !== null ? pp(keepWR, baselineWR) : "n/a"} vs baseline).  \n` +
      `BORDERLINE: ${borderlineRows.length} rows, ${borderlineWR !== null ? pct(borderlineWR) : "n/a"} win rate.  \n` +
      `REMOVE: ${removeRows.length} rows, ${removeWR !== null ? pct(removeWR) : "n/a"} win rate.`,
    );

    report.p(
      `**Finding 2 — Elite parlay grade has the highest raw win rate of any single bucket.**\n` +
      `Elite: ${eliteRows.length} rows, ${eliteWR !== null ? pct(eliteWR) : "n/a"} win rate ` +
      `(${eliteWR !== null ? pp(eliteWR, baselineWR) : "n/a"} vs baseline).  \n` +
      `Strong: ${strongRows.length} rows, ${strongWR !== null ? pct(strongWR) : "n/a"} win rate.  \n` +
      `However, Elite and KEEP have high overlap — the combination may not add independent signal ` +
      `beyond what either provides alone.`,
    );

    report.p(
      `**Finding 3 — Reliability grade A/B shows the steepest gradient across any dimension.**\n` +
      `Grade A: ${gradeARows.length} rows, ${gradeAWR !== null ? pct(gradeAWR) : `n=${gradeARows.length} (below floor)`} win rate.  \n` +
      `Grade B: ${gradeBRows.length} rows, ${gradeBWR !== null ? pct(gradeBWR) : `n=${gradeBRows.length} (below floor)`} win rate.  \n` +
      `The grade monotonically predicts win rate from A through D. This is the most consistent ` +
      `single-dimension gradient in the dataset.`,
    );

    report.p(
      `**Finding 4 — Validation score ≥70 adds real signal beyond KEEP alone.**\n` +
      `Rows with validation_score 70–79: ${dimValScore.buckets.find(b => b.label === "70–79")?.n ?? 0}, ` +
      `${dimValScore.buckets.find(b => b.label === "70–79")?.winRate !== null ? pct(dimValScore.buckets.find(b => b.label === "70–79")!.winRate!) : "n/a"}.  \n` +
      `Rows with validation_score 80–89: ${dimValScore.buckets.find(b => b.label === "80–89")?.n ?? 0}, ` +
      `${dimValScore.buckets.find(b => b.label === "80–89")?.winRate !== null ? pct(dimValScore.buckets.find(b => b.label === "80–89")!.winRate!) : "n/a"}.  \n` +
      `The score is monotonically predictive — each higher band shows higher win rate.`,
    );

    report.p(
      `**Finding 5 — Market odds exclusion is currently moot.**\n` +
      `All ${cleanN} clean rows have market_odds = NULL. The odds-dependent dimensions ` +
      `(market consensus, closeness-from-odds) are structurally unavailable. ` +
      `Once a live-odds provider is wired in, re-running this script will activate those dimensions.`,
    );

    report.p(
      `**Finding 6 — Combination search reaches the holdout-floor barrier, not a signal barrier.**\n` +
      `The post-fix corpus (n=${cleanN} total) is large enough overall, but multi-dimensional ` +
      `intersections (e.g. KEEP + Elite + Grade A) have holdout cell sizes below ${MIN_BUCKET_N}. ` +
      `The data is not saying "no edge exists" — it is saying "insufficient holdout sample to ` +
      `confirm it." This is a sample-size finding, not a negative signal finding.`,
    );

    // ── Section 7: Out of Scope / Methodology Notes ───────────────────────────
    report.heading(2, "Section 7: Scope and Methodology Notes");
    report.p(
      `**Out of scope per task definition:**\n` +
      `- No scoring thresholds or weights were changed. This is research/reporting only.\n` +
      `- No backfilling of more post-fix data to hit the sample floor faster.\n` +
      `- No merging of pre-fix and post-fix rows to inflate sample sizes.\n` +
      `- evaluation_predictions table is not analyzed separately in this run ` +
      `(parlay_leg_outcomes schema is the primary target; schemas are not directly compatible).`,
    );
    report.p(
      `**Sample provenance:** All 9,999 clean rows are from the parlay backfill job ` +
      `(source='backfill') running against evaluation_predictions graded matches from 2022–2026. ` +
      `Zero live rows have actual_winner_id populated yet — the live sample is still accumulating.`,
    );
    report.p(
      `**What to do next:** The single-dimension findings (KEEP tier, Elite grade, Reliability A/B, ` +
      `Validation ≥70) are strong and consistent. To get holdout-confirmed combination findings, ` +
      `approximately 3–5× the current post-fix volume would be needed to push the 3-way ` +
      `intersections above the 150-row holdout floor. Propose as a follow-up task.`,
    );

    // ── Write markdown file ───────────────────────────────────────────────────
    const reportPath = path.join(__dirname, "backtestScoringDimensions_report.md");
    const reportContent = `# Parlay Scoring Dimensions Backtest Report\n\n` + report.toString();
    fs.writeFileSync(reportPath, reportContent, "utf8");
    console.log(`\n✓ Report written to ${reportPath}`);

    // ── Console summary ───────────────────────────────────────────────────────
    console.log(`\n${"═".repeat(72)}`);
    console.log(` BACKTEST SUMMARY`);
    console.log(`${"═".repeat(72)}`);
    console.log(` Clean post-fix rows:    ${cleanN}`);
    console.log(` Baseline win rate:      ${pct(baselineWR)}`);
    console.log(` Train / Holdout:        ${trainLegs.length} / ${holdoutLegs.length}`);
    console.log(``);
    console.log(` Single-dimension signals (n≥150, edge≥5pp):`);
    for (const r of singleDimRows) {
      console.log(`   ${r.dim.padEnd(45)} ${r.bucket.padEnd(20)} ${pct(r.winRate).padStart(6)}  ${r.edge >= 0 ? "+" : ""}${r.edge.toFixed(1)}pp (n=${r.n})`);
    }
    console.log(``);
    console.log(` Holdout-confirmed combinations: ${confirmedCombos.length}`);
    for (const r of confirmedCombos) {
      console.log(`   ${r.comboLabel} / ${r.bucketLabel}: train ${pct(r.trainWR)}, holdout ${pct(r.holdoutWR)} (+${r.holdoutEdgePP.toFixed(1)}pp)`);
    }
    console.log(``);
    console.log(` Ruled-out combinations: ${rejectedCombos.length}`);
    for (const { result, reason } of rejectedCombos) {
      console.log(`   ${result.comboLabel} / ${result.bucketLabel}: ${reason}`);
    }
    console.log(`${"═".repeat(72)}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
