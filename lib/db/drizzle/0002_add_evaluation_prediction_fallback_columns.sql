ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "used_fallback" boolean;
ALTER TABLE "evaluation_predictions" ADD COLUMN IF NOT EXISTS "fallback_sources" jsonb;
