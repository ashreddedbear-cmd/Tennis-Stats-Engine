---
name: MatchStat / API-Tennis ID space collision
description: MatchStat fixture player IDs collide with unrelated API-Tennis player IDs (often doubles teams). Three-layer fix required in the prediction route.
---

## Problem
MatchStat fixture cards submit `player1Id`/`player2Id` that are MatchStat-namespace integers. API-Tennis has its own integer IDs. These namespaces collide: MatchStat ID "73274" → "Tereza Valentova" in our DB, but API-Tennis `getPlayer("73274")` → "Collignon/ Herman" (a doubles team). This causes 409 "doubles/team names not allowed" errors.

Additionally, `getPlayer(id)` can be completely unreliable for IDs from the wrong namespace — `searchPlayers(name)` may be consistent but `getPlayer(search_result_id)` still returns a doubles team (Snigur / "55173").

## Fix applied (three layers)

**Layer 1 — `resolvePlayerProfileForPrediction` (playerIdentity.ts)**
- After `getPlayer(id)` returns a result, check if the name is doubles-like (`/\s\/\s|\//`).
- If so, skip it and fall through to historical-sighting / name-search fallback.
- Added optional `submittedName` parameter: when `findMostRecentHistoricalSighting(id)` returns null (player not in historical DB), use submitted name to do a live provider name search and construct a profile from that result.

**Layer 2 — `resolveCanonicalPlayerIdFromName` (predictions.ts)**
- `searchKnownPlayers` returns a mixed live+historical result set. MatchStat historical entries have full names ("Tereza Valentova"), live API-Tennis entries have abbreviated names ("T. Valentova").
- Fix: collect ALL matching candidates (exact + abbreviated), then prefer the abbreviated match (live API-Tennis ID) over the exact full-name match (historical MatchStat ID).
- Abbreviated match check uses single-letter initial after `normalizePlayerName` strips dots — check `cnWords[0].length === 1 && cnWords[0] === initial`, not `cnWords[0] === "${initial}."`.

**Layer 3 — `personNamesMatch` in `assertPredictionIdentityIntegrity` (predictionRequestIntegrity.ts)**
- Integrity check now compares with abbreviation tolerance: "Tereza Valentova" matches "T. Valentova" by checking that surnames are identical and one first-word is a single-letter initial of the other.

**Why:**
- `normalizePersonName` replaces non-alphanumeric with SPACE (so "T." → "t"), while `normalizePlayerName` removes non-alphanumeric entirely (so "T." → "t" too, but via different paths).
- Abbreviation check must use `startsWith`, not dot-suffixed comparison.

**How to apply:**
- Any time fixture cards from MatchStat (or another non-API-Tennis source) are used as prediction input, pass `submittedPlayer1Name`/`submittedPlayer2Name` in `PredictionSnapshotInput`.
- When adding new ID-namespace bridges, check both `getPlayer` AND `searchPlayers` consistency — they can diverge.
- Always validate "doubles-like name" check at `resolvePlayerProfileForPrediction` and `assertPredictionIdentityIntegrity`.
