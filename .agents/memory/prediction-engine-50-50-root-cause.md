---
name: Prediction engine 50/50 root cause (api-tennis billing lapse)
description: Why all predictions collapsed to 50/50 and the fix applied
---

# Prediction engine 50/50 root cause

## What happened
When api-tennis.com's billing lapsed, both primary providers returned zero match records:
- MatchStat (tier-1): no `getPlayerMatches` endpoint by design — throws `ProviderUnavailableError`
- API-Tennis (tier-2): circuit breaker OPEN (billing error 1006)
- BSD Tennis (tier-3): fires via player-name → BSD ID lookup, but only covers top ~500 ranked players
- Sofascore (tier-4): unauthenticated scraper, returns sparse results for many players

With zero match records, `runPredictionEngine` receives `player1Matches: []` and `player2Matches: []`. Every sub-module (surfaceElo, recentForm, serveReturn, etc.) falls back to the corpus-wide Elo baseline (~1500 for both players) → logistic win probability = exactly 50%.

The comment in `predictionSnapshot.ts` (`safeGetMatches`) said "lets the prediction engine run on historical-DB data alone" but NO CODE actually did this.

## Fix applied
Added **tier-5 DB fallback** (`dbHistoryFallback.ts` + wired in `compositeProvider.ts`):
- Queries `historical_matches` by `player1_id OR player2_id = playerId`
- Filters to singles-only: `tour IN ('ATP','WTA','Challenger','ITF','Exhibition','Junior')` and `player name NOT LIKE '%/%'` (doubles teams have "/" in name)
- Returns up to 200 most recent completed matches as `MatchRecord[]`
- Fires as last resort when all live tiers return fewer than 5 records

**DB has 94k api-tennis singles rows (not sackmann-prefixed) up to July 2026** — sufficient to restore real predictions for virtually all players.

**Why DB is the right final fallback:**
- `historical_matches` uses the same api-tennis.com player ID namespace as the prediction engine — no name resolution needed
- Sackmann rows use "sackmann-XXXXX" IDs and won't match api-tennis lookups — they're silently skipped
- The DB is always available even when every external API is down

**Why:** Without this fallback, any api-tennis.com billing lapse (or sustained outage) collapses every prediction to 50/50, making the product appear broken to users.

## Key caveats
- Players with NO historical_matches rows still get 50/50 (newly active players, players not in backfill range)
- Sackmann data (top historical ATP/WTA from 2000-2024) is NOT used because their IDs don't match
- BSD Tennis tier-3 supplements the DB for top-500 ranked players, providing fresher data than historical_matches when api-tennis.com is down
