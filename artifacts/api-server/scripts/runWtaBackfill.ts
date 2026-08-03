/**
 * One-off script: load WTA 2016–2020 from tennis-data.co.uk into historical_matches.
 * Run: cd artifacts/api-server && pnpm exec tsx scripts/runWtaBackfill.ts
 */
import { runTennisDataCoUkBackfill } from "../src/services/historicalData/tennisDataCoUkBackfill";

async function main() {
  console.log("[wta-backfill] Starting WTA 2016–2020 tennis-data.co.uk backfill…");
  const result = await runTennisDataCoUkBackfill({
    startYear: 2016,
    endYear: 2020,
    tours: ["wta"],
  });

  console.log("[wta-backfill] Done:", JSON.stringify({
    wtaYearsLoaded: result.wtaYearsLoaded,
    fixturesLoaded: result.fixturesLoaded,
    fixturesWithOdds: result.fixturesWithOdds,
    matchesInserted: result.backfill.matchesInserted,
    matchesSkippedDuplicate: result.backfill.matchesSkippedDuplicate,
    featureRowsInserted: result.backfill.featureRowsInserted,
    dateStart: result.backfill.dateStart,
    dateStop: result.backfill.dateStop,
    byYear: result.backfill.byYear,
  }, null, 2));

  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

main().catch(err => {
  console.error("[wta-backfill] FAILED:", err);
  process.exit(1);
});
