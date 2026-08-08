---
name: Drizzle tablesFilter sequence bug
description: drizzle-kit 0.31.x tablesFilter doesn't gate sequence scanning; workaround is a positive whitelist; the sequence DROP error is harmless (exits 0).
---

## The problem

`drizzle-kit push` (v0.31.x) scans ALL sequences in the DB, not just those belonging to managed tables. When a sequence (e.g. `optimizer_runs_id_seq`) belongs to a table NOT in `tablesFilter`, drizzle sees it as "orphaned" and attempts to DROP it. The DROP fails with `cannot drop sequence … because other objects depend on it`.

However, **drizzle-kit exits 0 despite this error** — all the real DDL (CREATE TABLE, ADD COLUMN, FK constraints, indexes) is applied correctly before the sequence step. The error is logged but does not block the migration.

## The fix in place

`lib/db/drizzle.config.ts` uses a **positive whitelist** (`tablesFilter: DRIZZLE_MANAGED_TABLES`) listing only the 33 tables with a `pgTable()` definition. This:
- Prevents Replit's deployment system from showing the raw-SQL-only tables as "removed"
- Does NOT fully suppress the sequence DROP attempt (drizzle-kit limitation)
- But the sequence DROP fails gracefully (exit 0), so all actual schema changes apply

**Why:** The project has 19+ tables created exclusively by `ensureEvaluationSchema.ts` raw SQL (optimizer_runs, walk_forward_runs, parlay_*, strategy_*, etc.) with no `pgTable()` definition. Without the whitelist, Replit's deployment comparison sees them as "removed from dev schema" and offers to DROP all 19 from production.

## Rule

When you add a new `pgTable()` to `lib/db/src/schema/`, add its table name to `DRIZZLE_MANAGED_TABLES` in `lib/db/drizzle.config.ts`. When `ensureEvaluationSchema.ts` creates a raw-SQL-only table, do NOT add it there.

## Recommendation_v2 columns

The `predictions` table has four shadow-replay columns (`recommendation_v2`, `recommendation_version`, `recommendation_changed`, `recommendation_changed_at`) that were added via `ensureEvaluationSchema.ts` forward-compat ALTERs. They are now reflected in `lib/db/src/schema/predictions.ts` so drizzle-kit doesn't try to drop them.
