-- Add fallback instrumentation columns to evaluation_predictions.
-- These columns store whether scoring used a fallback path and which subsystems triggered it.
--   used_fallback     = true | false | null
--   fallback_sources  = JSON array of source identifiers, or null when unavailable
--
-- Run in Replit / Codespaces with DB access:
--   pnpm --filter @workspace/db run push
-- or:
--   psql $DATABASE_URL -f lib/db/drizzle/0002_add_evaluation_prediction_fallback_columns.sql

ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "used_fallback" boolean;
ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "fallback_sources" jsonb;