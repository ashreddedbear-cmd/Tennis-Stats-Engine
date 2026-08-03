import { db, matchFeatureSnapshotsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const result = await db.execute(sql`
  DELETE FROM match_feature_snapshots 
  WHERE source_timestamp = match_cutoff_at
`);
console.log("deleted rows:", result.rowCount);
await (db as any).$client?.end?.();
