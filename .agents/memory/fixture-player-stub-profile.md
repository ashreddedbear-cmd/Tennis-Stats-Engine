---
name: Fixture player stub-profile fallback
description: Some players appear in API-Tennis fixtures but are absent from get_players and standings. Without a fallback, prediction hard-fails with 422.
---

## The rule
When `resolvePlayerProfileForPrediction` fails all resolution methods (direct lookup, historical sighting, name-search via standings) but a submitted player name is available, construct a stub profile from that name rather than returning `profile: null`.

**Why:** API-Tennis fixtures can reference players who:
- Return null from `get_players?player_key=<id>` (not in their player DB)
- Are absent from standings (not ranked → `searchPlayers` won't find them)
- Have no rows in our `historical_matches` (new/debut players)

Without the stub, `predictFromSnapshot` throws `PredictionSnapshotResolutionError` → 422 → "Predict Now failed — provider may be unavailable" on the home page.

**How to apply:**
- The stub uses `{ id: requestedPlayerId, name: submittedName, fullName: null, countryCode: null, currentRank: null, tour: null, age: null, plays: null }`.
- It is only constructed when `getPlayer` returned null (so there is no wrong-player risk).
- The prediction proceeds with empty match history → very low Data Quality → INSUFFICIENT_EDGE or LOW_CONFIDENCE. It will never produce HIGHEST_CONFIDENCE for a stub-profile player.
- Guard: only enter this path when `submittedName` is provided (fixture card sends player names; manual predict without a name should still hard-fail so you don't silently predict nobody).
- Location: `artifacts/api-server/src/services/tennisData/playerIdentity.ts`, inside `resolvePlayerProfileForPrediction`, in the `if (!sighting)` branch, after `resolvePlayerProfileByName` returns null.
