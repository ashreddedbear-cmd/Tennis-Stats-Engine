---
name: Historical player search serial validation bottleneck
description: searchKnownPlayers had a serial await loop that caused 125s timeouts when MatchStat was down, plus no caching of transient failures and an overly strict abbreviated-name fallback gate.
---

## Rule
Three fixes must stay in sync in `playerIdentity.ts`:
1. **Parallelize** `validateHistoricalPlayerId` calls with `Promise.all` — the serial `for...await` over up to 50 unique player IDs takes N×(MatchStat timeout ~2.5s) before any player resolves.
2. **Cache transient failures** — add a separate short-TTL map (`historicalIdTransientFailureCache`, 2 min) so a 73-screenshot batch doesn't re-queue the same failing IDs for every screenshot.
3. **Extend abbreviated fallback gate** — the original `baseResultsEmpty` gate blocked abbreviated DB entries when ANY non-abbreviated historical result existed for the same LIKE query, even if that result was a *different* player with the same surname. Extended to: also activate the fallback when base results contain no entry whose surname matches the query surname.

**Why:** MatchStat is persistently routing to API-Tennis (both effectively down). Every `validateHistoricalPlayerId` cache-miss hit a 2.5s MatchStat timeout. 50 unique IDs × 2.5s = 125s serial → request timeout → every player showed LOW DATA regardless of how many historical matches they had.

**How to apply:** All three changes are in `artifacts/api-server/src/services/tennisData/playerIdentity.ts`. The transient failure cache uses a simple `Map<string, number>` (playerId → timestamp) separate from the main validation cache. The parallel loop uses `Promise.all(historicalEntries.map(...))` then iterates the results array by index.
