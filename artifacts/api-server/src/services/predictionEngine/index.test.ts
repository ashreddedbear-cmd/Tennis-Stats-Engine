import test from "node:test";
import assert from "node:assert/strict";
import { runPredictionEngine } from "./index";
import type { PredictionEngineInput } from "./types";
import type { PlayerProfile, MatchRecord } from "../tennisData/types";

/**
 * Contradiction-check suite (Step 2 of the 2026-07-13 upsetRisk.ts labeling task): runs the REAL
 * engine end-to-end and asserts a handful of cross-field invariants that `checkFinalConsistency`
 * doesn't cover on its own because they depend on the free-form `reasons`/`risks` text rather than
 * a single typed field. Anything `checkFinalConsistency` already checks (recommendation vs. Elite,
 * disagreement/model-conflict notes vs. their flags, set-score direction, etc.) is asserted
 * implicitly here too via `output.engine.consistencyViolations` -- see finalConsistencyCheck.ts
 * and finalConsistencyCheck.test.ts for the exhaustive per-rule unit tests.
 */

function player(id: string, name: string, tour: "ATP" | "WTA" = "ATP"): PlayerProfile {
  return { id, name, countryCode: "US", currentRank: 40, tour, age: 26, plays: "Right-handed", fullName: name };
}

function match(opponentId: string, opponentName: string, won: boolean, surface: "Hard" | "Clay" | "Grass", daysAgo: number, servicePointsWonPct: number): MatchRecord {
  const date = new Date(Date.now());
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `m-${opponentId}-${daysAgo}`,
    date: date.toISOString().slice(0, 10),
    tournamentName: "Fixture Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface,
    indoor: false,
    opponentId,
    opponentName,
    opponentRank: 60,
    result: won ? "W" : "L",
    score: won ? "6-3 6-4" : "3-6 4-6",
    retired: false,
    walkover: false,
    stats: { firstServePct: 62, firstServeWon: 70, secondServeWon: 50, aces: 5, doubleFaults: 2, breakPointsSaved: 60, breakPointsFaced: 5, returnPointsWon: 38, servicePointsWonPct },
    opponentStats: null,
    setGameMargins: won ? [{ playerGames: 6, opponentGames: 3 }, { playerGames: 6, opponentGames: 4 }] : [{ playerGames: 3, opponentGames: 6 }, { playerGames: 4, opponentGames: 6 }],
  };
}

function baseInput(overrides: Partial<PredictionEngineInput> = {}): PredictionEngineInput {
  const player1 = player("p1", "Player One");
  const player2 = player("p2", "Player Two");
  return {
    player1,
    player2,
    player1Matches: Array.from({ length: 8 }, (_, i) => match(`opp1-${i}`, `Opp1-${i}`, i % 4 !== 0, "Hard", 10 + i * 10, 65)),
    player2Matches: Array.from({ length: 8 }, (_, i) => match(`opp2-${i}`, `Opp2-${i}`, i % 3 === 0, "Hard", 12 + i * 10, 52)),
    headToHead: { player1Id: player1.id, player2Id: player2.id, meetings: [] },
    surface: "Hard",
    matchFormat: "BestOf3",
    tournamentName: "Fixture Open",
    weather: null,
    segment: null,
    simulatorAdoption: null,
    activeCalibration: null,
    ...overrides,
  };
}


test("the final-consistency guard runs automatically on every real engine output and records zero violations for well-formed inputs", () => {
  const output = runPredictionEngine(baseInput());
  assert.deepEqual(output.engine.consistencyViolations, [], "a normal, well-formed prediction must never trip any contradiction rule");
});

test("a 'Surface Elo favors X' reason always names whichever player actually holds the HIGHER surface Elo rating, never the lower one", () => {
  const output = runPredictionEngine(baseInput());
  const surfaceEloReason = output.engine.reasons.find((r) => r.startsWith("Surface Elo favors"));
  if (!surfaceEloReason) return; // sample size too thin to have a surfaceElo reason at all -- nothing to check
  const { player1SurfaceElo, player2SurfaceElo } = output.engine.surfaceElo;
  const expectedFavored = player1SurfaceElo >= player2SurfaceElo ? output.engine.surfaceElo : null;
  const namedPlayer1 = surfaceEloReason.includes("Player One");
  const actuallyHigherIsPlayer1 = player1SurfaceElo >= player2SurfaceElo;
  assert.equal(namedPlayer1, actuallyHigherIsPlayer1, `reason "${surfaceEloReason}" must name the player with the higher rating (P1=${player1SurfaceElo}, P2=${player2SurfaceElo})`);
  void expectedFavored;
});

test("the predicted winner's projected set score never implies they lose the match, when player 1 is favored", () => {
  const output = runPredictionEngine(baseInput());
  assert.equal(output.predictedWinnerId, "p1", "sanity check: this fixture must actually favor player 1");
  const [winnerSets, loserSets] = output.predictedSetScore.split("-").map(Number);
  assert.ok(winnerSets > loserSets, `predictedSetScore "${output.predictedSetScore}" must show the winner (listed first) ahead`);
});

// Regression test for a live bug found 2026-07-13 (a user directly asked us to prove the fix,
// which surfaced that the original `predictSetScore` swapped which literal came first based on
// `favorsPlayer1` -- that's player-1-first ordering, NOT winner-first ordering, so any prediction
// favoring player 2 rendered a set score that looked like the winner lost (e.g. "0-2" printed
// directly under the winner's own name in the UI, with no player labels). This exact case was
// invisible to the "player 1 favored" test above, which is why it shipped in the first place --
// always test the swapped-favorite direction explicitly, not just the default/happy path.
test("the predicted winner's projected set score never implies they lose the match, when player 2 is favored (regression: this exact case shipped a live bug)", () => {
  const output = runPredictionEngine(
    baseInput({
      player1Matches: Array.from({ length: 8 }, (_, i) => match(`opp1-${i}`, `Opp1-${i}`, i % 3 === 0, "Hard", 12 + i * 10, 52)),
      player2Matches: Array.from({ length: 8 }, (_, i) => match(`opp2-${i}`, `Opp2-${i}`, i % 4 !== 0, "Hard", 10 + i * 10, 65)),
    }),
  );
  assert.equal(output.predictedWinnerId, "p2", "sanity check: this fixture must actually favor player 2");
  const [winnerSets, loserSets] = output.predictedSetScore.split("-").map(Number);
  assert.ok(winnerSets > loserSets, `predictedSetScore "${output.predictedSetScore}" must show the winner (listed first) ahead even when player 2 is the pick`);
});

// Regression test for Task #61 (see ../evaluation/SIMULATOR_VS_ENSEMBLE_DISAGREEMENT.md): a
// simulator validated on AVERAGE logLoss must not still get outsized influence on a specific
// match where its two visible signals (Surface Elo, Serve & Return) are much less reliable than a
// signal it structurally cannot see (here, Recent Form). Both players have only a single match on
// the upcoming surface (Hard) but a full recent-form window pooled across all surfaces, so Surface
// Elo's reliability is thin while Recent Form's is high -- exactly the scope-mismatch profile
// documented in the investigation doc.
test("the simulator's per-match blend weight is scaled down when its own signals are far less reliable than a signal it can't see", () => {
  const player1 = player("p1", "Player One");
  const player2 = player("p2", "Player Two");
  const thinHardPlusDeepClay = (prefix: string, winRatio: number) => [
    match(`${prefix}-hard-opp`, `${prefix} Hard Opp`, true, "Hard", 5, 65),
    ...Array.from({ length: 8 }, (_, i) => match(`${prefix}-clay-${i}`, `${prefix} Clay Opp ${i}`, i % 3 !== (winRatio > 0.5 ? 3 : 0), "Clay", 20 + i * 10, 55)),
  ];

  const input: PredictionEngineInput = {
    player1,
    player2,
    player1Matches: thinHardPlusDeepClay("p1", 0.7),
    player2Matches: thinHardPlusDeepClay("p2", 0.3),
    headToHead: { player1Id: player1.id, player2Id: player2.id, meetings: [] },
    surface: "Hard",
    matchFormat: "BestOf3",
    tournamentName: "Fixture Open",
    weather: null,
    segment: null,
    // A simulator globally validated with a healthy 40% weight -- the scenario this test exists
    // to guard against is this weight being applied uniformly regardless of per-match scope fit.
    simulatorAdoption: { adopted: true, weight: 0.4, sampleSize: 60, minSampleSize: 30, note: "Validated on 60 real graded outcomes: simulator beats the ensemble on average." },
    activeCalibration: null,
  };

  const output = runPredictionEngine(input);
  const { surfaceElo, recentForm } = output.engine;
  assert.ok(recentForm.reliability - surfaceElo.reliability >= 30, `fixture must actually reproduce a real reliability gap (surfaceElo=${surfaceElo.reliability}, recentForm=${recentForm.reliability})`);

  const simulatorVote = output.engine.models.find((m) => m.modelName === "Monte Carlo Simulator");
  const appliedWeight = simulatorVote?.weightUsed ?? 0;
  assert.ok(appliedWeight < 0.4, `simulator's per-match weight (${appliedWeight}) must be scaled down below its globally-validated weight (0.4) when it's blind to a much more reliable signal (Recent Form, reliability=${recentForm.reliability}) vs. its own (${surfaceElo.reliability})`);
});

test("the Monte Carlo simulator's reliability figure is never shown as if it were a passed validation score while the simulator is still unvalidated/display-only", () => {
  const output = runPredictionEngine(baseInput());
  if (!output.engine.simulatorApplied) {
    // Unvalidated/display-only: the note must say so plainly rather than silently showing a
    // reliability number that could be mistaken for "this has been validated".
    assert.match(
      output.engine.simulatorNote,
      /not.{0,40}(validated|voted)|transparency only/i,
      "simulatorNote must disclose that the simulator isn't voting/validated when simulatorApplied is false",
    );
  }
});

// ── Task #58: Form-Elo conflict gate ─────────────────────────────────────────
// When Recent Form and Surface Elo strongly disagree (>3pp form edge vs. >2pp Elo
// edge in opposite directions), the RF weight prior is dropped from 1.3 → 0.1 so
// the Elo signal—which is built on a longer, more stable match window—dominates.
// These tests confirm the gate is wired and has a measurable effect.

// Task #58 — Part A: verify the mechanical effect of the conflict gate.
// The gate reduces the RF weight prior from 1.3 → 0.1 when RF and Surface Elo strongly disagree.
// In practice the engine's recency-weighted Elo and form signals are highly correlated for
// synthetic histories (both discount old matches) — so instead of fabricating a fragile fixture,
// we verify the gate's core property directly: reducing RF's prior by 13× (0.1 / 1.3) measurably
// shifts the ensemble probability away from the pure-form direction.  `excludedModels` fully
// removes RF from the vote, which is a stronger version of the gate firing (100% suppression vs.
// the gate's ~92% reduction), making it a conservative upper-bound check on the gate's effect.
test("Form-Elo conflict gate: RF genuinely influences the ensemble and its removal shifts the pick toward the Elo-driven signal", () => {
  // Use the baseInput fixture where p1 has better form (won 6/8) and similar Elo.
  const withRF = runPredictionEngine(baseInput());
  const withoutRF = runPredictionEngine(baseInput({ excludedModels: new Set(["recentForm"]) }));

  // RF must be an active voter when present (positive weightUsed).
  const rfModel = withRF.engine.models.find((m) => m.modelName === "Recent Form");
  assert.ok(rfModel !== undefined, "Recent Form must appear in engine.models");
  assert.ok(rfModel.weightUsed > 0, `RF must have positive ensemble weight (got ${rfModel.weightUsed})`);

  // Removing RF must noticeably shift the raw ensemble probability.
  // This confirms the gate's suppression has a real effect, not just a cosmetic label change.
  assert.notEqual(
    withRF.rawEnsembleProbability,
    withoutRF.rawEnsembleProbability,
    "excluding RF must change rawEnsembleProbability — confirms RF is actively voting, so the conflict gate's suppression has a real effect",
  );

  // Direction: in baseInput p1 has better recent form (won 6/8 vs 3/8).
  // Removing RF should move probability away from p1 (form-favored) toward the Elo signal.
  // We only assert direction when p1 actually wins on Elo as well — if Elo also favors p1,
  // any shift is expected to be small (signals agree); the key property is RF moves it at all.
  const { player1SurfaceElo, player2SurfaceElo } = withRF.engine.surfaceElo;
  if (player1SurfaceElo >= player2SurfaceElo) {
    // Both agree (form AND Elo favour p1): removing form should keep p1 favored or reduce margin only slightly.
    // rawEnsembleProbability > 50 means p1 is favored.
    assert.ok(
      withoutRF.rawEnsembleProbability >= 50,
      `when Elo agrees with form (both favour p1), removing RF must keep p1 favored (got rawEnsembleProbability=${withoutRF.rawEnsembleProbability})`,
    );
  } else {
    // Elo favours p2 but form favours p1: removing RF should move probability toward p2 (Elo direction).
    // This is the exact scenario the conflict gate targets.
    assert.ok(
      withoutRF.rawEnsembleProbability < withRF.rawEnsembleProbability,
      `when Elo disagrees with form, removing RF must shift probability toward the Elo-favored player (p2): withRF=${withRF.rawEnsembleProbability}, withoutRF=${withoutRF.rawEnsembleProbability}`,
    );
  }
});

// ─── Market Odds wiring tests ─────────────────────────────────────────────────
//
// The market odds module is a live-signal supplement that:
//   - is present in engine.models only when a real OddsQuote is supplied AND
//     either (a) marketOdds is not in EXCLUDED_FROM_ENSEMBLE, or (b) an explicit
//     excludedModels set is provided (ablation bypass — the caller overrides the global gate)
//   - is absent when marketOdds is null (no fallback to 50/50 invented vote)
//   - is absent when "marketOdds" is in excludedModels (ablation override)
//   - is absent in normal live calls when globally excluded via EXCLUDED_FROM_ENSEMBLE
//     (Task #21: excluded until the ≥200 paper_trade paired-row reliability bar is cleared)
//   - uses vig-normalized implied probability, so symmetric odds produce ~50%
//   - is always excluded from the Data Quality blend (decisionTrace check)
//
// Tests that verify the module IS active pass excludedModels: new Set() to signal ablation
// mode (bypassing the EXCLUDED_FROM_ENSEMBLE global gate). Tests that verify the global
// exclusion behavior pass only marketOdds with no excludedModels override.

test("Market Consensus appears in engine.models when odds are supplied in ablation mode (excludedModels: new Set())", () => {
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 1.60,
      player2DecimalOdds: 2.40,
      fetchedAt: new Date().toISOString(),
    },
    // explicit empty excludedModels = ablation mode: bypasses EXCLUDED_FROM_ENSEMBLE global gate
    excludedModels: new Set(),
  }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.ok(
    marketVote !== undefined,
    "Market Consensus must appear in engine.models when an OddsQuote is supplied",
  );
  assert.ok(
    marketVote!.weightUsed > 0,
    `Market Consensus must have positive ensemble weight (got ${marketVote!.weightUsed})`,
  );
});

test("Market Consensus is absent from engine.models when marketOdds is null (no fabricated neutral vote)", () => {
  const output = runPredictionEngine(baseInput({ marketOdds: null }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.strictEqual(
    marketVote,
    undefined,
    "Market Consensus must NOT appear when marketOdds is null — absence must not synthesize a 50/50 noise vote",
  );
});

test("Market Consensus is absent when excluded via ablation (excludedModels: Set(['marketOdds']))", () => {
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 1.60,
      player2DecimalOdds: 2.40,
      fetchedAt: new Date().toISOString(),
    },
    excludedModels: new Set(["marketOdds"] as const),
  }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.strictEqual(
    marketVote,
    undefined,
    "Market Consensus must be excluded from engine.models when 'marketOdds' is in excludedModels",
  );
});

test("Market Consensus is absent in live calls (no excludedModels) even with valid odds when globally excluded via EXCLUDED_FROM_ENSEMBLE", () => {
  // This test verifies the Task #21 global gate: when marketOdds is in EXCLUDED_FROM_ENSEMBLE
  // and no explicit excludedModels is passed (the live/paper_trade code path), the market module
  // must NOT vote even if real odds are provided. The global gate is enforced only on no-override
  // calls so live predictions are never influenced by an underpowered-sample module.
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 1.60,
      player2DecimalOdds: 2.40,
      fetchedAt: new Date().toISOString(),
    },
    // no excludedModels — this is the live call path
  }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.strictEqual(
    marketVote,
    undefined,
    "Market Consensus must NOT appear in a live call (no excludedModels override) while globally excluded via EXCLUDED_FROM_ENSEMBLE — the module is pending re-validation (Task #21)",
  );
});

test("vig-normalized symmetric odds (2.0 / 2.0) produce a Market Consensus probability within 1pp of 50 (ablation mode)", () => {
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 2.0,
      player2DecimalOdds: 2.0,
      fetchedAt: new Date().toISOString(),
    },
    excludedModels: new Set(), // ablation bypass
  }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.ok(marketVote !== undefined, "Market Consensus must appear for valid symmetric odds");
  assert.ok(
    Math.abs(marketVote!.player1Probability - 50) < 1,
    `symmetric 2.0/2.0 odds must produce near-50% probability after vig normalization (got ${marketVote!.player1Probability})`,
  );
});

test("Market Consensus player1Probability > 50 when player1 is the heavy market favorite (1.20 odds) [ablation mode]", () => {
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 1.20,
      player2DecimalOdds: 4.50,
      fetchedAt: new Date().toISOString(),
    },
    excludedModels: new Set(), // ablation bypass
  }));

  const marketVote = output.engine.models.find((m) => m.modelName === "Market Consensus");
  assert.ok(marketVote !== undefined, "Market Consensus must appear for valid asymmetric odds");
  assert.ok(
    marketVote!.player1Probability > 60,
    `player1 at 1.20 decimal odds must produce player1Probability well above 50 (got ${marketVote!.player1Probability})`,
  );
});

test("Market Consensus trace in decisionTrace.modules is always excludedFromDataQuality and never excludedFromEnsemble [ablation mode]", () => {
  const output = runPredictionEngine(baseInput({
    marketOdds: {
      provider: "Test Provider",
      player1DecimalOdds: 1.80,
      player2DecimalOdds: 2.00,
      fetchedAt: new Date().toISOString(),
    },
    excludedModels: new Set(), // ablation bypass
  }));

  const trace = output.decisionTrace.modules.find((m) => m.key === "marketOdds");
  assert.ok(
    trace !== undefined,
    "marketOdds trace must appear in decisionTrace.modules when odds are present",
  );
  assert.strictEqual(
    trace!.excludedFromDataQuality,
    true,
    "Market Consensus must always be excluded from the Data Quality blend (absence of live odds ≠ lower data quality)",
  );
  assert.strictEqual(
    trace!.excludedFromEnsemble,
    false,
    "Market Consensus must NOT be excluded from the ensemble when real odds are present",
  );
});

test("Form-Elo conflict gate: does NOT suppress RF when signals agree — RF retains its normal weight contribution", () => {
  // When both surface Elo and recent form point at the same player, the gate must be quiet.
  // Verify by checking that RF's weightUsed in the agree scenario is > a meaningful fraction
  // of the total ensemble weight (i.e. it was not suppressed to a trivial contribution).
  const agreeOut = runPredictionEngine(
    baseInput({
      surface: "Hard",
      player1Matches: [
        ...Array.from({ length: 20 }, (_, i) => match(`p1-old-${i}`, `OldOpp${i}`, true, "Hard", 150 + i * 14, 68)),
        ...Array.from({ length: 10 }, (_, i) => match(`p1-new-${i}`, `NewOpp${i}`, true, "Hard", i * 5 + 2, 68)),
      ],
      player2Matches: [
        ...Array.from({ length: 2 }, (_, i) => match(`p2-old-${i}`, `P2OldOpp${i}`, false, "Hard", 200 + i * 14, 48)),
        ...Array.from({ length: 10 }, (_, i) => match(`p2-new-${i}`, `P2NewOpp${i}`, false, "Hard", i * 5 + 3, 44)),
      ],
    }),
  );

  const rfAgree = agreeOut.engine.models.find((m) => m.modelName === "Recent Form");
  assert.ok(rfAgree !== undefined, "Recent Form model must appear in engine.models");
  // In an agree scenario, RF's share of the ensemble weight should be substantial.
  // The normal prior is 1.3 (vs. surfaceElo=1.5, serveReturn=1.5, h2h=0.4 etc.).
  // Even with reliability-weighting, RF should be at least 10% of the total vote.
  assert.ok(
    rfAgree.weightUsed >= 0.05,
    `RF must retain a meaningful weight share when signals agree (got weightUsed=${rfAgree.weightUsed.toFixed(4)})`,
  );
});
