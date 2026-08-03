import test from "node:test";
import assert from "node:assert/strict";
import { computeWeightedDisagreement, computeMatchupCloseness, buildDisagreementNote, normalizeSupportToWinner, type DisagreementModelInput } from "./disagreement";

function models(overrides: Partial<Record<string, DisagreementModelInput>>): DisagreementModelInput[] {
  return Object.values(overrides).filter((v): v is DisagreementModelInput => v !== undefined);
}

test("a low-reliability/near-zero-weight secondary model cannot flip the category by itself", () => {
  // Core models all clustered and agreeing (real signal); Fatigue votes wildly opposite but
  // carries almost none of the effective weight (as it would with reliability ~5, prior 0.4
  // against core reliabilities ~70-80 with priors 1.3-1.5).
  const withOutlier = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 62, weightUsed: 0.35 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 58, weightUsed: 0.29 },
      fatigue: { modelName: "Fatigue", player1Probability: 3, weightUsed: 0.01 },
    }),
  );
  const withoutOutlier = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 62, weightUsed: 0.35 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 58, weightUsed: 0.3 },
    }),
  );

  assert.equal(withOutlier.modelAgreement, withoutOutlier.modelAgreement, "a near-zero-weight outlier should not change the category at all");
  assert.equal(withOutlier.coreModelsConflict, false);
  assert.ok(withOutlier.modelAgreement === "Strong" || withOutlier.modelAgreement === "Moderate", `expected a healthy category, got ${withOutlier.modelAgreement}`);
});

test("core validated models genuinely conflicting in direction with real weight triggers HighDisagreement", () => {
  const { modelAgreement, coreModelsConflict } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.38 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 39, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.29 },
    }),
  );

  assert.equal(coreModelsConflict, true);
  assert.equal(modelAgreement, "HighDisagreement");
});

test("a close matchup where every model agrees on direction is low disagreement, not high, just because the probability is near 50", () => {
  // Surface Elo 53%, Serve/Return 55%, Recent Form 52% -- all favor the same player, spec Part A.E's example.
  const { modelAgreement, leadingSupportPercent, weightedStdDev } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 53, weightUsed: 0.38 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 55, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 52, weightUsed: 0.29 },
    }),
  );

  assert.equal(leadingSupportPercent, 100, "every model favors the same player, so support should be 100%");
  assert.ok(weightedStdDev < 6, `expected a tight cluster, got stddev ${weightedStdDev}`);
  assert.equal(modelAgreement, "Strong");
});

test("real disagreement can exist even when the blended probability lands well away from 50", () => {
  // Elo 68% for A, Serve/Return 61% for B (=39% for A), Recent Form 66% for A -- spec Part A.E's second example.
  const { modelAgreement, weightedStdDev } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.36 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 39, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.31 },
    }),
  );

  assert.ok(weightedStdDev > 11, `expected a wide weighted spread despite the eventual blend landing near 57%, got ${weightedStdDev}`);
  assert.equal(modelAgreement, "HighDisagreement");
});

test("buildDisagreementNote is null exactly when modelAgreement is Strong, and names the real conflicting models otherwise", () => {
  const strong = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 61, weightUsed: 0.5 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.5 },
    }),
  );
  assert.equal(buildDisagreementNote(strong, "Alice", "Bob"), null);

  const high = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.36 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 39, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.31 },
    }),
  );
  const note = buildDisagreementNote(high, "Alice", "Bob");
  assert.ok(note, "expected a non-null note for HighDisagreement");
  assert.match(note!, /Serve & Return favors Bob/);
  assert.match(note!, /Surface Elo favors Alice/);
  assert.match(note!, /Recent Form favors Alice/);
});

test("Task #146: the correlated core trio agreeing collapses to one combined vote, so it reads no stronger than a single confirming signal of the same size", () => {
  // Surface Elo/Serve & Return/Recent Form all favor the same player -- likely the same
  // underlying recent-match evidence expressed three ways, not three independent confirmations.
  const trioAgreeing = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 62, weightUsed: 0.35 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 58, weightUsed: 0.3 },
    }),
  );
  // A single vote of the same combined weight and (weighted-average) probability as the trio.
  const singleEquivalent = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 60.1, weightUsed: 1 },
    }),
  );
  assert.equal(trioAgreeing.weightedStdDev, singleEquivalent.weightedStdDev, "three agreeing correlated votes must produce the exact same spread as one combined vote of the same size");
  assert.equal(trioAgreeing.leadingSupportPercent, singleEquivalent.leadingSupportPercent);
  assert.equal(trioAgreeing.modelAgreement, singleEquivalent.modelAgreement);
});

test("Task #146: a real, independent confirming vote (Head-to-Head) still adds genuine extra support beyond the correlated trio alone", () => {
  const trioOnly = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 62, weightUsed: 0.4 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 58, weightUsed: 0.25 },
    }),
  );
  const trioPlusH2H = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 62, weightUsed: 0.32 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.28 },
      recentForm: { modelName: "Recent Form", player1Probability: 58, weightUsed: 0.2 },
      headToHead: { modelName: "Head-to-Head", player1Probability: 70, weightUsed: 0.2 },
    }),
  );
  // Head-to-Head is not in the correlated cluster, so it is never collapsed away -- it's real
  // additional weight/evidence and should be able to move the reading (unlike a fourth correlated
  // module agreeing, which the previous test shows changes nothing).
  assert.notEqual(trioOnly.weightedStdDev, trioPlusH2H.weightedStdDev);
});

test("Task #146: a genuine internal split within the correlated trio is never hidden by collapsing", () => {
  // Same inputs as the pre-existing "real disagreement... lands well away from 50" test above --
  // the trio genuinely conflicts, so collapsing must NOT apply and the real spread must still show.
  const { modelAgreement, weightedStdDev, coreModelsConflict } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.36 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 39, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.31 },
    }),
  );
  assert.equal(coreModelsConflict, true);
  assert.equal(modelAgreement, "HighDisagreement");
  assert.ok(weightedStdDev > 11, `expected the real internal spread to still show once uncollapsed, got ${weightedStdDev}`);
});

test("matchupCloseness is independent of the disagreement category", () => {
  assert.equal(computeMatchupCloseness(51), "VeryClose");
  assert.equal(computeMatchupCloseness(60), "Close");
  assert.equal(computeMatchupCloseness(75), "Moderate");
  assert.equal(computeMatchupCloseness(90), "Clear");
});

test("Task #114 regression: unanimous direction with a wide confidence spread is never HighDisagreement", () => {
  // Real reported case: Surface Elo favors I. Buse at 74% (weight 0.34), Serve & Return at 51%
  // (weight 0.34), Recent Form at 51% (weight 0.31) -- 100% of effective weight behind the same
  // player, but a wide weighted stddev previously pushed this straight to HighDisagreement.
  const { modelAgreement, coreModelsConflict, leadingSupportPercent } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 74, weightUsed: 0.34 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 51, weightUsed: 0.34 },
      recentForm: { modelName: "Recent Form", player1Probability: 51, weightUsed: 0.31 },
    }),
  );

  assert.equal(coreModelsConflict, false);
  assert.equal(leadingSupportPercent, 100, "every model favors the same player");
  assert.notEqual(modelAgreement, "HighDisagreement", "unanimous direction must never reach the highest disagreement category");
});

test("Task #114: genuine directional conflict among meaningfully-weighted models (not just core models) still reaches HighDisagreement", () => {
  // A non-core model (Availability) meaningfully conflicts with a core model -- coreModelsConflict
  // is false (only one core model is meaningfully weighted here), but the conflict is still real.
  const { modelAgreement, coreModelsConflict } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 65, weightUsed: 0.5 },
      availability: { modelName: "Availability", player1Probability: 30, weightUsed: 0.5 },
    }),
  );

  assert.equal(coreModelsConflict, false, "only one core model is present/meaningfully weighted");
  assert.equal(modelAgreement, "HighDisagreement", "a real conflict between two meaningfully-weighted models must still be flagged");
});

test("Task #114: a single negligible-weight dissenting model still cannot flip the category to HighDisagreement", () => {
  const { modelAgreement, coreModelsConflict } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 70, weightUsed: 0.45 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 65, weightUsed: 0.4 },
      recentForm: { modelName: "Recent Form", player1Probability: 5, weightUsed: 0.05 },
      availability: { modelName: "Availability", player1Probability: 60, weightUsed: 0.1 },
    }),
  );

  assert.equal(coreModelsConflict, false, "Recent Form's weight share (5%) is below the meaningful-weight floor");
  assert.notEqual(modelAgreement, "HighDisagreement");
});

test("Task #114: unanimous and tightly grouped models still earn the strongest agreement category", () => {
  const { modelAgreement } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 61, weightUsed: 0.4 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 59, weightUsed: 0.25 },
    }),
  );

  assert.equal(modelAgreement, "Strong");
});

test("Task #114: a neutral (exactly 50%) model mixed with non-neutral models does not fabricate a direction", () => {
  // By the same >=50-favors-player1 convention used throughout the engine (see
  // eliteTier.ts's voteFavorsPlayer1), an exact 50% counts toward player1's side -- this test
  // pins down that a neutral vote mixed in with real leans behaves predictably rather than
  // manufacturing a spurious conflict or an inflated spread.
  const { modelAgreement, coreModelsConflict } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.4 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 50, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.25 },
    }),
  );

  assert.equal(coreModelsConflict, false, "the neutral model favors neither side in genuine conflict -- both real leans point the same way");
  assert.notEqual(modelAgreement, "HighDisagreement");
});

test("Task #114: all-neutral (exactly 50%) models never fabricate a leader or a manufactured conflict", () => {
  const { modelAgreement, coreModelsConflict, weightedStdDev, leadingSupportPercent } = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 50, weightUsed: 0.4 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 50, weightUsed: 0.35 },
      recentForm: { modelName: "Recent Form", player1Probability: 50, weightUsed: 0.25 },
    }),
  );

  assert.equal(coreModelsConflict, false);
  assert.equal(weightedStdDev, 0, "identical values across every model, however neutral, is perfect agreement");
  assert.equal(leadingSupportPercent, 100, "every model lands on the same side of the 50 convention, consistent with voteFavorsPlayer1 elsewhere");
  assert.equal(modelAgreement, "Strong");
});

test("Task #114 edge cases: zero total weight and an empty model array report a neutral reading, never a fabricated leader", () => {
  const empty = computeWeightedDisagreement([]);
  assert.equal(empty.modelAgreement, "Strong");
  assert.equal(empty.leadingSupportPercent, 50);
  assert.equal(empty.coreModelsConflict, false);
  assert.deepEqual(empty.conflictingModels, []);

  const zeroWeight = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 80, weightUsed: 0 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 10, weightUsed: 0 },
    }),
  );
  assert.equal(zeroWeight.modelAgreement, "Strong");
  assert.equal(zeroWeight.leadingSupportPercent, 50);
});

test("Task #114 edge cases: effective weights not summing to 1, and duplicate model names, are handled without crashing or fabricating an extra conflict", () => {
  const unnormalized = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 65, weightUsed: 12 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 62, weightUsed: 9 },
    }),
  );
  assert.notEqual(unnormalized.modelAgreement, "HighDisagreement");

  const duplicateNames = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 65, weightUsed: 0.4 },
      surfaceEloAgain: { modelName: "Surface Elo", player1Probability: 63, weightUsed: 0.35 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 60, weightUsed: 0.25 },
    }),
  );
  assert.notEqual(duplicateNames.modelAgreement, "HighDisagreement");
});

test("Task #114: buildDisagreementNote describes a unanimous-but-spread-out case accurately, without implying real conflict", () => {
  const unanimousSpread = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 74, weightUsed: 0.34 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 51, weightUsed: 0.34 },
      recentForm: { modelName: "Recent Form", player1Probability: 51, weightUsed: 0.31 },
    }),
  );
  const note = buildDisagreementNote(unanimousSpread, "I. Buse", "Opponent");
  if (unanimousSpread.modelAgreement !== "Strong") {
    assert.ok(note, "expected a note explaining the non-Strong category");
    assert.match(note!, /all meaningfully weighted models favor I\. Buse/i);
    assert.match(note!, /confidence levels vary/i);
    assert.doesNotMatch(note!, /disagree on direction/i);
  }

  const genuineConflict = computeWeightedDisagreement(
    models({
      surfaceElo: { modelName: "Surface Elo", player1Probability: 68, weightUsed: 0.36 },
      serveReturn: { modelName: "Serve & Return", player1Probability: 39, weightUsed: 0.33 },
      recentForm: { modelName: "Recent Form", player1Probability: 66, weightUsed: 0.31 },
    }),
  );
  const conflictNote = buildDisagreementNote(genuineConflict, "Alice", "Bob");
  assert.ok(conflictNote);
  assert.doesNotMatch(conflictNote!, /confidence levels vary/i, "a genuine conflict must not be softened into a confidence-spread framing");
});

// Three models all backing playerA with 89% aggregate weight. Two cards for the same real match
// stored with opposite player-slot assignments must show identical winner-relative agreement.
test("normalizeSupportToWinner: same match stored with opposite player-slot assignments shows identical winner-relative agreement (89/11 inversion fix)", () => {
  const threeModels = (player1IsA: boolean): DisagreementModelInput[] => [
    { modelName: "Surface Elo",   player1Probability: player1IsA ? 70 : 30, weightUsed: 0.40 },
    { modelName: "Serve & Return", player1Probability: player1IsA ? 65 : 35, weightUsed: 0.35 },
    { modelName: "Recent Form",   player1Probability: player1IsA ? 55 : 45, weightUsed: 0.25 },
  ];

  const playerAId = "playerA";
  const playerBId = "playerB";

  // Card 1: playerA occupies the player1 slot and is the predicted winner.
  const { player1SupportPercent: psp1 } = computeWeightedDisagreement(threeModels(true));
  const card1 = normalizeSupportToWinner(psp1, playerAId, playerAId);

  // Card 2: playerA occupies the player2 slot but is still the predicted winner.
  const { player1SupportPercent: psp2 } = computeWeightedDisagreement(threeModels(false));
  const card2 = normalizeSupportToWinner(psp2, playerBId, playerAId);

  assert.equal(card1, card2, "both cards must show the same winner-relative agreement regardless of which player slot playerA occupies");
  assert.ok(card1 > 50, "the majority-backed player must show >50% winner agreement on both cards");
});
