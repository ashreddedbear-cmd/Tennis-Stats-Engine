---
name: BSD Tennis provider (sports.bzzoiro.com)
description: Integration notes for the BSD Tennis API used as tier-3 match history fallback
---

# BSD Tennis provider

## Auth & base URL
- Base: `https://sports.bzzoiro.com`
- Auth: `Authorization: Token $BSD_TENNIS_API_KEY` (NOT query param — query param returns 401)
- Secret name: `BSD_TENNIS_API_KEY`

## Confirmed working endpoints
| Endpoint | Notes |
|---|---|
| `/tennis/api/v2/players/?name=<fragment>` | Returns all players (name filter is ignored/unfiltred — don't rely on it) |
| `/tennis/api/v2/rankings/?limit=50&offset=N` | ATP+WTA top ~500 each; count=500; use for name→ID mapping |
| `/tennis/api/v2/matches/?player_id=<id>&limit=200` | Completed + upcoming; filter winner_id != null for completed |
| `/tennis/api/v2/matches/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` | Date-range match fetch |
| `/tennis/api/v2/matches/{id}/h2h/` | H2H for a specific match |
| `/tennis/api/v2/matches/live/` | Live matches |
| `/tennis/api/v2/tournaments/` | Tournament list |

## Player ID resolution
- BSD uses its OWN integer player IDs (516 = Jannik Sinner, not api-tennis.com IDs)
- Name filter on `/tennis/api/v2/players/` does NOT filter — returns all players alphabetically
- **Correct approach**: lazy-load rankings pages (10 pages × 50 = 500 players), build normalized name→ID cache, 1-hour TTL
- Surname fallback for abbreviated names (e.g. "J. Sinner" → find by "sinner")
- Players NOT in top 500 are not found → falls through to Sofascore tier-4

## Match response shape
```json
{
  "id": 43702,
  "tournament": { "name": "...", "circuit": "ATP", "category": "utr", "surface": "clay" },
  "player1": { "id": 534, "name": "...", "current_ranking": null },
  "player2": { "id": 6176, "name": "...", "current_ranking": null },
  "match_date": "2026-07-27T20:25:00+00:00",
  "status": "finished",
  "player1_sets": 2, "player2_sets": 0,
  "sets_detail": [{"p1": 6, "p2": 4}, {"p1": 6, "p2": 3}],
  "winner_id": 534,
  "odds_player1": 1.06, "odds_player2": 5.68
}
```

## Surface / level mapping
- surface: "clay"→Clay, "hard"→Hard, "grass"→Grass, "indoor_hard"→IndoorHard
- category: "grandslam"→GrandSlam, "masters"→Masters1000/WTA1000, "atp500"/"wta500"→ATP500/WTA500, "atp250"/"wta250"→ATP250/WTA250, "challenger"→Challenger, "itf"→ITF, "utr"→Other

## Composite provider placement
- Tier-3 (after MatchStat tier-1 and API-Tennis tier-2 both fail)
- Tier-4: Sofascore (unauthenticated public API, broader Challenger/ITF coverage)
- BSD wired in `compositeProvider.ts` → `fetchFromBsdTennis()` in `bsdTennisProvider.ts`

## What it does NOT support (as of wiring date)
- `getCompletedMatchesByDateRange` not yet wired — historical backfill still goes through API-Tennis only
- The `/tennis/api/v2/matches/?date_from=&date_to=` endpoint could serve this but needs a `HistoricalFixture` mapper

**Why:** BSD Tennis is a real structured JSON API (not a scraper), covers top ATP/WTA ranked players, uses the same key for all calls, 0% quota used as of 2026-07-31.
