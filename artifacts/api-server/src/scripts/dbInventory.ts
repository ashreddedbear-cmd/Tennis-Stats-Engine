import { db, historicalMatchesTable, evaluationPredictionsTable, pool } from "@workspace/db";
import { eq, isNotNull, and, sql } from "drizzle-orm";

async function main() {
  const [[total], [cancelled], [scored], [mktOdds], [ptGraded], providers] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(historicalMatchesTable),
    db.select({ c: sql<number>`count(*)::int` }).from(historicalMatchesTable).where(sql`cancelled = true`),
    db.select({ c: sql<number>`count(*)::int` }).from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runKind, "historical_test")),
    db.select({
      c:  sql<number>`count(*)::int`,
      mn: sql<string>`min(scheduled_start_at)::date`,
      mx: sql<string>`max(scheduled_start_at)::date`,
    }).from(historicalMatchesTable).where(
      and(
        eq(historicalMatchesTable.provider, "tennis-data-co-uk"),
        sql`(raw_source->'_marketOdds'->>'avgWinner')::float > 1`,
      )
    ),
    db.select({ c: sql<number>`count(*)::int` }).from(evaluationPredictionsTable).where(
      and(
        eq(evaluationPredictionsTable.runKind, "paper_trade"),
        isNotNull(evaluationPredictionsTable.oddsPlayer1Decimal),
        eq(evaluationPredictionsTable.status, "graded"),
      )
    ),
    db.execute(sql`SELECT provider, count(*)::int AS cnt FROM historical_matches GROUP BY provider ORDER BY cnt DESC`),
  ]);

  const scorable = total.c - cancelled.c;
  const unscored = Math.max(0, scorable - scored.c);

  console.log("=== DB INVENTORY ===\n");
  console.log(`historical_matches total:                      ${total.c.toLocaleString()}`);
  console.log(`historical_matches (cancelled):                ${cancelled.c.toLocaleString()}`);
  console.log(`historical_matches (scorable):                 ${scorable.toLocaleString()}`);
  console.log(`evaluation_predictions (historical_test):      ${scored.c.toLocaleString()}`);
  console.log(`  → warmup ~40% are train-only (never scored)`);
  console.log(`  → max scorable after warmup:                ~${Math.round(scorable * 0.6).toLocaleString()}`);
  console.log(`  → estimated unscored (new to walk-forward): ~${unscored.toLocaleString()}`);
  console.log();
  console.log(`tennis-data-co-uk rows WITH avgWinner odds:    ${mktOdds.c.toLocaleString()}  (${mktOdds.mn ?? "n/a"} → ${mktOdds.mx ?? "n/a"})`);
  console.log(`paper_trade graded rows with decimal odds:     ${ptGraded.c.toLocaleString()}`);
  console.log();
  console.log("Provider breakdown:");
  for (const row of (providers.rows as Array<{ provider: string; cnt: number }>)) {
    console.log(`  ${String(row.provider).padEnd(32)} ${String(row.cnt).padStart(8)}`);
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
