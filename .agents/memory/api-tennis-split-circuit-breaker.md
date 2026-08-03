---
name: API-Tennis Split Circuit Breaker and Priority Queue
description: Two separate circuit breakers (live/bulk) plus a priority call queue in ApiTennisProvider; what they protect, where they live, and the call routing rules.
---

## What was changed and why

A single `"api-tennis"` CircuitBreaker previously covered ALL provider calls. Walk-forward
`getPlayerMatches` timeouts accumulated failures on the shared breaker → breaker OPEN →
paper-trading `getUpcomingFixtures` also fast-failed → zero new predictions locked for the
entire walk-forward duration (confirmed 2026-08-01, ~3 hours blocked).

## The fix (artifacts/api-server/src/services/tennisData/apiTennisProvider.ts)

Two circuit breakers, registered separately in the global `getAllBreakerStatuses()` registry:
- `api-tennis-live` — fixture fetches, player lookups, standings, H2H (paper trading critical path)
- `api-tennis-bulk` — player match-history fetches (`getPlayerMatches`) and date-range backfill pulls (`getCompletedMatchesByDateRange`); the only two methods routed here

`PriorityCallQueue(maxConcurrent=4)` (in `src/lib/priorityCallQueue.ts`) wraps all calls:
- Live calls always dequeue ahead of bulk calls when both are waiting for a slot
- maxConcurrent=4 caps simultaneous requests, limiting timeout-burst size

## Call routing rules

| Method | Priority | Breaker |
|---|---|---|
| `getUpcomingFixtures` / `getUpcomingFixturesRange` | live | `api-tennis-live` |
| `getLiveScores` | live | `api-tennis-live` |
| `getPlayer` / `getStandingsCache` / `getCurrentStandings` | live | `api-tennis-live` |
| `getTournamentRows` / `getTournamentSurfaceMap` | live | `api-tennis-live` |
| `getHeadToHead` | live | `api-tennis-live` |
| `getPlayerMatches` | **bulk** | `api-tennis-bulk` |
| `getCompletedMatchesByDateRange` | **bulk** | `api-tennis-bulk` |

**Why:** `getTournamentSurfaceMap` is called from both live and bulk paths but is cached 24h
(real API call at most once per day) so routing it through the live breaker is safe.

## Key file

- `src/services/tennisData/apiTennisProvider.ts` — field declarations at top of class; `call()` method signature changed to `call<T>(priority: CallPriority, method: string, params?)`.
- `src/lib/priorityCallQueue.ts` — new; stateless priority queue, no external dependencies.

**Why:** Separate the failure blast radius. A bulk timeout storm opens `api-tennis-bulk` but
never touches `api-tennis-live`. Paper trading continues fetching fixtures throughout a
walk-forward run without needing any changes to callers or the composite provider.
