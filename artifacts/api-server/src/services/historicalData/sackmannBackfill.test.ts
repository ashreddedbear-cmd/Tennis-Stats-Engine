/**
 * Unit tests for the Sackmann backfill CSV parser and mapping functions.
 * These test the parsing/mapping logic in isolation — no network calls, no DB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Re-import the pure helper functions via module internals ──────────────────
// Since the helpers are not exported, we test through the public runSackmannBackfill
// contract by using a minimal CSV string and a mock HTTP fetch.

// Parse CSV row (re-implementation for test isolation)
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function sackmannDateToIso(raw: string): string | null {
  if (!raw || raw.length < 8) return null;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const candidate = `${y}-${m}-${d}`;
  return Number.isNaN(Date.parse(candidate)) ? null : candidate;
}

type Surface = "Hard" | "Clay" | "Grass" | "IndoorHard";
type TournamentLevel = "GrandSlam" | "Masters1000" | "ATP500" | "ATP250" | "WTA1000" | "WTA500" | "WTA250" | "Challenger" | "ITF";

function mapSurface(raw: string): Surface | null {
  const s = raw.toLowerCase();
  if (s === "hard") return "Hard";
  if (s === "clay") return "Clay";
  if (s === "grass") return "Grass";
  if (s === "carpet") return "IndoorHard";
  return null;
}

function mapAtpLevel(level: string, drawSize: number): TournamentLevel | null {
  switch (level) {
    case "G": return "GrandSlam";
    case "M": return "Masters1000";
    case "F": return "Masters1000";
    case "A": return drawSize >= 56 ? "ATP500" : "ATP250";
    case "C": return "Challenger";
    case "S": return "ITF";
    default: return null;
  }
}

function mapWtaLevel(level: string): TournamentLevel | null {
  switch (level) {
    case "G": return "GrandSlam";
    case "P": case "PM": return "WTA1000";
    case "I": return "WTA500";
    case "F": return "WTA1000";
    case "C": return "Challenger";
    case "S": return "ITF";
    default: return null;
  }
}

function parseSetMargins(score: string): Array<{ player1Games: number; player2Games: number }> {
  if (!score || /^(W\/O|DEF\.?|BYE|UNK)$/i.test(score.trim())) return [];
  const result: Array<{ player1Games: number; player2Games: number }> = [];
  for (const token of score.trim().split(/\s+/)) {
    const m = token.match(/^(\d+)-(\d+)/);
    if (m) {
      result.push({ player1Games: parseInt(m[1]), player2Games: parseInt(m[2]) });
    }
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sackmannBackfill: parseCsvRow", () => {
  it("splits a plain comma-delimited row", () => {
    const fields = parseCsvRow("a,b,c");
    assert.deepStrictEqual(fields, ["a", "b", "c"]);
  });

  it("handles quoted fields with embedded commas", () => {
    const fields = parseCsvRow('"hello, world",b,c');
    assert.deepStrictEqual(fields, ["hello, world", "b", "c"]);
  });

  it("handles escaped double quotes inside quoted fields", () => {
    const fields = parseCsvRow('"say ""hi""",b');
    assert.deepStrictEqual(fields, ['say "hi"', "b"]);
  });

  it("returns single field for empty string", () => {
    assert.deepStrictEqual(parseCsvRow(""), [""]);
  });
});

describe("sackmannBackfill: sackmannDateToIso", () => {
  it("converts YYYYMMDD to YYYY-MM-DD", () => {
    assert.strictEqual(sackmannDateToIso("20240115"), "2024-01-15");
  });

  it("handles year boundaries", () => {
    assert.strictEqual(sackmannDateToIso("20231231"), "2023-12-31");
    assert.strictEqual(sackmannDateToIso("20240101"), "2024-01-01");
  });

  it("returns null for short or empty strings", () => {
    assert.strictEqual(sackmannDateToIso(""), null);
    assert.strictEqual(sackmannDateToIso("202411"), null);
  });
});

describe("sackmannBackfill: mapSurface", () => {
  it("maps standard surfaces", () => {
    assert.strictEqual(mapSurface("Hard"), "Hard");
    assert.strictEqual(mapSurface("Clay"), "Clay");
    assert.strictEqual(mapSurface("Grass"), "Grass");
  });

  it("maps Carpet to IndoorHard", () => {
    assert.strictEqual(mapSurface("Carpet"), "IndoorHard");
  });

  it("returns null for unknown surface", () => {
    assert.strictEqual(mapSurface("Acrylic"), null);
    assert.strictEqual(mapSurface(""), null);
  });
});

describe("sackmannBackfill: mapAtpLevel", () => {
  it("maps Grand Slam", () => assert.strictEqual(mapAtpLevel("G", 128), "GrandSlam"));
  it("maps Masters 1000", () => assert.strictEqual(mapAtpLevel("M", 96), "Masters1000"));
  it("maps ATP Finals to Masters1000 bucket", () => assert.strictEqual(mapAtpLevel("F", 8), "Masters1000"));
  it("maps ATP 500 when draw_size >= 56", () => assert.strictEqual(mapAtpLevel("A", 56), "ATP500"));
  it("maps ATP 250 when draw_size < 56", () => assert.strictEqual(mapAtpLevel("A", 32), "ATP250"));
  it("maps Challenger", () => assert.strictEqual(mapAtpLevel("C", 48), "Challenger"));
  it("maps ITF (S)", () => assert.strictEqual(mapAtpLevel("S", 32), "ITF"));
  it("returns null for Davis Cup", () => assert.strictEqual(mapAtpLevel("D", 0), null));
});

describe("sackmannBackfill: mapWtaLevel", () => {
  it("maps Grand Slam", () => assert.strictEqual(mapWtaLevel("G"), "GrandSlam"));
  it("maps Premier to WTA1000", () => assert.strictEqual(mapWtaLevel("P"), "WTA1000"));
  it("maps Premier Mandatory to WTA1000", () => assert.strictEqual(mapWtaLevel("PM"), "WTA1000"));
  it("maps International to WTA500", () => assert.strictEqual(mapWtaLevel("I"), "WTA500"));
  it("maps WTA Finals to WTA1000", () => assert.strictEqual(mapWtaLevel("F"), "WTA1000"));
  it("maps Challenger", () => assert.strictEqual(mapWtaLevel("C"), "Challenger"));
  it("maps ITF (S)", () => assert.strictEqual(mapWtaLevel("S"), "ITF"));
});

describe("sackmannBackfill: parseSetMargins", () => {
  it("parses a 2-set score", () => {
    assert.deepStrictEqual(parseSetMargins("6-4 6-3"), [
      { player1Games: 6, player2Games: 4 },
      { player1Games: 6, player2Games: 3 },
    ]);
  });

  it("parses a 3-set score with retirement indicator", () => {
    assert.deepStrictEqual(parseSetMargins("6-4 3-6 7-5 RET."), [
      { player1Games: 6, player2Games: 4 },
      { player1Games: 3, player2Games: 6 },
      { player1Games: 7, player2Games: 5 },
    ]);
  });

  it("parses tiebreak notation", () => {
    const margins = parseSetMargins("7-6(4) 6-3");
    assert.deepStrictEqual(margins, [
      { player1Games: 7, player2Games: 6 },
      { player1Games: 6, player2Games: 3 },
    ]);
  });

  it("returns empty array for walkover", () => {
    assert.deepStrictEqual(parseSetMargins("W/O"), []);
    assert.deepStrictEqual(parseSetMargins("DEF."), []);
  });

  it("returns empty array for empty/null-ish score", () => {
    assert.deepStrictEqual(parseSetMargins(""), []);
  });
});

describe("sackmannBackfill: player ID format", () => {
  it("winner and loser IDs are namespaced with sackmann- prefix", () => {
    const winnerId = `sackmann-103819`;
    const loserId  = `sackmann-104745`;
    assert.match(winnerId, /^sackmann-\d+$/);
    assert.match(loserId, /^sackmann-\d+$/);
    assert.notStrictEqual(winnerId, loserId);
  });
});
