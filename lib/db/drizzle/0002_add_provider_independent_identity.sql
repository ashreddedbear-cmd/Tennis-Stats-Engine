-- Additive, reversible identity foundation. No existing rows are updated or deleted.
-- Rollback: drop the six tables in reverse dependency order after confirming no consumer uses them.

CREATE TABLE IF NOT EXISTS canonical_players (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  tour TEXT, nationality TEXT, date_of_birth TIMESTAMPTZ, handedness TEXT, height_cm INTEGER,
  active_from TIMESTAMPTZ, active_to TIMESTAMPTZ, review_status TEXT NOT NULL DEFAULT 'approved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canonical_players_normalized_name_idx ON canonical_players(normalized_name);
CREATE INDEX IF NOT EXISTS canonical_players_tour_idx ON canonical_players(tour);

CREATE TABLE IF NOT EXISTS player_aliases (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_player_id TEXT NOT NULL,
  external_player_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  canonical_player_id TEXT NOT NULL REFERENCES canonical_players(id),
  alias_type TEXT NOT NULL DEFAULT 'provider-id', verification_status TEXT NOT NULL DEFAULT 'verified',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_player_id)
);
CREATE INDEX IF NOT EXISTS player_aliases_normalized_name_idx ON player_aliases(normalized_name);
CREATE INDEX IF NOT EXISTS player_aliases_canonical_player_idx ON player_aliases(canonical_player_id);

CREATE TABLE IF NOT EXISTS canonical_matches (
  id TEXT PRIMARY KEY, match_key TEXT NOT NULL UNIQUE,
  player_a_id TEXT NOT NULL REFERENCES canonical_players(id), player_b_id TEXT NOT NULL REFERENCES canonical_players(id),
  tournament_name TEXT, normalized_tournament_name TEXT, tour TEXT, event_level TEXT,
  match_date TIMESTAMPTZ, round TEXT, surface TEXT, draw_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_source_links (
  id TEXT PRIMARY KEY, canonical_match_id TEXT NOT NULL REFERENCES canonical_matches(id),
  provider TEXT NOT NULL, external_match_id TEXT NOT NULL, source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_timestamp TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_match_id)
);
CREATE INDEX IF NOT EXISTS match_source_links_canonical_match_idx ON match_source_links(canonical_match_id);

CREATE TABLE IF NOT EXISTS player_resolution_reviews (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, provider TEXT, external_player_id TEXT,
  external_player_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  candidate_canonical_ids JSONB NOT NULL DEFAULT '[]'::jsonb, resolution_method TEXT NOT NULL,
  confidence REAL NOT NULL, supporting_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS historical_feature_diagnostics (
  id TEXT PRIMARY KEY, canonical_player_id TEXT NOT NULL REFERENCES canonical_players(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), matches_found INTEGER NOT NULL DEFAULT 0,
  date_from TIMESTAMPTZ, date_to TIMESTAMPTZ, surface_matches_found INTEGER NOT NULL DEFAULT 0,
  opponent_quality_sample INTEGER NOT NULL DEFAULT 0, serve_return_sample_size INTEGER NOT NULL DEFAULT 0,
  resolution_method TEXT NOT NULL, resolution_confidence REAL NOT NULL,
  source_coverage JSONB NOT NULL DEFAULT '{}'::jsonb, fallback_reason TEXT,
  historical_data_status TEXT NOT NULL, fallback_used BOOLEAN NOT NULL DEFAULT false,
  lineage JSONB NOT NULL DEFAULT '{}'::jsonb
);