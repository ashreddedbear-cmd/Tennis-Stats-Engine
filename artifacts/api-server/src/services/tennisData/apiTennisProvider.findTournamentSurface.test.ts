// Unit tests for ApiTennisProvider.findTournamentSurfaceByName tier-aware filtering.
//
// The function is exposed only as a class method, so we monkeypatch getTournamentRows
// with a synthetic fixture list to verify that "ATP CHALLENGER HAMBURG" narrows to the
// Challenger row (Clay) and excludes the conflicting ATP500 row (Hard), and that plain
// "Hamburg" (no tier marker) remains unfiltered and returns null when rows disagree.
//
// Run with: pnpm --filter @workspace/api-server run test:tennisData

import test from "node:test";
import assert from "node:assert/strict";
import { ApiTennisProvider } from "./apiTennisProvider";

/** Minimal tournament row shape consumed by findTournamentSurfaceByName. */
interface TournamentRow {
  tournament_name?: string;
  tournament_sourface?: string;
  event_type_type?: string;
  tournament_key?: string | number;
}

/**
 * Create a bare ApiTennisProvider and override its private getTournamentRows method
 * so the test never issues a real HTTP call.
 */
function makeProvider(rows: TournamentRow[]): ApiTennisProvider {
  const provider = new ApiTennisProvider("test-key");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).getTournamentRows = async () => rows;
  return provider;
}

test("findTournamentSurfaceByName: Challenger OCR name filters to Challenger rows only → Clay", async () => {
  // Simulates the Hamburg scenario: an old ATP500 entry (Hard) coexists with the current
  // Challenger entry (Clay). Without tier filtering the surfaces set is {Clay, Hard} → null.
  // With tier filtering "ATP CHALLENGER HAMBURG" narrows to only the Challenger row → Clay.
  const provider = makeProvider([
    { tournament_name: "Hamburg", tournament_sourface: "Hard",  event_type_type: "ATP 500" },
    { tournament_name: "Hamburg", tournament_sourface: "Clay",  event_type_type: "ATP Challenger" },
  ]);

  const result = await provider.findTournamentSurfaceByName("ATP CHALLENGER HAMBURG");
  assert.equal(result?.surface, "Clay", "should resolve to Clay via Challenger-only rows");
});

test("findTournamentSurfaceByName: plain city name with conflicting rows returns null (no tier marker)", async () => {
  // Without a tier marker in the OCR name the full candidate set is used, surfaces disagree → null.
  const provider = makeProvider([
    { tournament_name: "Hamburg", tournament_sourface: "Hard",  event_type_type: "ATP 500" },
    { tournament_name: "Hamburg", tournament_sourface: "Clay",  event_type_type: "ATP Challenger" },
  ]);

  const result = await provider.findTournamentSurfaceByName("Hamburg");
  assert.equal(result, null, "conflicting rows without tier marker → null (never guess)");
});

test("findTournamentSurfaceByName: Challenger OCR name returns correct surface when only one Challenger row exists", async () => {
  // Single unambiguous Challenger row: should resolve.
  const provider = makeProvider([
    { tournament_name: "Brownsburg", tournament_sourface: "Hard", event_type_type: "ATP Challenger" },
  ]);

  const result = await provider.findTournamentSurfaceByName("ATP CHALLENGER BROWNSBURG");
  assert.equal(result?.surface, "Hard");
});

test("findTournamentSurfaceByName: ITF OCR name filters to ITF rows only", async () => {
  const provider = makeProvider([
    { tournament_name: "Rome", tournament_sourface: "Clay", event_type_type: "ITF W25" },
    { tournament_name: "Rome", tournament_sourface: "Hard", event_type_type: "ATP 250" },
  ]);

  const result = await provider.findTournamentSurfaceByName("ITF W25 ROME");
  assert.equal(result?.surface, "Clay");
});

test("findTournamentSurfaceByName: tier filter falls back to all rows when no matching tier row exists", async () => {
  // If the provider has no Challenger row for a city, fall through to all rows.
  // When the only row present agrees on a surface, return it rather than null.
  const provider = makeProvider([
    { tournament_name: "Springfield", tournament_sourface: "Hard", event_type_type: "ATP 250" },
  ]);

  const result = await provider.findTournamentSurfaceByName("ATP CHALLENGER SPRINGFIELD");
  // No Challenger row → tier filter matches nothing → falls back to all rows → Hard
  assert.equal(result?.surface, "Hard");
});
