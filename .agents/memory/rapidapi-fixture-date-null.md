---
name: RapidAPI fixture match.date null fallback
description: RapidAPI upcoming/matches responses return match-level date as null for unscheduled rounds; must fall back to tournament.date or fixtures are silently dropped.
---

## The rule
In `matchStatProvider.ts` `mapMatchToFixture`, `m.date` is null for many matches (qualifying rounds, early draws before scheduling is confirmed). The `m.tournament.date` is always present and is the tournament start date.

**Fix:** `const rawDate = m.date ?? m.tournament?.date ?? null;`

**Why:** The old code did `if (!dateStr) return null` which silently discarded ALL fixtures that lacked a confirmed match time — including real, upcoming Grand Prix / Masters events at the start of the week.

## Related
- Fixture cache TTL extended from 3 min → 30 min to prevent RapidAPI quota exhaustion (~480 calls/day → ~48 calls/day).
- `timeConfirmed` stays false and `scheduledStart` stays null when only the tournament date is available — so the UI must show "Time TBD" rather than a fabricated time (task #56 tracks this).
- Sofascore tertiary fixture fallback added in `compositeProvider.ts` but the Sofascore `scheduled-events` endpoint is blocked (403) in the Replit sandbox — may work in the deployed environment.
