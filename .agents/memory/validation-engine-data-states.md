---
name: Validation Engine — Multi-Source Resolution Architecture
description: 5-layer player data resolution for builderScoringService; distinguishes CACHE_HIT/PLAYER_NOT_FOUND/DATA_UNAVAILABLE; never misleads with Grade D when providers are down.
---

## Architecture: Local cache first, live provider last

```
Fixture player_key
  → Layer 1: direct ID lookup in historical_matches
  → Layer 2: identity index canonical ID + all alias IDs (IN clause)
  → Layer 3: name resolution via PlayerIdentityIndex (unambiguous name hit)
  → Layer 4: DB surname ILIKE + first-initial filter (single-result only)
  → Layer 5: live external provider search + getPlayerMatches()
  → NONE: report with diagnostic outcome state
```

**Layer 5 lives in `builderProviderFetch.ts`.** It uses `getTennisDataProvider()` (same singleton as the prediction engine), tries `searchPlayers()` with progressive name variants (full name, surname, NFD-stripped, without initial), checks each result with surname+initial confidence filter, then calls `getPlayerMatches(foundId)`. On success, records are written to `historical_matches` (non-blocking, best-effort) so the next request for the same player hits Layer 1.

## Resolution outcomes (from `builderProviderFetch.ts`)
| Outcome | Meaning |
|---|---|
| CACHE_HIT | Found in local DB via layers 1–4 (caller sets this) |
| CACHE_MISS | Not in local DB; Layer 5 was invoked |
| PLAYER_RESOLVED | Matched to a provider identity |
| DATA_FOUND | Match records retrieved from provider |
| SOURCE_UNAVAILABLE | Provider threw ProviderUnavailableError (timeout, auth, etc.) |
| PLAYER_NOT_FOUND | Provider searched successfully but no player match found |
| NO_MATCH_HISTORY | Player found, provider returned 0 completed matches |
| DATA_UNAVAILABLE | All providers unreachable; scoring impossible |

## DATA_UNAVAILABLE guard
When a player has 0 local rows AND Layer 5 returns `SOURCE_UNAVAILABLE`, `computeBuilderScore` returns early with `decision = "DATA_UNAVAILABLE"` **before computing any factor scores**. This prevents a Grade D or misleading scores when the real problem is provider downtime, not a bad pick. Frontend shows a grey "DATA UNAVAILABLE" badge (not REMOVE).

## MatchRecord → MatchRow conversion
`MatchRecord` is player-perspective (`result: "W"|"L"`, `opponentId`, `opponentRank`). Conversion: player is always `player1_id`; `winner_id = player1_id` when W, `opponentId` when L; `player1_rank = null` (MatchRecord doesn't return the player's own rank); `player2_rank = opponentRank`. This is correct for `computePlayerStats`'s `getOppRank` logic.

## DB save attribution
Records saved via Layer 5 use `provider = "builder-live-fetch:{providerName}"` so they can be identified and won't conflict with backfill rows (different provider tag). `ON CONFLICT DO NOTHING` prevents duplicates on re-fetch.

## Agreement denominator fix (same codebase)
Only `supportsSelected !== null` factors count in denominator. `sourcesTotal === 0` → frontend shows "Agreement: No data". Frontend shows "DATA UNAVAILABLE" badge for `DATA_UNAVAILABLE` decision, provider-aware messages for `PLAYER_NOT_FOUND`/`NO_MATCH_HISTORY`, and match-count + resolution path in the INSUFFICIENT DATA banner.

## Three player data states (`PlayerDataStatus`)
- `player_not_found` — 0 rows after ALL 5 layers
- `insufficient_data` — 1–4 rows
- `data_available` — ≥5 rows

**Why:** The previous architecture reported "No match history found — player may not be in the database" and scored Grade D from zero matches. That message is both wrong (the player HAS history — we just failed to look it up) and misleading (a Grade D sounds like a bad pick, not a data failure). The real diagnosis must name the specific failure: ID mismatch, provider outage, name not recognised, or genuinely no professional history.
