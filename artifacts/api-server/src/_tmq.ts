import { db, matchFeatureSnapshotsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const exact = await db.execute(sql`
  SELECT count(*) as n, count(distinct match_id) as distinct_matches
  FROM match_feature_snapshots
  WHERE source_timestamp = match_cutoff_at
`);
console.log("rows with sourceTimestamp=cutoffAt (exact equal):", JSON.stringify(exact.rows[0]));

const after = await db.execute(sql`
  SELECT count(*) as n FROM match_feature_snapshots
  WHERE source_timestamp > match_cutoff_at
`);
console.log("rows with sourceTimestamp > cutoffAt (genuine leakage):", JSON.stringify(after.rows[0]));

await (db as any).$client?.end?.();
