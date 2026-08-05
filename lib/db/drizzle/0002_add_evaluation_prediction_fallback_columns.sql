-- Add fallback instrumentation columns to evaluation_predictions table.
-- These columns store whether fallback logic was used and which fallback sources were involved.
--
-- Run in Replit (helium DB access required):
--   psql $DATABASE_URL -f lib/db/drizzle/0002_add_evaluation_prediction_fallback_columns.sql

ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "used_fallback" boolean;
ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "fallback_sources" jsonb;