---
name: Sackmann local ZIP import
description: Conventions for the local-file Sackmann import path (ZIP naming, endpoint, dedup, player profile enrichment).
---

## ZIP filename conventions (differ from GitHub repos)

| File pattern | Tour | `rowToFixture` tour param |
|---|---|---|
| `{YYYY}.csv` | ATP main draw | `"ATP"` |
| `{YYYY}_wta.csv` | WTA main draw | `"WTA"` |
| `{YYYY}_challenger.csv` | ATP Challenger | `"ATP"` |
| `atp_quali/{YYYY}_atp_quali.csv` | ATP Qualifying | `"ATP"` |
| `atp_matches_amateur.csv` | Pre-Open Era | `"ATP"` |
| `ongoing_tourneys.csv` | ATP in-progress | `"ATP"` |
| `challenger_ongoing_tourneys.csv` | Challenger in-progress | `"ATP"` |
| `wta_ongoing_tourneys.csv` | WTA in-progress | `"WTA"` |

Extracted to: `attached_assets/sackmann_local/` (workspace root).

## Endpoint

`POST /api/evaluation/sackmann-local-backfill/run` — auth-gated (`requireAdmin`).
- `dryRun: true` → synchronous response with row counts (fast, no DB writes)
- `dryRun: false` → fire-and-forget; final counts in job_runs table

`GET /api/evaluation/sackmann-local-backfill/status` — reads job_runs for last import.

`GET /api/evaluation/matches/search` — query historical_matches with filters (player, surface, tournamentLevel, round, tour, yearFrom, yearTo, provider, limit, offset).

## Dedup

`historical_matches` already has a unique index on `(provider, external_id)`. The existing `runHistoricalBackfill` pre-queries for duplicates before insert — no ON CONFLICT needed. Re-running is always safe.

**Why:** The external_id for Sackmann rows is `{tourney_id}-{match_num}`, unique within the dataset. The unique index was in place before this task.

## Player profile enrichment

`ATP_Database.csv` (12,900 rows) is upserted into:
1. `master_players.country_code` via `api_tennis_key = 'sackmann-{id}'` (COALESCE — never overwrites)
2. `canonical_players` via `player_aliases` join on `provider='sackmann', external_player_id='{id}'`
   — updates `height_cm`, `date_of_birth`, `handedness`, `nationality` (all COALESCE)

Uses `unnest($1::text[], $2::text[])` for batch UPDATE — one query for 12,900 rows, not a loop.

## Stat columns

`raw_source` jsonb in `historical_matches` already stores the full raw CSV row via `fixture.raw`, including all serve stats (`w_ace`, `w_df`, `w_svpt`, etc.). No new column needed. Serve stats queryable via `raw_source->>'w_ace'` etc.

## Schema indexes added

Via `ensureEvaluationSchema.ts`: `historical_matches_player1_name_idx`, `player2_name_idx`, `tour_idx`, `surface_idx`, `tournament_level_idx` — applied on server restart.
