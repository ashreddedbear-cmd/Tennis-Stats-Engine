-- Forward-safe schema alignment for the predictions ledger table.
-- Idempotent by design: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS predictions (
  id SERIAL PRIMARY KEY,
  player1_id TEXT NOT NULL,
  player1_name TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  player2_name TEXT NOT NULL,
  surface TEXT NOT NULL,
  match_format TEXT NOT NULL,
  tournament_level TEXT,
  tournament_name TEXT,
  strategy_id TEXT,
  strategy_version TEXT,
  calibration_version TEXT,
  external_fixture_id TEXT,
  snapshot_captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  predicted_winner_id TEXT NOT NULL,
  predicted_winner_name TEXT NOT NULL,
  calibrated_probability REAL NOT NULL DEFAULT 0.5,
  predicted_winner_probability REAL NOT NULL DEFAULT 0.5,
  data_quality INTEGER NOT NULL DEFAULT 0,
  data_quality_label TEXT NOT NULL DEFAULT 'Unknown',
  upset_risk TEXT NOT NULL DEFAULT 'Unknown',
  recommendation TEXT NOT NULL DEFAULT 'No Bet',
  predicted_set_score TEXT NOT NULL DEFAULT 'N/A',
  engine JSONB NOT NULL DEFAULT '{}'::jsonb,
  match_identity_key TEXT,
  input_snapshot_hash TEXT,
  actual_winner_id TEXT,
  actual_winner_name TEXT,
  decision_trace JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy_id TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS calibration_version TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS external_fixture_id TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS snapshot_captured_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS predicted_winner_probability REAL;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS data_quality_label TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS match_identity_key TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS input_snapshot_hash TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS decision_trace JSONB;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

UPDATE predictions
SET predicted_winner_probability = calibrated_probability
WHERE predicted_winner_probability IS NULL;

UPDATE predictions
SET data_quality_label = 'Unknown'
WHERE data_quality_label IS NULL;

UPDATE predictions
SET match_identity_key = concat_ws(
  '::',
  concat_ws('|', least(player1_id, player2_id), greatest(player1_id, player2_id)),
  coalesce(nullif(lower(trim(tournament_name)), ''), '__no_tournament__'),
  surface,
  match_format
)
WHERE match_identity_key IS NULL;

UPDATE predictions
SET input_snapshot_hash = md5(concat_ws('|', coalesce(player1_id, ''), coalesce(player2_id, ''), coalesce(created_at::text, ''), coalesce(id::text, '')))
WHERE input_snapshot_hash IS NULL;

-- Task #146: three-state market-odds outcome, written once at creation time, never updated.
-- Null for rows inserted before this column existed.
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS odds_status TEXT;

CREATE INDEX IF NOT EXISTS predictions_created_at_idx ON predictions (created_at);
CREATE INDEX IF NOT EXISTS predictions_recommendation_idx ON predictions (recommendation);
CREATE UNIQUE INDEX IF NOT EXISTS predictions_identity_input_snapshot_idx ON predictions (match_identity_key, input_snapshot_hash);
