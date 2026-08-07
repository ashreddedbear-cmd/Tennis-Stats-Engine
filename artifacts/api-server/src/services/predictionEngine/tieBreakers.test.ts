/**
 * Regression guard for the tie-break cascade removal (Task #5, 2026-07-15).
 *
 * Graded-outcome audit finding: every cascade step with usable sample size performed at or below
 * a coin flip in the tight-signal regime (Serve & Return n=1,374 at 53.7%, Surface Elo n=120 at
 * 46.7%) versus a 66.7% non-applied baseline. The cascade was removed and replaced with an honest
 * "genuinely close matchup" disclosure that passes the raw ensemble probability through unchanged.
 *
 * These tests assert the three properties that must hold for the fix to remain correct:
 *   1. Within TIE_BAND: the returned probability equals the raw input (NO directional nudge).
 *   2. Within TIE_BAND: decidingStep is diagnostic-only and never changes no-pick behavior.
 *   3. Outside TIE_BAND: applied is false and the probability is unchanged.
 *
 * If a future change re-introduces directional nudging inside TIE_BAND, these tests will fail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyTieBreaker, TIE_BAND } from "./tieBreakers";
import type { TieBreakerInputs } from "./tieBreakers";

/**
 * Minimal, deterministic fixtures for the core modules consumed by the tie-break diagnostics.
 */
const BASE_INPUTS: TieBreakerInputs = {
  surfaceElo: { eloDifference: 0 } as TieBreakerInputs["surfaceElo"],
  serveReturn: {
    player1ServeRating: 0,
    player1ReturnRating: 0,
    player2ServeRating: 0,
    player2ReturnRating: 0,
  } as TieBreakerInputs["serveReturn"],
  recentForm: { player1Form: 50, player2Form: 50 } as TieBreakerInputs["recentForm"],
  fatigue: {} as TieBreakerInputs["fatigue"],
  headToHead: {} as TieBreakerInputs["headToHead"],
  player1: {} as TieBreakerInputs["player1"],
  player2: {} as TieBreakerInputs["player2"],
  player1Matches: [],
  player2Matches: [],
  surface: "Hard",
};

function withInputs(overrides: Partial<TieBreakerInputs>): TieBreakerInputs {
  return { ...BASE_INPUTS, ...overrides };
}

// ── Core regression: no directional nudge when within TIE_BAND ──────────────────────────────────

test("applyTieBreaker: within TIE_BAND — adjustedProbability equals raw input (no nudge)", () => {
  const within = [50, 50 + TIE_BAND - 0.1, 50 - TIE_BAND + 0.1, 50.5, 49.2, 51.8];
  for (const raw of within) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.equal(
      result.adjustedProbability,
      raw,
      `Expected adjustedProbability === ${raw} (no nudge), got ${result.adjustedProbability}`,
    );
  }
});

test("applyTieBreaker: within TIE_BAND — decidingStep is diagnostic-only and can be populated", () => {
  const withServeReturn = withInputs({
    serveReturn: {
      player1ServeRating: 5,
      player1ReturnRating: 2,
      player2ServeRating: 1,
      player2ReturnRating: 1,
    } as TieBreakerInputs["serveReturn"],
  });
  const within = [50, 50 + TIE_BAND - 0.1, 50 - TIE_BAND + 0.1];
  for (const raw of within) {
    const result = applyTieBreaker(raw, withServeReturn);
    assert.equal(result.decidingStep, "Serve & Return", `Expected diagnostic decidingStep for raw=${raw}`);
    assert.equal(result.direction, 0, `Expected no-pick direction for raw=${raw}`);
  }
});

test("applyTieBreaker: within TIE_BAND — direction is 0 (no pick)", () => {
  const within = [50, 50 + TIE_BAND - 0.1, 50 - TIE_BAND + 0.1];
  for (const raw of within) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.equal(result.direction, 0, `Expected direction 0 for raw=${raw}, got ${result.direction}`);
  }
});

test("applyTieBreaker: within TIE_BAND — applied is true (close-match disclosure fires)", () => {
  const within = [50, 50 + TIE_BAND - 0.1, 50 - TIE_BAND + 0.1];
  for (const raw of within) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.equal(result.applied, true, `Expected applied true for raw=${raw}`);
  }
});

test("applyTieBreaker: within TIE_BAND — note is non-null (honest disclosure always present)", () => {
  const result = applyTieBreaker(50, BASE_INPUTS);
  assert.ok(result.note !== null && result.note.length > 0, "Expected a non-empty disclosure note for a close match");
});

test("applyTieBreaker: defaulted input is reported as incomplete, not genuine close-call", () => {
  const result = applyTieBreaker(50, { ...BASE_INPUTS, defaultedInputs: ["Recent Form"] });
  assert.equal(result.applied, true);
  assert.equal(result.dataIncomplete, true);
  assert.match(result.note ?? "", /Data incomplete/);
});

// ── Boundary conditions ──────────────────────────────────────────────────────────────────────────

test("applyTieBreaker: exactly at TIE_BAND boundary — not applied (ensemble already clear)", () => {
  // Math.abs(50 + TIE_BAND - 50) === TIE_BAND → the condition is `>= TIE_BAND` → NOT applied.
  const atBoundaryAbove = applyTieBreaker(50 + TIE_BAND, BASE_INPUTS);
  assert.equal(atBoundaryAbove.applied, false);
  assert.equal(atBoundaryAbove.adjustedProbability, 50 + TIE_BAND);

  const atBoundaryBelow = applyTieBreaker(50 - TIE_BAND, BASE_INPUTS);
  assert.equal(atBoundaryBelow.applied, false);
  assert.equal(atBoundaryBelow.adjustedProbability, 50 - TIE_BAND);
});

// ── Outside TIE_BAND: pass-through ──────────────────────────────────────────────────────────────

test("applyTieBreaker: outside TIE_BAND — applied is false and probability passes through unchanged", () => {
  const outside = [50 + TIE_BAND + 1, 50 - TIE_BAND - 1, 65, 35, 70, 30];
  for (const raw of outside) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.equal(result.applied, false, `Expected applied false for raw=${raw}`);
    assert.equal(result.adjustedProbability, raw, `Expected probability unchanged for raw=${raw}`);
    assert.equal(result.note, null);
    assert.equal(result.decidingStep, null);
  }
});

// ── Display-consistency invariant: banner must show rawEnsemble, not calibratedProbability ───────
//
// When tieBreakerApplied=true, calibration, specialist-blending, and simulator-blending run
// *after* the tie-breaker check and can push calibratedProbability to extreme values (e.g.
// 100%/0%) while the raw ensemble sits at ~50%.  The UI "Too Close to Call" banner must display
// rawEnsembleProbability (== adjustedProbability here, since no nudge is applied), NOT
// calibratedProbability.  This test asserts the invariant that makes the fix coherent:
//   - When applied=true, adjustedProbability is always within TIE_BAND of 50.
//   - calibratedProbability may legally differ — the engine does not constrain it post-tie-breaker.
//   - Therefore the banner MUST use adjustedProbability; using calibratedProbability would produce
//     contradictions like "Too Close to Call / 100.0%".

test("display invariant: when applied=true, adjustedProbability is always within TIE_BAND of 50 (safe for banner display)", () => {
  const withinBand = [50.0, 49.0, 51.0, 50 + TIE_BAND - 0.01, 50 - TIE_BAND + 0.01];
  for (const raw of withinBand) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.ok(result.applied, `Expected applied=true for raw=${raw}`);
    assert.ok(
      Math.abs(result.adjustedProbability - 50) < TIE_BAND,
      `adjustedProbability ${result.adjustedProbability} must be within TIE_BAND (${TIE_BAND}) of 50 when applied — it is the value the banner displays`,
    );
  }
});

test("display invariant: when applied=false, adjustedProbability is outside TIE_BAND (calibratedProbability is appropriate for display)", () => {
  const outsideBand = [50 + TIE_BAND, 50 - TIE_BAND, 65, 35, 80, 20];
  for (const raw of outsideBand) {
    const result = applyTieBreaker(raw, BASE_INPUTS);
    assert.ok(!result.applied, `Expected applied=false for raw=${raw}`);
    assert.ok(
      Math.abs(result.adjustedProbability - 50) >= TIE_BAND,
      `adjustedProbability ${result.adjustedProbability} must be >= TIE_BAND (${TIE_BAND}) from 50 when not applied`,
    );
  }
});

// ── Key regression guard: the specific probabilities the old cascade would have nudged ──────────

test("applyTieBreaker: regression — probabilities formerly nudged by cascade now pass through as-is", () => {
  // The old cascade nudged any within-TIE_BAND raw probability to exactly 50 ± 2.5.
  // After the fix, the raw probability must come out unchanged regardless of what the inputs say.
  const examples = [
    { raw: 49.0, oldCascadeWouldHaveReturned: 52.5 }, // Serve & Return picked player 2's opponent → nudged up
    { raw: 51.5, oldCascadeWouldHaveReturned: 52.5 }, // another typical case
    { raw: 50.0, oldCascadeWouldHaveReturned: 47.5 }, // all steps had some signal → old cascade picked one
  ];
  for (const { raw } of examples) {
    const result = applyTieBreaker(raw, withInputs({
      serveReturn: {
        player1ServeRating: 10,
        player1ReturnRating: 1,
        player2ServeRating: 1,
        player2ReturnRating: 1,
      } as TieBreakerInputs["serveReturn"],
    }));
    assert.equal(
      result.adjustedProbability,
      raw,
      `Raw ${raw} must pass through unchanged — old cascade would have nudged it to 52.5 or 47.5`,
    );
  }
});

test("applyTieBreaker: diagnostics priority remains Serve & Return → Surface Elo → Recent Form", () => {
  const raw = 50;

  const serveReturnFirst = applyTieBreaker(
    raw,
    withInputs({
      serveReturn: {
        player1ServeRating: 2,
        player1ReturnRating: 1,
        player2ServeRating: 1,
        player2ReturnRating: 1,
      } as TieBreakerInputs["serveReturn"],
      surfaceElo: { eloDifference: 64 } as TieBreakerInputs["surfaceElo"],
      recentForm: { player1Form: 60, player2Form: 50 } as TieBreakerInputs["recentForm"],
    }),
  );
  assert.equal(serveReturnFirst.decidingStep, "Serve & Return");

  const surfaceEloSecond = applyTieBreaker(
    raw,
    withInputs({
      surfaceElo: { eloDifference: 64 } as TieBreakerInputs["surfaceElo"],
      recentForm: { player1Form: 60, player2Form: 50 } as TieBreakerInputs["recentForm"],
    }),
  );
  assert.equal(surfaceEloSecond.decidingStep, "Surface Elo");

  const recentFormThird = applyTieBreaker(
    raw,
    withInputs({
      recentForm: { player1Form: 60, player2Form: 50 } as TieBreakerInputs["recentForm"],
    }),
  );
  assert.equal(recentFormThird.decidingStep, "Recent Form");
});
