/**
 * verifyScoringFix.ts — Quick live verification for the coverage/grade/risk fixes.
 *
 * Runs the same pure scoring path as the Parlay Builder UI (__TEST_computeScoring mirrors
 * computeBuilderScore exactly, no DB or provider calls needed) against a hardcoded batch of
 * realistic matchups.
 *
 * Usage:  pnpm exec tsx src/scripts/verifyScoringFix.ts
 *
 * What to look for:
 *   • dataCoverage = 100 for well-covered matches (was hardcoded 73 before the fix)
 *   • Grade A appearing in well-validated matches (was unreachable before)
 *   • Same-day-played rows showing riskScore ~18+ higher than their "no fatigue" twin
 */

import {
  __TEST_computeScoring,
  type PlayerStats,
} from "../services/parlayBuilder/builderScoringService.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function stats(overrides: Partial<PlayerStats> & { total: number }): PlayerStats {
  const { total } = overrides;
  const surfaceTotal = overrides.surfaceTotal ?? 0;
  return {
    total,
    winRate:                    overrides.winRate                    ?? 0.50,
    winRateConfidence:          Math.min(1, total / 10),
    surfaceTotal,
    surfaceWinRate:             overrides.surfaceWinRate             ?? 0.50,
    surfaceWinRateConfidence:   Math.min(1, surfaceTotal / 5),
    recentWinRate:              overrides.recentWinRate              ?? 0.50,
    recentWinRateConfidence:    Math.min(1, Math.min(total, 10) / 5),
    avgOppRank:                 overrides.avgOppRank                 ?? 100,
    surfaceAvgOppRank:          overrides.surfaceAvgOppRank          ?? 100,
    retirementRate:             overrides.retirementRate             ?? 0.00,
    lastMatchDate:              overrides.lastMatchDate              ?? null,
    currentRank:                overrides.currentRank                ?? null,
    tournamentWinRate:          overrides.tournamentWinRate          ?? 0.50,
    tournamentTotal:            overrides.tournamentTotal            ?? 0,
    quarterWinRates:            overrides.quarterWinRates            ?? [],
  };
}

/** Date N days ago (positive = past) */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// ─── Match batch ─────────────────────────────────────────────────────────────
//
// Mix of:
//  • Strong ATP favourite (expect Grade A coverage=100)
//  • Clear WTA favourite with surface data
//  • Near-50/50 match (expect closeness floor to push risk up)
//  • Thin-data scenario (expect THIN_DATA_RISK_FLOOR ≥ 45)
//  • Same-day fatigue pair — compare identical matches ±lastMatchDate

const MATCHES: Array<{
  label: string;
  sel: PlayerStats;
  opp: PlayerStats;
  surface?: string;
  marketOdds?: number;
  h2h?: Array<{ winner_id: string | null }>;
  note?: string;
}> = [
  // ── 1. ATP dominant favourite – should reach Grade A, coverage 100 ──────
  //
  // Grade A requires validationScore >= 76 AND coverage >= 80.  To push validationScore
  // above 76 we need ALL factor scores well above neutral (50).  Two traps:
  //   a) travelFatigue is "limited" (score 50, drags average down) when opp.lastMatchDate=null.
  //      Setting BOTH dates gives a computed travelFatigue score > 50 (sel rested 4d > opp 1d).
  //   b) h2h winner_id must match selResolvedId ("sel-id" default OR pass selResolvedId explicitly).
  {
    label: "Sinner vs Rune (ATP Hard, Grade A target)",
    sel: stats({ total: 60, winRate: 0.84, recentWinRate: 0.88, surfaceTotal: 28, surfaceWinRate: 0.87, currentRank: 1, avgOppRank: 38, lastMatchDate: daysAgo(4) }),
    opp: stats({ total: 40, winRate: 0.52, recentWinRate: 0.50, surfaceTotal: 18, surfaceWinRate: 0.50, currentRank: 18, avgOppRank: 60, lastMatchDate: daysAgo(1) }),
    surface: "Hard", marketOdds: 1.22,
    h2h: [{ winner_id: "sel-id" }, { winner_id: "sel-id" }, { winner_id: "sel-id" }, { winner_id: "opp-id" }],
    note: "Expect Grade A, coverage 100",
  },

  // ── 2. WTA strong pick with surface data ─────────────────────────────────
  {
    label: "Sabalenka vs Navarro (WTA Hard)",
    sel: stats({ total: 60, winRate: 0.76, recentWinRate: 0.80, surfaceTotal: 28, surfaceWinRate: 0.79, currentRank: 2, avgOppRank: 40, lastMatchDate: daysAgo(2) }),
    opp: stats({ total: 35, winRate: 0.58, recentWinRate: 0.55, surfaceTotal: 15, surfaceWinRate: 0.57, currentRank: 22, avgOppRank: 70 }),
    surface: "Hard", marketOdds: 1.40,
    note: "Expect Grade A or strong B, coverage 100",
  },

  // ── 3. ATP coin-flip — closeness floor should push risk high ─────────────
  {
    label: "Alcaraz vs Fritz (ATP Hard, near-50/50)",
    sel: stats({ total: 48, winRate: 0.68, recentWinRate: 0.60, surfaceTotal: 20, surfaceWinRate: 0.65, currentRank: 3, lastMatchDate: daysAgo(2) }),
    opp: stats({ total: 42, winRate: 0.65, recentWinRate: 0.65, surfaceTotal: 18, surfaceWinRate: 0.66, currentRank: 6 }),
    surface: "Hard", marketOdds: 1.80,
    note: "Close match — expect high riskScore (closeness floor), Grade B/C",
  },

  // ── 4. WTA moderate pick, no market odds ─────────────────────────────────
  {
    label: "Swiatek vs Gauff (WTA Clay, no odds)",
    sel: stats({ total: 62, winRate: 0.80, recentWinRate: 0.75, surfaceTotal: 30, surfaceWinRate: 0.87, currentRank: 1, avgOppRank: 30, lastMatchDate: daysAgo(4) }),
    opp: stats({ total: 48, winRate: 0.67, recentWinRate: 0.65, surfaceTotal: 22, surfaceWinRate: 0.60, currentRank: 4 }),
    surface: "Clay",
    note: "No odds — marketConsensus limited; check coverage still 100",
  },

  // ── 5. Thin data — both players under 5 matches → THIN_DATA_RISK_FLOOR ──
  {
    label: "Preston vs Emerson (WTA, thin data)",
    sel: stats({ total: 3, winRate: 0.67, recentWinRate: 0.67, currentRank: 180 }),
    opp: stats({ total: 2, winRate: 0.50, recentWinRate: 0.50, currentRank: 200 }),
    surface: "Hard",
    note: "Thin data — expect riskScore ≥ 45 (THIN_DATA_RISK_FLOOR)",
  },

  // ── 6. Same-day fatigue pair — no fatigue baseline ───────────────────────
  //
  // Design notes for a clean +18 delta:
  //   • Both players have poor recent form (recentWinRate ~0.35) so neither recent-form
  //     bonus fires and no market/rank reductions bury the penalty.
  //   • No market odds → no market-implied closeness signal → closeness floor stays near-zero.
  //   • Clear win-rate gap (0.67 vs 0.35) keeps closeness floor low so raw risk dominates.
  //   • With baseline (no lastMatchDate → selDaysRest=null → 0 fatigue penalty), raw risk
  //     sits comfortably above the near-zero closeness floor. Adding +18 for same-day is
  //     unmasked. (A strongly-favoured player's large agreement bonus pushes raw risk below
  //     the floor when using market odds, making the delta invisible in the final score.)
  {
    label: "Kvitova vs Qualifier — NO fatigue (baseline)",
    sel: stats({ total: 28, winRate: 0.67, recentWinRate: 0.35, surfaceTotal: 12, surfaceWinRate: 0.68, currentRank: 28, lastMatchDate: null }),
    opp: stats({ total: 22, winRate: 0.35, recentWinRate: 0.38, surfaceTotal: 8, surfaceWinRate: 0.34, currentRank: 180 }),
    surface: "Hard",
    note: "No fatigue penalty — establishes raw-risk baseline",
  },

  // ── 6b. Same-day fatigue pair B — played TODAY (+18) ────────────────────
  {
    label: "Kvitova vs Qualifier — PLAYED TODAY (+18)",
    sel: stats({ total: 28, winRate: 0.67, recentWinRate: 0.35, surfaceTotal: 12, surfaceWinRate: 0.68, currentRank: 28, lastMatchDate: daysAgo(0) }),
    opp: stats({ total: 22, winRate: 0.35, recentWinRate: 0.38, surfaceTotal: 8, surfaceWinRate: 0.34, currentRank: 180 }),
    surface: "Hard",
    note: "Same-day flag fires — delta vs baseline should be ≥ 15",
  },

  // ── 7. ATP strong with H2H edge, yesterday's match ───────────────────────
  {
    label: "Medvedev vs Tsitsipas (ATP Hard, played yesterday)",
    sel: stats({ total: 50, winRate: 0.69, recentWinRate: 0.70, surfaceTotal: 22, surfaceWinRate: 0.72, currentRank: 5, avgOppRank: 40, lastMatchDate: daysAgo(1) }),
    opp: stats({ total: 48, winRate: 0.63, recentWinRate: 0.60, surfaceTotal: 20, surfaceWinRate: 0.60, currentRank: 12, avgOppRank: 50 }),
    surface: "Hard", marketOdds: 1.55,
    h2h: [{ winner_id: "sel" }, { winner_id: "sel" }, { winner_id: "sel" }, { winner_id: "opp" }, { winner_id: "sel" }],
    note: "Played yesterday — expect +10 risk vs. rested equivalent",
  },

  // ── 8. WTA clay specialist — no h2h data ────────────────────────────────
  {
    label: "Paolini vs Boulter (WTA Clay specialist)",
    sel: stats({ total: 38, winRate: 0.65, recentWinRate: 0.70, surfaceTotal: 16, surfaceWinRate: 0.75, currentRank: 5, lastMatchDate: daysAgo(3) }),
    opp: stats({ total: 30, winRate: 0.55, recentWinRate: 0.50, surfaceTotal: 10, surfaceWinRate: 0.42, currentRank: 28 }),
    surface: "Clay", marketOdds: 1.50,
    note: "Clay specialist advantage — no H2H",
  },

  // ── 9. ITF/Challenger — no rank, no odds, moderate data ─────────────────
  {
    label: "Hontama vs Hibino (ITF Hard, no rank/odds)",
    sel: stats({ total: 18, winRate: 0.58, recentWinRate: 0.60, surfaceTotal: 6, surfaceWinRate: 0.60 }),
    opp: stats({ total: 15, winRate: 0.53, recentWinRate: 0.53, surfaceTotal: 5, surfaceWinRate: 0.54 }),
    surface: "Hard",
    note: "No rank, no market odds, modest data — Grade C/D expected",
  },

  // ── 10. ATP top-rank blowout with stale data ─────────────────────────────
  {
    label: "Djokovic vs qualifier (stale data >90d)",
    sel: stats({ total: 80, winRate: 0.85, recentWinRate: 0.80, surfaceTotal: 35, surfaceWinRate: 0.88, currentRank: 3, lastMatchDate: daysAgo(95) }),
    opp: stats({ total: 8, winRate: 0.45, recentWinRate: 0.40, currentRank: 300 }),
    surface: "Hard", marketOdds: 1.05,
    note: "Stale sel (95d since last match) + weak opp",
  },
];

// ─── Run scoring ─────────────────────────────────────────────────────────────

interface Row {
  label: string;
  coverage: number;
  grade: string;
  parlayGrade: string;
  risk: number;
  score: number;
  decision: string;
  sameDayFlag: boolean;
  note: string;
}

const rows: Row[] = MATCHES.map(({ label, sel, opp, surface, marketOdds, h2h, note }) => {
  const r = __TEST_computeScoring(sel, opp, {
    selectedPlayerName: label.split(" vs ")[0] ?? "Selected",
    opponentName: label.split(" vs ")[1]?.split(" (")[0] ?? "Opponent",
    selResolvedId: "sel",
    surface: surface ?? null,
    marketOdds: marketOdds ?? null,
    h2hMatches: h2h ?? [],
  });

  const sameDayFlag = sel.lastMatchDate != null &&
    Math.floor((Date.now() - sel.lastMatchDate.getTime()) / 86_400_000) === 0;

  return {
    label,
    coverage: r.dataCoverage,
    grade: r.reliabilityGrade,
    parlayGrade: r.parlayGrade,
    risk: r.riskScore,
    score: r.validationScore,
    decision: "KEEP/BORDERLINE/REMOVE — (test helper only returns factors; see note)",
    sameDayFlag,
    note: note ?? "",
  };
});

// ─── Print table ─────────────────────────────────────────────────────────────

const COL = {
  label: 46, coverage: 10, grade: 7, parlayGrade: 10, risk: 6, score: 7,
};

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const header = [
  pad("Match", COL.label),
  pad("Coverage", COL.coverage),
  pad("Grade", COL.grade),
  pad("Parlay", COL.parlayGrade),
  pad("Risk", COL.risk),
  pad("ValScore", COL.score),
  "Fatigue?  Note",
].join("│ ");

const hr = "─".repeat(header.length);

console.log("\n");
console.log("══════════════════════════════════════════════════════════════════════════════════════════");
console.log("  SCORING FIX VERIFICATION — live run against __TEST_computeScoring");
console.log("  Coverage fix: structural 27% excluded from denominator → 73% hardcode now = 100%");
console.log("  Same-day fatigue: played today → risk +18 (was 0)");
console.log("══════════════════════════════════════════════════════════════════════════════════════════");
console.log();
console.log(header);
console.log(hr);

for (const r of rows) {
  const fatigueMarker = r.sameDayFlag ? "⚑ TODAY " : "         ";
  console.log([
    pad(r.label, COL.label),
    pad(`${r.coverage}%`, COL.coverage),
    pad(r.grade, COL.grade),
    pad(r.parlayGrade, COL.parlayGrade),
    pad(r.risk, COL.risk),
    pad(r.score, COL.score),
    `${fatigueMarker}  ${r.note}`,
  ].join("│ "));
}

console.log(hr);

// ─── Summary stats ───────────────────────────────────────────────────────────

const coverages   = rows.map(r => r.coverage);
const avgCoverage = Math.round(coverages.reduce((s, v) => s + v, 0) / coverages.length);
const gradeCounts = {} as Record<string, number>;
for (const r of rows) gradeCounts[r.grade] = (gradeCounts[r.grade] ?? 0) + 1;

console.log();
console.log("── Summary ─────────────────────────────────────────────────────────────────────────────");
console.log(`  Coverage  min=${Math.min(...coverages)}%  max=${Math.max(...coverages)}%  avg=${avgCoverage}%`);
console.log(`  Grades    ${Object.entries(gradeCounts).sort().map(([g, n]) => `${g}:${n}`).join("  ")}`);
console.log();

// ─── Same-day fatigue delta ───────────────────────────────────────────────────

const baseline  = rows.find(r => r.label.includes("NO fatigue"));
const sameDay   = rows.find(r => r.label.includes("PLAYED TODAY"));
if (baseline && sameDay) {
  const delta = sameDay.risk - baseline.risk;
  const ok    = delta >= 15;
  console.log("── Same-day fatigue penalty ─────────────────────────────────────────────────────────────");
  console.log(`  Baseline (no fatigue)  risk = ${baseline.risk}`);
  console.log(`  Same-day (played today) risk = ${sameDay.risk}`);
  console.log(`  Delta = ${delta > 0 ? "+" : ""}${delta}  ${ok ? "✓ ≥ 15pt — penalty confirmed" : "✗ < 15pt — check same-day branch"}`);
  console.log();
}

// ─── Grade A check ───────────────────────────────────────────────────────────

const gradeARows = rows.filter(r => r.grade === "A");
console.log("── Grade A reachability ─────────────────────────────────────────────────────────────────");
if (gradeARows.length > 0) {
  console.log(`  ✓ Grade A reached in ${gradeARows.length} match(es):`);
  for (const r of gradeARows) console.log(`    • ${r.label} (coverage=${r.coverage}%, risk=${r.risk}, score=${r.score})`);
} else {
  console.log("  ✗ No Grade A matches — validationScore may be below 76 for all test cases");
  const bestScore = Math.max(...rows.map(r => r.score));
  const bestScoreRow = rows.find(r => r.score === bestScore);
  console.log(`  Best validationScore = ${bestScore} (${bestScoreRow?.label}) — Grade A needs ≥ 76`);
}
console.log();

// ─── Coverage ceiling check ──────────────────────────────────────────────────

const all100 = rows.filter(r => r.coverage === 100);
const below100 = rows.filter(r => r.coverage < 100);
console.log("── Coverage ceiling ─────────────────────────────────────────────────────────────────────");
console.log(`  100% coverage: ${all100.length} matches (was 0 before fix — all were hardcoded 73%)`);
if (below100.length > 0) {
  console.log(`  Below 100%: ${below100.map(r => `${r.label.split(" (")[0]} (${r.coverage}%)`).join(", ")}`);
}
console.log();
console.log("══════════════════════════════════════════════════════════════════════════════════════════\n");
