-- Add cross_engine_agreement column to predictions table.
-- This column stores whether the parlay builder validates the prediction engine's chosen winner:
--   true  = builder decision KEEP or BORDERLINE (doesn't disagree)
--   false = builder decision REMOVE (evidence favors opponent)
--   null  = DATA_UNAVAILABLE or prediction was made before this feature existed
--
-- Run in Replit (helium DB access required):
--   psql $DATABASE_URL -f lib/db/drizzle/0001_add_cross_engine_agreement.sql
--
-- After running this migration, execute the backfill script to populate historical rows:
--   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillCrossEngineAgreement.ts --commit

ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "cross_engine_agreement" boolean;
