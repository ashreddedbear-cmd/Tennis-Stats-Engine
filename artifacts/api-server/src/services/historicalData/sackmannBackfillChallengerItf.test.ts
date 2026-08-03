/**
 * Tests for the Challenger / ITF / qualifying code paths added to sackmannBackfill.ts.
 *
 * Uses actual Sackmann CSV column names and realistic field values drawn from the
 * atp_matches_qual_chall_YYYY.csv and wta_matches_qual_itf_YYYY.csv schemas.
 *
 * Two categories:
 *  1. mapWtaLevel — new level codes (Q / 2 / 3) that appear only in the qual_itf file.
 *  2. rowToFixture — end-to-end fixture construction for Challenger + qualifying rows,
 *     focusing on blank rank/seed fields (common at this level) and correct level/round mapping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _rowToFixture as rowToFixture, _mapWtaLevel as mapWtaLevel, _mapAtpLevel as mapAtpLevel, _intOrNull as intOrNull } from "./sackmannBackfill";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal valid ATP Challenger row, field values matching the actual
 * atp_matches_qual_chall_YYYY.csv schema.  All optional numeric fields are
 * intentionally blank to mirror what the real files contain for lower-ranked
 * players who lack an ATP ranking.
 */
function challRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    tourney_id:          "2023-6930",
    tourney_name:        "Cagliari Challenger",
    surface:             "Clay",
    draw_size:           "32",
    tourney_level:       "C",          // Challenger
    tourney_date:        "20230130",
    match_num:           "001",
    winner_id:           "105226",
    winner_seed:         "",           // no seed — standard at Challenger level
    winner_entry:        "",
    winner_name:         "Jodar A.",
    winner_hand:         "R",
    winner_ht:           "190",
    winner_ioc:          "ESP",
    winner_age:          "23.2",
    winner_rank:         "",           // BLANK — the key field under test; common below ~150
    winner_rank_points:  "",
    loser_id:            "105789",
    loser_seed:          "",
    loser_entry:         "",
    loser_name:          "Nishikori K.",
    loser_hand:          "R",
    loser_ht:            "185",
    loser_ioc:           "JPN",
    loser_age:           "33.4",
    loser_rank:          "",           // BLANK
    loser_rank_points:   "",
    score:               "6-3 6-4",
    best_of:             "3",
    round:               "R32",
    minutes:             "75",
    ...overrides,
  };
}

/**
 * Minimal valid ATP qualifying row (Grand Slam qualifying, level=G, round=Q1).
 * winner_rank and loser_rank are present for this one to check they pass through.
 */
function atpQualRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    tourney_id:          "2023-560",
    tourney_name:        "Roland Garros",
    surface:             "Clay",
    draw_size:           "128",
    tourney_level:       "G",          // Grand Slam — qualifying rows share the main-draw level
    tourney_date:        "20230529",
    match_num:           "Q001",
    winner_id:           "204688",
    winner_seed:         "",
    winner_entry:        "Q",
    winner_name:         "Alcaraz C.",
    winner_hand:         "R",
    winner_ht:           "185",
    winner_ioc:          "ESP",
    winner_age:          "20.1",
    winner_rank:         "1",
    winner_rank_points:  "7935",
    loser_id:            "206173",
    loser_seed:          "",
    loser_entry:         "",
    loser_name:          "Sousa J.",
    loser_hand:          "R",
    loser_ht:            "183",
    loser_ioc:           "POR",
    loser_age:           "33.2",
    loser_rank:          "145",
    loser_rank_points:   "350",
    score:               "7-5 6-2",
    best_of:             "3",
    round:               "Q1",         // qualifying round label — must pass through verbatim
    minutes:             "72",
    ...overrides,
  };
}

/**
 * Minimal valid WTA ITF row from wta_matches_qual_itf_YYYY.csv.
 * level=Q is a NEW code added in this PR; it must not return null from mapWtaLevel.
 */
function wtaItfRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    tourney_id:          "2023-W001",
    tourney_name:        "W25 Antalya",
    surface:             "Clay",
    draw_size:           "32",
    tourney_level:       "Q",          // ITF circuit — new code, must map to "ITF"
    tourney_date:        "20230130",
    match_num:           "001",
    winner_id:           "210001",
    winner_seed:         "",
    winner_entry:        "",
    winner_name:         "Smith A.",
    winner_hand:         "R",
    winner_ht:           "170",
    winner_ioc:          "GBR",
    winner_age:          "22.1",
    winner_rank:         "425",
    winner_rank_points:  "",
    loser_id:            "210002",
    loser_seed:          "",
    loser_entry:         "",
    loser_name:          "Jones B.",
    loser_hand:          "R",
    loser_ht:            "168",
    loser_ioc:           "AUS",
    loser_age:           "24.3",
    loser_rank:          "512",
    loser_rank_points:   "",
    score:               "6-2 6-3",
    best_of:             "3",
    round:               "R32",
    minutes:             "60",
    ...overrides,
  };
}

/**
 * Maximally sparse row: only the fields rowToFixture REQUIRES are present;
 * every optional field is blank.  Simulates the sparsest rows found at ITF level.
 */
function sparseRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    tourney_id:    "2023-ITF99",
    tourney_name:  "ITF Monastir",
    surface:       "Hard",
    draw_size:     "32",
    tourney_level: "S",
    tourney_date:  "20230320",
    match_num:     "001",
    winner_id:     "300001",
    winner_name:   "Player A.",
    loser_id:      "300002",
    loser_name:    "Player B.",
    score:         "6-1 6-2",
    best_of:       "3",
    round:         "R32",
    // everything else intentionally absent (undefined / blank)
    winner_seed: "", winner_entry: "", winner_hand: "", winner_ht: "", winner_ioc: "",
    winner_age: "", winner_rank: "", winner_rank_points: "",
    loser_seed: "", loser_entry: "", loser_hand: "", loser_ht: "", loser_ioc: "",
    loser_age: "", loser_rank: "", loser_rank_points: "",
    minutes: "",
    ...overrides,
  };
}

// ── 1. mapWtaLevel — new codes ─────────────────────────────────────────────────

describe("sackmannBackfill/challergerItf: mapWtaLevel — new qual_itf level codes", () => {
  it("Q maps to ITF (qualifying/ITF circuit events in wta_matches_qual_itf files)", () => {
    assert.strictEqual(mapWtaLevel("Q"), "ITF");
  });

  it("'2' maps to ITF (ITF W15/W25 numeric code used in older qual files)", () => {
    assert.strictEqual(mapWtaLevel("2"), "ITF");
  });

  it("'3' maps to ITF (ITF W40/W60 numeric code)", () => {
    assert.strictEqual(mapWtaLevel("3"), "ITF");
  });

  it("existing codes still map correctly after the new cases were added", () => {
    assert.strictEqual(mapWtaLevel("G"),  "GrandSlam");
    assert.strictEqual(mapWtaLevel("P"),  "WTA1000");
    assert.strictEqual(mapWtaLevel("PM"), "WTA1000");
    assert.strictEqual(mapWtaLevel("I"),  "WTA500");
    assert.strictEqual(mapWtaLevel("C"),  "Challenger");
    assert.strictEqual(mapWtaLevel("S"),  "ITF");
  });

  it("unrecognised code still returns null (does not crash)", () => {
    assert.strictEqual(mapWtaLevel("X"), null);
    assert.strictEqual(mapWtaLevel(""),  null);
  });
});

// ── 2. rowToFixture — ATP Challenger rows ────────────────────────────────────

describe("sackmannBackfill/challengerItf: rowToFixture — ATP Challenger (level=C, qual_chall file)", () => {
  it("returns a fixture for a valid Challenger row", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null, "should not return null for a valid Challenger row");
  });

  it("blank winner_rank and loser_rank do NOT drop the row — they become null", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    // intOrNull("") → null, not 0, not NaN
    assert.strictEqual(f.player1Rank, null, "blank winner_rank should parse to null, not drop the row");
    assert.strictEqual(f.player2Rank, null, "blank loser_rank should parse to null, not drop the row");
  });

  it("blank winner_seed and loser_seed do NOT drop the row (seeds are not required)", () => {
    // rowToFixture doesn't use winner_seed/loser_seed — they aren't written to the fixture.
    // This confirms a seed-less row is not null.
    const f = rowToFixture(challRow({ winner_seed: "", loser_seed: "" }), "ATP");
    assert.ok(f !== null, "seed-less row must produce a valid fixture");
  });

  it("tournamentLevel is 'Challenger'", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.tournamentLevel, "Challenger");
  });

  it("round is preserved verbatim (R32, QF, SF, F are all valid at Challenger)", () => {
    assert.strictEqual(rowToFixture(challRow({ round: "R32" }), "ATP")?.round, "R32");
    assert.strictEqual(rowToFixture(challRow({ round: "QF"  }), "ATP")?.round, "QF");
    assert.strictEqual(rowToFixture(challRow({ round: "F"   }), "ATP")?.round, "F");
  });

  it("player IDs are namespaced with 'sackmann-' prefix", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.match(f.player1Id, /^sackmann-\d+$/);
    assert.match(f.player2Id, /^sackmann-\d+$/);
  });

  it("winner is always player1 (Sackmann convention)", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.winnerId, f.player1Id);
  });

  it("date is in YYYY-MM-DD format", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.match(f.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(f.date, "2023-01-30");
  });

  it("surface is mapped correctly from 'Clay'", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.surface, "Clay");
  });

  it("externalId is tourney_id + match_num, used for dedup", () => {
    const f = rowToFixture(challRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.id, "2023-6930-001");
  });

  it("present but low rank values pass through correctly (not dropped by intOrNull)", () => {
    const f = rowToFixture(challRow({ winner_rank: "175", loser_rank: "320" }), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.player1Rank, 175);
    assert.strictEqual(f.player2Rank, 320);
  });
});

// ── 3. rowToFixture — ATP qualifying round rows ───────────────────────────────

describe("sackmannBackfill/challengerItf: rowToFixture — ATP qualifying rounds (qual_chall file, round=Q1/Q2/Q3)", () => {
  it("returns a fixture for a qualifying round row", () => {
    const f = rowToFixture(atpQualRow(), "ATP");
    assert.ok(f !== null, "qualifying round row should produce a valid fixture");
  });

  it("tournamentLevel is 'GrandSlam' when tourney_level=G (qualifying rounds share the event level)", () => {
    const f = rowToFixture(atpQualRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.tournamentLevel, "GrandSlam");
  });

  it("qualifying round label Q1 is preserved verbatim", () => {
    assert.strictEqual(rowToFixture(atpQualRow({ round: "Q1" }), "ATP")?.round, "Q1");
    assert.strictEqual(rowToFixture(atpQualRow({ round: "Q2" }), "ATP")?.round, "Q2");
    assert.strictEqual(rowToFixture(atpQualRow({ round: "Q3" }), "ATP")?.round, "Q3");
  });

  it("player name is preserved from winner_name / loser_name", () => {
    const f = rowToFixture(atpQualRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.player1Name, "Alcaraz C.");
    assert.strictEqual(f.player2Name, "Sousa J.");
  });
});

// ── 4. rowToFixture — WTA ITF rows (qual_itf file, level=Q) ─────────────────

describe("sackmannBackfill/challengerItf: rowToFixture — WTA ITF/qualifying (qual_itf file, level=Q)", () => {
  it("returns a fixture for a WTA ITF row with level=Q", () => {
    const f = rowToFixture(wtaItfRow(), "WTA");
    assert.ok(f !== null, "WTA level=Q row should produce a valid fixture");
  });

  it("tournamentLevel is 'ITF' for level=Q", () => {
    const f = rowToFixture(wtaItfRow(), "WTA");
    assert.ok(f !== null);
    assert.strictEqual(f.tournamentLevel, "ITF");
  });

  it("tournamentLevel is 'ITF' for level='2' (ITF W15/W25 numeric code)", () => {
    const f = rowToFixture(wtaItfRow({ tourney_level: "2" }), "WTA");
    assert.ok(f !== null);
    assert.strictEqual(f.tournamentLevel, "ITF");
  });

  it("tournamentLevel is 'ITF' for level='3' (ITF W40/W60 numeric code)", () => {
    const f = rowToFixture(wtaItfRow({ tourney_level: "3" }), "WTA");
    assert.ok(f !== null);
    assert.strictEqual(f.tournamentLevel, "ITF");
  });

  it("rank fields parse correctly when present", () => {
    const f = rowToFixture(wtaItfRow({ winner_rank: "425", loser_rank: "512" }), "WTA");
    assert.ok(f !== null);
    assert.strictEqual(f.player1Rank, 425);
    assert.strictEqual(f.player2Rank, 512);
  });
});

// ── 5. rowToFixture — maximally sparse / missing-field resilience ─────────────

describe("sackmannBackfill/challengerItf: rowToFixture — sparse rows (many blank fields)", () => {
  it("does not crash when all optional fields are blank strings", () => {
    assert.doesNotThrow(() => rowToFixture(sparseRow(), "ATP"));
  });

  it("returns a valid fixture from a sparse row (no rank, no seed, no entry)", () => {
    const f = rowToFixture(sparseRow(), "ATP");
    assert.ok(f !== null, "sparse row with valid required fields should produce a fixture");
  });

  it("player1Rank and player2Rank are null when rank is blank", () => {
    const f = rowToFixture(sparseRow(), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.player1Rank, null);
    assert.strictEqual(f.player2Rank, null);
  });

  it("null tournamentLevel does not crash (unrecognised level code is allowed — row still imports)", () => {
    // Level "X" is unrecognised; rowToFixture should return a fixture with null tournamentLevel,
    // not throw. The backfill still imports the match — null level is better than a lost row.
    const f = rowToFixture(sparseRow({ tourney_level: "X" }), "ATP");
    assert.ok(f !== null, "unrecognised level should not cause the row to be dropped");
    assert.strictEqual(f.tournamentLevel, null);
  });

  it("walkover row (score=W/O) is not crashed by parseSetMargins", () => {
    const f = rowToFixture(challRow({ score: "W/O" }), "ATP");
    assert.ok(f !== null);
    assert.strictEqual(f.walkover, true);
    assert.deepStrictEqual(f.setGameMargins, []);
  });

  it("intOrNull returns null for '0', negative, and non-numeric strings", () => {
    // Verifies the utility used for rank fields doesn't silently pass bad values
    assert.strictEqual(intOrNull(""), null);
    assert.strictEqual(intOrNull("0"), null);    // 0 is not a valid rank
    assert.strictEqual(intOrNull("-1"), null);
    assert.strictEqual(intOrNull("abc"), null);
    assert.strictEqual(intOrNull("175"), 175);
    assert.strictEqual(intOrNull("1"), 1);
  });
});
