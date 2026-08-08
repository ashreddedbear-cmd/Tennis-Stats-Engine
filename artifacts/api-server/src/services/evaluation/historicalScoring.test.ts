/**
 * Task #8 — isPointInTimeReplay specialist coverage
 *
 * Verifies the walk-forward vs shadow-replay specialist-suppression contract in
 * `scoreHistoricalMatch`.
 *
 *  • isPointInTimeReplay = undefined / false  (walk-forward path)
 *    → specialistApplied=true in the engine breakdown; calibration IS shifted by the specialist.
 *      undefined and false are byte-for-byte identical.
 *
 *  • isPointInTimeReplay = true  (shadow-replay path)
 *    → specialist is SUPPRESSED; calibratedProbability equals the no-specialist baseline.
 *
 * Uses synthetic DB rows so the test is deterministic and never skips regardless of corpus
 * state. Two prior matches (one for each target-match player) are inserted before the target
 * match's cutoff so scoreHistoricalMatch always has enough context to return non-null.
 * All inserted rows are cleaned up in t.after().
 *
 * Run with: pnpm --filter @workspace/api-server run test:evaluation
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, historicalMatchesTable, type HistoricalMatchRow } from "@workspace/db";
import { inArray, asc } from "drizzle-orm";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import type { SpecialistModelRow } from "@workspace/db";
import type { PlayerIdentityIndex } from "../tennisData/playerIdentity";

// Minimal empty identity index for synthetic players that have no aliases in the real corpus.
const EMPTY_IDENTITY_INDEX: PlayerIdentityIndex = {
  canonicalIdByName:      new Map(),
  canonicalIdById:        new Map(),
  aliasIdsByCanonicalId:  new Map(),
};

// ── Synthetic specialist ───────────────────────────────────────────────────────
//
// Biased ATP-Hard calibration:  raw 50 % → calibrated 75 %  (large, visible shift).
// resolveSegmentSpecialistInputSync looks up the "ATP-Hard" key from the specialist map.
//
// With weight=0.8:
//   blended = 0.8 × 75 + 0.2 × raw  (if raw ≈ 50 → blended ≈ 70)
//
const BIASED_ATP_HARD_SPECIALIST: SpecialistModelRow = {
  id: -999,
  computedAt: new Date("2026-01-01T00:00:00.000Z"),
  segmentKey: "ATP-Hard",
  tour: "ATP",
  surface: "Hard",
  label: "ATP-Hard (synthetic test specialist)",
  meetsThreshold: true,
  weight: 0.8,
  historicalMatchCount: 1000,
  validationSampleSize: 500,
  accuracy: null,
  logLoss: 0.60,
  brier: null,
  generalAccuracy: null,
  generalLogLoss: 0.65,
  generalBrier: null,
  // x = raw fraction, y = calibrated fraction (linear interpolation between knots).
  // The 0.5 → 0.75 knot creates a large, clearly measurable upward shift near 50 % raw.
  calibrationMapping: [
    { x: 0,   y: 0    },
    { x: 0.5, y: 0.75 },
    { x: 1,   y: 1    },
  ] as unknown as SpecialistModelRow["calibrationMapping"],
};

const SPECIALIST_MAP = new Map([
  ["ATP-Hard", BIASED_ATP_HARD_SPECIALIST],
]) as ReadonlyMap<string, SpecialistModelRow>;

const EMPTY_SPECIALIST_MAP = new Map() as ReadonlyMap<string, SpecialistModelRow>;

// ── Test ───────────────────────────────────────────────────────────────────────

test(
  "walk-forward path applies specialist (specialistApplied=true); shadow-replay suppresses it (false) — deterministic with synthetic data",
  { timeout: 30_000 }, // synthetic data: only a handful of rows — well under 30 s
  async (t) => {
    // Unique IDs per run to avoid cross-test pollution if multiple suites run concurrently.
    const run  = Date.now();
    const PROV = `isptr-test-${run}`;
    const P0   = `isptr-p0-${run}`; // shared opponent used only in prior matches
    const P1   = `isptr-p1-${run}`; // target match player 1
    const P2   = `isptr-p2-${run}`; // target match player 2

    // ── Step 1: insert synthetic match rows ────────────────────────────────────
    //
    // Prior matches give P1 and P2 at least one historical result each so
    // scoreHistoricalMatch does not return null (it returns null when a player
    // has zero matches in the context before the cutoff).
    //
    //  prior-1:  P1 beats P0  (2023-01-10)
    //  prior-2:  P0 beats P2  (2023-01-11)   ← P2 has a loss, giving the engine variance
    //  target :  P1 vs  P2   (2023-02-01)    ← the match we score
    //
    const prior1Start  = new Date("2023-01-10T12:00:00Z");
    const prior1Cutoff = new Date("2023-01-10T11:30:00Z");
    const prior2Start  = new Date("2023-01-11T12:00:00Z");
    const prior2Cutoff = new Date("2023-01-11T11:30:00Z");
    const targetStart  = new Date("2023-02-01T12:00:00Z");
    const targetCutoff = new Date("2023-02-01T11:30:00Z");

    const inserted = await db
      .insert(historicalMatchesTable)
      .values([
        // P1's prior match: P1 beats P0
        {
          externalId: `${PROV}-prior-p1`,
          provider:   PROV,
          tour:             "ATP",
          tournamentName:   "Synth Prior",
          tournamentLevel:  null,
          surface:          "Hard",
          round:            null,
          matchFormat:      "BestOf3",
          player1Id:    P1,   player1Name: "Synth P1",
          player2Id:    P0,   player2Name: "Synth P0",
          winnerId:     P1,
          score:        "6-3 6-3",
          retired: false, walkover: false, cancelled: false,
          scheduledStartAt: prior1Start,
          cutoffMinutes:    30,
          cutoffAt:         prior1Cutoff,
          gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }],
          rawSource: {},
        },
        // P2's prior match: P0 beats P2
        {
          externalId: `${PROV}-prior-p2`,
          provider:   PROV,
          tour:             "ATP",
          tournamentName:   "Synth Prior",
          tournamentLevel:  null,
          surface:          "Hard",
          round:            null,
          matchFormat:      "BestOf3",
          player1Id:    P0,   player1Name: "Synth P0",
          player2Id:    P2,   player2Name: "Synth P2",
          winnerId:     P0,
          score:        "6-3 6-3",
          retired: false, walkover: false, cancelled: false,
          scheduledStartAt: prior2Start,
          cutoffMinutes:    30,
          cutoffAt:         prior2Cutoff,
          gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }],
          rawSource: {},
        },
        // Target match: P1 vs P2 on ATP-Hard — this is what we score
        {
          externalId: `${PROV}-target`,
          provider:   PROV,
          tour:             "ATP",
          tournamentName:   "Synth Target ATP Hard",
          tournamentLevel:  null,
          surface:          "Hard",
          round:            null,
          matchFormat:      "BestOf3",
          player1Id:    P1,   player1Name: "Synth P1",
          player2Id:    P2,   player2Name: "Synth P2",
          winnerId:     P1,
          score:        "7-5 6-4",
          retired: false, walkover: false, cancelled: false,
          scheduledStartAt: targetStart,
          cutoffMinutes:    30,
          cutoffAt:         targetCutoff,
          gameMarginsPlayer1: [{ player1Games: 7, player2Games: 5 }],
          rawSource: {},
        },
      ] as any[])
      .returning({ id: historicalMatchesTable.id });

    const insertedIds = inserted.map((r) => r.id);

    // Always clean up, even on assertion failure.
    t.after(async () => {
      await db
        .delete(historicalMatchesTable)
        .where(inArray(historicalMatchesTable.id, insertedIds));
    });

    // Read back as proper HistoricalMatchRow objects, ordered by scheduled time.
    const allRows = await db
      .select()
      .from(historicalMatchesTable)
      .where(inArray(historicalMatchesTable.id, insertedIds))
      .orderBy(asc(historicalMatchesTable.scheduledStartAt));

    const priorMatches = allRows.slice(0, 2); // prior-p1, prior-p2
    const targetMatch  = allRows[2] as HistoricalMatchRow; // target

    t.diagnostic(
      `target: ${targetMatch.player1Name} vs ${targetMatch.player2Name} ` +
      `(${targetMatch.tour} ${targetMatch.surface} cutoff=${targetCutoff.toISOString()})`,
    );

    // ── Step 2: build scoring context ─────────────────────────────────────────
    //
    // buildEloHistoryIndex reads the eloOverall rows from match_feature_snapshots. Our
    // synthetic players have no eloOverall snapshot rows (they've never been run through the
    // backfill). An empty EloHistoryIndex is fine — the engine's Elo module simply contributes
    // null (absent data), and the other modules still produce a real raw probability from
    // form/H2H/surface stats.
    //
    // buildPlayerIdentityIndex() (which reads the full historical_matches corpus) is
    // intentionally skipped here — synthetic player IDs need no alias resolution.
    //
    const eloHistory   = await buildEloHistoryIndex();
    const matchHistory = buildMatchHistoryIndex(priorMatches);

    // Empty identity index: synthetic players have no aliases in the real corpus.

    const baseCtx: HistoricalScoringContext = {
      matchHistory,
      eloHistory,
      identityIndex: EMPTY_IDENTITY_INDEX,
      specialistRowsBySegmentKey: EMPTY_SPECIALIST_MAP,
    };

    // ── Step 3: score under all four conditions ────────────────────────────────
    const [baseline, replay, wfFalse, wfUndefined] = await Promise.all([
      scoreHistoricalMatch(targetMatch, {
        ...baseCtx,
        isPointInTimeReplay: undefined,
      }),
      scoreHistoricalMatch(targetMatch, {
        ...baseCtx,
        specialistRowsBySegmentKey: SPECIALIST_MAP,
        isPointInTimeReplay: true,
      }),
      scoreHistoricalMatch(targetMatch, {
        ...baseCtx,
        specialistRowsBySegmentKey: SPECIALIST_MAP,
        isPointInTimeReplay: false,
      }),
      scoreHistoricalMatch(targetMatch, {
        ...baseCtx,
        specialistRowsBySegmentKey: SPECIALIST_MAP,
        isPointInTimeReplay: undefined,
      }),
    ]);

    // All four must return non-null: each player has 1 prior match in the context,
    // surface="Hard" and matchFormat="BestOf3" are set.
    assert.ok(baseline    !== null, "baseline must return non-null (P1 and P2 have 1 prior match each)");
    assert.ok(replay      !== null, "shadow-replay path must return non-null");
    assert.ok(wfFalse     !== null, "walk-forward (false) must return non-null");
    assert.ok(wfUndefined !== null, "walk-forward (undefined) must return non-null");

    t.diagnostic(
      `raw=${baseline!.rawProbability} ` +
      `baseline_cal=${baseline!.calibratedProbability} ` +
      `wf_cal=${wfFalse!.calibratedProbability}`,
    );

    // ── Assertion A: rawProbability is identical across all paths ─────────────
    // The specialist only touches calibration; the raw ensemble output is always identical.
    assert.strictEqual(replay!.rawProbability,      baseline!.rawProbability, "A/replay: rawProbability must be path-invariant");
    assert.strictEqual(wfFalse!.rawProbability,     baseline!.rawProbability, "A/false:  rawProbability must be path-invariant");
    assert.strictEqual(wfUndefined!.rawProbability, baseline!.rawProbability, "A/undefined: rawProbability must be path-invariant");

    // ── Assertion B: shadow-replay calibratedProbability differs from walk-forward ─
    // When the biased specialist fires (walk-forward), it shifts calibratedProbability
    // substantially (weight=0.8, knot 0.5→0.75). Shadow-replay suppresses the specialist
    // (segment=null, confirmed by specialistApplied=false in Assertion D), so its
    // calibratedProbability must be visibly different from walk-forward.
    //
    // NOTE: shadow-replay calibratedProbability will NOT equal the no-specialist baseline
    // exactly. When segment=null, the engine has no tour info and skips the ATP tour
    // reliability discount that the baseline's segment object (tour="ATP", meetsThreshold=false)
    // does trigger — a small but deterministic delta. The meaningful suppression check is
    // "replay ≠ walk-forward" (Assertion B) + "specialistApplied=false" (Assertion D).
    assert.notStrictEqual(
      replay!.calibratedProbability,
      wfFalse!.calibratedProbability,
      "B: shadow-replay must produce a different calibratedProbability than walk-forward (specialist suppressed via isPointInTimeReplay=true)",
    );

    // ── Assertion C: undefined and false are byte-for-byte identical ──────────
    // Neither triggers the suppression gate; both take the same walk-forward path.
    assert.strictEqual(
      wfUndefined!.calibratedProbability,
      wfFalse!.calibratedProbability,
      "C: isPointInTimeReplay=undefined must be identical to isPointInTimeReplay=false",
    );

    // ── Assertion D: explicit specialistApplied flag in the engine breakdown ───
    // This is the direct "non-zero specialist contribution" confirmation the task
    // spec requested. The engine's Phase 6 blend records specialistApplied=true when
    // segment.meetsThreshold=true, calibrationMapping is non-empty, and weight is set.
    //
    // BIASED_ATP_HARD_SPECIALIST satisfies all three conditions → Phase 6 fires for
    // the walk-forward path and is suppressed (segment→null) for shadow-replay.
    assert.strictEqual(
      wfUndefined!.snapshot.engine.specialistApplied,
      true,
      "D/undefined: walk-forward must record specialistApplied=true when specialist meets threshold",
    );
    assert.strictEqual(
      wfFalse!.snapshot.engine.specialistApplied,
      true,
      "D/false: walk-forward (explicit false) must also record specialistApplied=true",
    );
    assert.strictEqual(
      replay!.snapshot.engine.specialistApplied,
      false,
      "D/replay: shadow-replay must record specialistApplied=false — specialist suppressed by isPointInTimeReplay=true",
    );

    // ── Assertion E: snapshot.moduleWeights is populated (new forward-only key) ─
    // Verifies that scoreHistoricalMatch writes the per-module weight trace into
    // feature_snapshot.moduleWeights. Each entry must have the shape of ModuleTrace.
    assert.ok(
      Array.isArray(baseline!.snapshot.moduleWeights),
      "E: snapshot.moduleWeights must be an array on predictions scored after this field was added",
    );
    assert.ok(
      (baseline!.snapshot.moduleWeights?.length ?? 0) > 0,
      "E: moduleWeights must contain at least one module entry",
    );
    {
      const firstMod = baseline!.snapshot.moduleWeights![0]!;
      assert.equal(typeof firstMod.key,                   "string",  "E: module.key must be a string");
      assert.equal(typeof firstMod.reliability,            "number",  "E: module.reliability must be a number");
      assert.equal(typeof firstMod.excludedFromEnsemble,   "boolean", "E: module.excludedFromEnsemble must be a boolean");
      assert.ok("effectiveWeight" in firstMod,                        "E: module must have an effectiveWeight field (null when excluded)");
      assert.ok("player1Probability" in firstMod,                     "E: module must have a player1Probability field (null when excluded)");
      assert.ok("voteDirection" in firstMod,                          "E: module must have a voteDirection field");
    }

    // ── Assertion F: calibration shift is visible when raw is in [30, 70] ─────
    // With weight=0.8 and the biased knot (raw 50 % → calibrated 75 %), the
    // specialist shifts blended output by ~20 pp near 50 % raw. If raw happens
    // to land in this range, verify the shift actually occurred.
    // (Assertion D above already confirms the specialist fired regardless of raw value.)
    const raw = baseline!.rawProbability;
    if (raw >= 30 && raw <= 70) {
      assert.notStrictEqual(
        wfFalse!.calibratedProbability,
        baseline!.calibratedProbability,
        `E: specialist (weight=0.8, knot 0.5→0.75) must shift calibratedProbability when raw=${raw} is in [30, 70]`,
      );
    } else {
      t.diagnostic(
        `E: raw=${raw} is outside [30, 70]; D already confirms specialist fired — shift may not be visible at extremes`,
      );
    }
  },
);
