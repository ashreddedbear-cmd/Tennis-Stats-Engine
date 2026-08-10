import { pool } from "@workspace/db";
import { logger } from "./logger";
import { extractFallbackInstrumentation } from "../services/evaluation/fallbackInstrumentation";

const STATEMENTS: string[] = [
  // Ledger table used by /api/predictions (Run Model, Paste, Bulk).
  `
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
  )
  `,
  // Core runner tables used by walk-forward + paper-trade + optimizer.
  `
  CREATE TABLE IF NOT EXISTS evaluation_runs (
    id SERIAL PRIMARY KEY,
    fold_index INTEGER NOT NULL DEFAULT 0,
    model_version TEXT NOT NULL DEFAULT 'unknown',
    train_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    train_end TIMESTAMPTZ NOT NULL DEFAULT now(),
    validation_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    validation_end TIMESTAMPTZ NOT NULL DEFAULT now(),
    test_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    test_end TIMESTAMPTZ NOT NULL DEFAULT now(),
    calibration_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    test_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS evaluation_predictions (
    id SERIAL PRIMARY KEY,
    run_kind TEXT NOT NULL,
    player1_id TEXT NOT NULL,
    player1_name TEXT NOT NULL,
    player2_id TEXT NOT NULL,
    player2_name TEXT NOT NULL,
    scheduled_start_at TIMESTAMPTZ NOT NULL,
    cutoff_at TIMESTAMPTZ NOT NULL,
    model_version TEXT NOT NULL,
    data_segment TEXT NOT NULL DEFAULT 'live',
    status TEXT NOT NULL DEFAULT 'pending',
    locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS calibration_models (
    id SERIAL PRIMARY KEY,
    method TEXT NOT NULL DEFAULT 'isotonic',
    mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_sample_size INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    holdout_sample_size INTEGER NOT NULL DEFAULT 0,
    fitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS specialist_models (
    id SERIAL PRIMARY KEY,
    segment_key TEXT NOT NULL,
    tour TEXT NOT NULL DEFAULT 'Unknown',
    surface TEXT NOT NULL DEFAULT 'Unknown',
    label TEXT NOT NULL DEFAULT 'Unknown',
    historical_match_count INTEGER NOT NULL DEFAULT 0,
    meets_threshold BOOLEAN NOT NULL DEFAULT false,
    validation_sample_size INTEGER NOT NULL DEFAULT 0,
    calibration_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
    weight REAL NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS prediction_settings (
    id SERIAL PRIMARY KEY,
    retirement_rule TEXT NOT NULL DEFAULT 'excluded',
    paper_trade_lead_minutes INTEGER NOT NULL DEFAULT 30,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS threshold_evaluation_runs (
    id SERIAL PRIMARY KEY,
    total_graded INTEGER NOT NULL DEFAULT 0,
    thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS pattern_analysis_runs (
    id SERIAL PRIMARY KEY,
    total_analyzed INTEGER NOT NULL DEFAULT 0,
    segments JSONB NOT NULL DEFAULT '[]'::jsonb,
    run_kinds_included JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS job_runs (
    id SERIAL PRIMARY KEY,
    job_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    summary JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `ALTER TABLE job_runs ALTER COLUMN finished_at DROP NOT NULL`,
  `
  CREATE TABLE IF NOT EXISTS candidate_configs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS config_promotions (
    id SERIAL PRIMARY KEY,
    candidate_config_id INTEGER NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  // Additional strategy lifecycle tables requested by dashboard/system requirements.
  `
  CREATE TABLE IF NOT EXISTS optimizer_runs (
    id BIGSERIAL PRIMARY KEY,
    run_uid TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_versions (
    id BIGSERIAL PRIMARY KEY,
    strategy_id TEXT,
    strategy_name TEXT,
    strategy_version TEXT,
    strategy_fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    engine_version TEXT,
    calibration_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_at TIMESTAMPTZ,
    superseded_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_metrics (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE CASCADE,
    sample_size INTEGER,
    accuracy REAL,
    log_loss REAL,
    brier_score REAL,
    ece REAL,
    roi REAL,
    high_confidence_accuracy REAL,
    elite_tier_accuracy REAL,
    coverage REAL,
    abstention_rate REAL,
    compared_to_strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE SET NULL,
    metric_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_segment_metrics (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE CASCADE,
    segment_type TEXT NOT NULL,
    segment_key TEXT NOT NULL,
    sample_size INTEGER,
    accuracy REAL,
    log_loss REAL,
    brier_score REAL,
    ece REAL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_weight_changes (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    from_value REAL,
    to_value REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_threshold_changes (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE CASCADE,
    threshold_key TEXT NOT NULL,
    from_value REAL,
    to_value REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_promotions (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE RESTRICT,
    previous_strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE SET NULL,
    promoted_by TEXT,
    reason TEXT,
    comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_rejections (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE RESTRICT,
    rejected_by TEXT,
    reason_code TEXT,
    reason_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS strategy_audit_log (
    id BIGSERIAL PRIMARY KEY,
    strategy_version_id BIGINT REFERENCES strategy_versions(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS walk_forward_runs (
    id BIGSERIAL PRIMARY KEY,
    run_uid TEXT UNIQUE,
    evaluation_only BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'queued',
    fold_count INTEGER,
    matches_completed INTEGER NOT NULL DEFAULT 0,
    matches_total INTEGER,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS walk_forward_folds (
    id BIGSERIAL PRIMARY KEY,
    walk_forward_run_id BIGINT REFERENCES walk_forward_runs(id) ON DELETE CASCADE,
    fold_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    sample_size INTEGER,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS paper_trade_runs (
    id BIGSERIAL PRIMARY KEY,
    run_uid TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued',
    fixtures_found INTEGER NOT NULL DEFAULT 0,
    predictions_created INTEGER NOT NULL DEFAULT 0,
    predictions_skipped INTEGER NOT NULL DEFAULT 0,
    matches_graded INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS paper_trade_predictions (
    id BIGSERIAL PRIMARY KEY,
    paper_trade_run_id BIGINT REFERENCES paper_trade_runs(id) ON DELETE SET NULL,
    provider TEXT,
    external_fixture_id TEXT,
    prediction_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_start TIMESTAMPTZ,
    lock_timestamp TIMESTAMPTZ,
    strategy_version TEXT,
    calibration_version TEXT,
    strategy_fingerprint TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    grading_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  // Structural aliases for downstream analytics or compatibility views.
  `
  CREATE TABLE IF NOT EXISTS candidate_strategies (
    id BIGSERIAL PRIMARY KEY,
    candidate_config_id INTEGER,
    strategy_id TEXT,
    strategy_version TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )
  `,
  // Critical columns used by current app code.
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS strategy_id TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS strategy_version TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS strategy_fingerprint TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS optimizer_run_id TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS prediction_mode TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS calibration_version TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS competitive_balance_version TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS evidence_reliability_version TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS fold_id INTEGER`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS segment TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS data_segment TEXT NOT NULL DEFAULT 'live'`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS shadow_batch_label TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS historical_match_id INTEGER`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS provider TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS external_fixture_id TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS surface TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS match_format TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS tournament_level TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS tournament_name TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS feature_snapshot JSONB`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS raw_probability REAL`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS calibrated_probability REAL`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS predicted_winner_id TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS predicted_winner_name TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS model_agreement TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS upset_risk_tier TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS used_fallback BOOLEAN`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS fallback_sources JSONB`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS actual_winner_id TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS actual_winner_name TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS result_type TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS included_in_accuracy BOOLEAN`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS odds_provider TEXT`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS odds_player1_decimal REAL`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS odds_player2_decimal REAL`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS odds_fetched_at TIMESTAMPTZ`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS implied_probability REAL`,
  `ALTER TABLE evaluation_predictions ADD COLUMN IF NOT EXISTS market_edge REAL`,
  `UPDATE evaluation_predictions SET data_segment = CASE WHEN run_kind = 'historical_test' THEN COALESCE(segment, 'live') ELSE 'live' END WHERE data_segment IS DISTINCT FROM CASE WHEN run_kind = 'historical_test' THEN COALESCE(segment, 'live') ELSE 'live' END`,
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS validation_date_range_start TIMESTAMPTZ`,
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS validation_date_range_end TIMESTAMPTZ`,
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS isotonic_holdout_log_loss REAL`,
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS platt_holdout_log_loss REAL`,
  // Task #198: explicit admin approval gate before walk-forward calibration goes live.
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS pending_activation BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS pending_specialist_data JSONB`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS accuracy REAL`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS log_loss REAL`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS brier REAL`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS general_accuracy REAL`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS general_log_loss REAL`,
  `ALTER TABLE specialist_models ADD COLUMN IF NOT EXISTS general_brier REAL`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS strategy_id TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS strategy_version TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS strategy_name TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS strategy_family TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS strategy_fingerprint TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS parent_strategy_id TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS parent_strategy_version TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS creation_method TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS optimizer_run_id TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS production_status TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS lifecycle_status TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS validation_status TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS walk_forward_status TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS shadow_status TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS feature_set JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS weights JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS thresholds JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS calibration_method TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS specialist_routing TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS competitive_balance_behavior JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS evidence_reliability_behavior JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS abstention_rules JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS recommendation_gates JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS promoted_by TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS rollback_strategy_id TEXT`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS source_run_id INTEGER`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS weight_diff JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS threshold_diff JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS proposed_config JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS holdout_metrics JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS validation_metrics JSONB`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS acceptance_checks_passed BOOLEAN`,
  `ALTER TABLE candidate_configs ADD COLUMN IF NOT EXISTS acceptance_checks JSONB`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS strategy_id TEXT`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS strategy_version TEXT`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS strategy_fingerprint TEXT`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS old_config JSONB`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS new_config JSONB`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS reason TEXT`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS validation_period TEXT`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS metrics JSONB`,
  `ALTER TABLE config_promotions ADD COLUMN IF NOT EXISTS promoted_by TEXT`,
  // Uniqueness and lookup indexes that prevent duplicates and speed runner APIs.
  `CREATE UNIQUE INDEX IF NOT EXISTS evaluation_predictions_historical_match_idx ON evaluation_predictions (run_kind, historical_match_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS evaluation_predictions_fixture_idx ON evaluation_predictions (run_kind, provider, external_fixture_id)`,
  `CREATE INDEX IF NOT EXISTS evaluation_predictions_status_idx ON evaluation_predictions (status)`,
  `CREATE INDEX IF NOT EXISTS evaluation_predictions_scheduled_start_idx ON evaluation_predictions (scheduled_start_at)`,
  `CREATE INDEX IF NOT EXISTS evaluation_predictions_run_kind_segment_idx ON evaluation_predictions (run_kind, segment)`,
  `CREATE INDEX IF NOT EXISTS evaluation_predictions_shadow_batch_idx ON evaluation_predictions (run_kind, shadow_batch_label)`,
  `CREATE INDEX IF NOT EXISTS candidate_configs_status_idx ON candidate_configs (status)`,
  `CREATE INDEX IF NOT EXISTS candidate_configs_created_idx ON candidate_configs (created_at)`,
  `CREATE INDEX IF NOT EXISTS strategy_versions_status_idx ON strategy_versions (status)`,
  `CREATE INDEX IF NOT EXISTS strategy_versions_fingerprint_idx ON strategy_versions (strategy_fingerprint)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS paper_trade_predictions_unique_fixture_idx ON paper_trade_predictions (provider, external_fixture_id)`,
  // predictions ledger forward-compat columns/indexes.
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy_id TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy_version TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS calibration_version TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS external_fixture_id TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS snapshot_captured_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS predicted_winner_probability REAL`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS data_quality_label TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS match_identity_key TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS input_snapshot_hash TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS decision_trace JSONB`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS data_segment TEXT NOT NULL DEFAULT 'live'`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS used_fallback BOOLEAN`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS fallback_sources JSONB`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
  // Backfill defaults for columns introduced after early ledger versions.
  `UPDATE predictions SET predicted_winner_probability = calibrated_probability WHERE predicted_winner_probability IS NULL`,
  `UPDATE predictions SET data_quality_label = 'Unknown' WHERE data_quality_label IS NULL`,
  `UPDATE predictions SET data_segment = 'live' WHERE data_segment IS NULL`,
  `UPDATE predictions SET match_identity_key = concat_ws('::', concat_ws('|', least(player1_id, player2_id), greatest(player1_id, player2_id)), coalesce(nullif(lower(trim(tournament_name)), ''), '__no_tournament__'), surface, match_format) WHERE match_identity_key IS NULL`,
  `UPDATE predictions SET input_snapshot_hash = md5(concat_ws('|', coalesce(player1_id,''), coalesce(player2_id,''), coalesce(created_at::text,''), coalesce(id::text,''))) WHERE input_snapshot_hash IS NULL`,
  `UPDATE evaluation_predictions SET segment = 'live' WHERE segment IS NULL AND run_kind IN ('paper_trade', 'live', 'paper_trade_shadow')`,
  `CREATE INDEX IF NOT EXISTS predictions_created_at_idx ON predictions (created_at)`,
  `CREATE INDEX IF NOT EXISTS predictions_recommendation_idx ON predictions (recommendation)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS predictions_identity_input_snapshot_idx ON predictions (match_identity_key, input_snapshot_hash)`,
  // v2 Evidence Confidence Score columns — shadow-replay audit (Task #102).
  // recommendation_v2: recomputed value under the new 5-tier logic; null until shadow replay runs.
  // recommendation_version: integer version of the recommendation logic used (2 = current).
  // recommendation_changed: true when v2 differs from the original stored recommendation.
  // recommendation_changed_at: timestamp of the last shadow-replay run for this row.
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS recommendation_v2 TEXT`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS recommendation_version INTEGER`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS recommendation_changed BOOLEAN`,
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS recommendation_changed_at TIMESTAMPTZ`,
  // data_quality integer column for the predictions table (was missing — only label existed)
  `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS data_quality INTEGER NOT NULL DEFAULT 0`,
  `UPDATE predictions SET data_quality = 0 WHERE data_quality IS NULL`,
  // Parlay Builder independent tables (separate from all Prediction Engine tables)
  `
  CREATE TABLE IF NOT EXISTS parlay_builder_settings (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS parlay_builder_sessions (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    builder_version TEXT NOT NULL DEFAULT '1.0.0',
    settings_version INTEGER,
    legs JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT
  )
  `,
  `CREATE INDEX IF NOT EXISTS parlay_builder_sessions_created_idx ON parlay_builder_sessions (created_at DESC)`,
  // Parlay Builder outcome tracking — primary calibration data source.
  // One row per leg per /validate call. actual_winner_id stays NULL until
  // the resolution job (scripts/resolveParlayLegOutcomes.ts) fills it in.
  `
  CREATE TABLE IF NOT EXISTS parlay_leg_outcomes (
    id                   SERIAL PRIMARY KEY,
    session_id           INTEGER REFERENCES parlay_builder_sessions(id),
    selected_player_id   TEXT NOT NULL,
    opponent_id          TEXT NOT NULL,
    selected_player_name TEXT NOT NULL,
    opponent_name        TEXT NOT NULL,
    tournament_name      TEXT,
    surface              TEXT,
    validation_score     INTEGER NOT NULL,
    risk_score           INTEGER NOT NULL,
    reliability_grade    TEXT NOT NULL,
    parlay_grade         TEXT NOT NULL,
    decision             TEXT NOT NULL,
    data_coverage        INTEGER NOT NULL,
    source_agreement     INTEGER NOT NULL,
    removal_probability  INTEGER NOT NULL DEFAULT 0,
    factor_scores        JSONB NOT NULL,
    market_odds          NUMERIC,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    actual_winner_id     TEXT,
    resolved_at          TIMESTAMPTZ,
    -- 'live' = submitted via /validate; 'backfill' = scored from historical graded match
    source               TEXT NOT NULL DEFAULT 'live',
    -- evaluation_predictions.id that this backfill row was scored from (null for live legs)
    backfill_match_id    INTEGER
  )
  `,
  // Forward-compat: columns added after initial table creation
  `ALTER TABLE parlay_leg_outcomes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'`,
  `ALTER TABLE parlay_leg_outcomes ADD COLUMN IF NOT EXISTS backfill_match_id INTEGER`,
  `ALTER TABLE parlay_leg_outcomes ADD COLUMN IF NOT EXISTS matchup_closeness INTEGER`,
  `ALTER TABLE parlay_leg_outcomes ADD COLUMN IF NOT EXISTS removal_probability INTEGER NOT NULL DEFAULT 0`,
  // Backfill dedup: one row per graded match (prevents re-running from doubling data)
  `CREATE UNIQUE INDEX IF NOT EXISTS parlay_leg_outcomes_backfill_match_idx ON parlay_leg_outcomes (backfill_match_id) WHERE backfill_match_id IS NOT NULL`,
  // Resolution job: scan for unresolved rows ordered by age
  `CREATE INDEX IF NOT EXISTS parlay_leg_outcomes_unresolved_idx ON parlay_leg_outcomes (created_at) WHERE actual_winner_id IS NULL`,
  // Calibration query: join on session
  `CREATE INDEX IF NOT EXISTS parlay_leg_outcomes_session_idx ON parlay_leg_outcomes (session_id)`,
  // Resolution job: match player pairs quickly
  `CREATE INDEX IF NOT EXISTS parlay_leg_outcomes_players_idx ON parlay_leg_outcomes (selected_player_id, opponent_id)`,

  // ── Parlay Builder: user-saved legs ──────────────────────────────────────────
  // Persists individual BuilderLegResult snapshots for the "Saved Parlays" folder.
  // Completely separate from parlay_leg_outcomes (which is calibration data).
  `
  CREATE TABLE IF NOT EXISTS parlay_saved_legs (
    id          SERIAL PRIMARY KEY,
    saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    leg_payload JSONB NOT NULL
  )
  `,

  // ── historical_matches: player-name search indexes (for match search endpoint) ─
  `CREATE INDEX IF NOT EXISTS historical_matches_player1_name_idx ON historical_matches (player1_name)`,
  `CREATE INDEX IF NOT EXISTS historical_matches_player2_name_idx ON historical_matches (player2_name)`,
  `CREATE INDEX IF NOT EXISTS historical_matches_tour_idx ON historical_matches (tour)`,
  `CREATE INDEX IF NOT EXISTS historical_matches_surface_idx ON historical_matches (surface)`,
  `CREATE INDEX IF NOT EXISTS historical_matches_tournament_level_idx ON historical_matches (tournament_level)`,

  // ── Parlay Builder: active session ────────────────────────────────────────────
  // Single-row store (id=1 singleton) for the current in-progress parlay session.
  // Upserted on every change so the session survives browser close / device switch.
  `
  CREATE TABLE IF NOT EXISTS parlay_active_session (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    session_payload JSONB NOT NULL DEFAULT '{}'::jsonb
  )
  `,
];

let ensured = false;

export async function ensureEvaluationSchema(): Promise<void> {
  if (ensured) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of STATEMENTS) {
      await client.query(statement);
    }
    await backfillPersistedInstrumentation(client);
    await client.query("COMMIT");
    ensured = true;
    logger.info("Evaluation/optimizer schema check completed");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function backfillPersistedInstrumentation(client: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  const predictionRows = await client.query(
    `SELECT id, engine, decision_trace, used_fallback, fallback_sources
       FROM predictions
      WHERE used_fallback IS NULL OR fallback_sources IS NULL`,
  );

  for (const row of predictionRows.rows) {
    const fallback = extractFallbackInstrumentation({
      engine: row.engine,
      decisionTrace: row.decision_trace,
    });

    if (fallback.usedFallback === null && fallback.fallbackSources === null) continue;

    await client.query(
      `UPDATE predictions
          SET used_fallback = COALESCE(used_fallback, $2),
              fallback_sources = COALESCE(fallback_sources, $3)
        WHERE id = $1`,
      [row.id, fallback.usedFallback, JSON.stringify(fallback.fallbackSources)],
    );
  }

  const evaluationRows = await client.query(
    `SELECT id, feature_snapshot, used_fallback, fallback_sources
       FROM evaluation_predictions
      WHERE data_segment IS NULL OR used_fallback IS NULL OR fallback_sources IS NULL`,
  );

  for (const row of evaluationRows.rows) {
    const featureSnapshot = row.feature_snapshot as { engine?: unknown } | null;
    const fallback = extractFallbackInstrumentation({
      engine: featureSnapshot?.engine,
    });

    await client.query(
      `UPDATE evaluation_predictions
          SET data_segment = COALESCE(data_segment, COALESCE(segment, 'live')),
              used_fallback = COALESCE(used_fallback, $2),
              fallback_sources = COALESCE(fallback_sources, $3)
        WHERE id = $1`,
      [row.id, fallback.usedFallback, JSON.stringify(fallback.fallbackSources)],
    );
  }
}
