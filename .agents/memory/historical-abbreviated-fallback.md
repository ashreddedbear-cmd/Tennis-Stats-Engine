---
name: Historical abbreviated-name last-resort fallback
description: Why WTA 125K/ITF players like M. Hontama fail to resolve and how the last-resort fallback in searchKnownPlayers fixes it.
---

## The Problem
WTA 125K / ITF players (e.g., Mai Hontama, Nao Hibino, Madison Brengle) are stored in `historical_matches` only as abbreviated names ("M. Hontama", id=1787). They never appear in API-Tennis WTA standings (those only cover the top-ranked players on the main tour). When the API-Tennis circuit breaker is open (payment required / quota exhausted), `validateHistoricalPlayerId` catches the `CircuitOpenError` and returns `undefined`.

The original code at `playerIdentity.ts` had:
```typescript
// validated === undefined (transient error path)
if (historicalNameIsWeak) continue; // ← dropped "M. Hontama" and all other abbreviated historical names
```

This made the entire historical fallback useless for WTA 125K/ITF players when the API was unavailable.

## The Fix (playerIdentity.ts)
Two-part change in `searchKnownPlayers`:

1. **Collect abbreviated transient-error entries separately** (`abbreviatedTransientFallback: PlayerSummary[]`) instead of discarding them.

2. **Last-resort merge**: after building `filteredHistorical`, if both `filteredLiveResults` and `filteredHistorical` are empty (`baseResultsEmpty = true`), add `fallbackEntries` from the abbreviated transient-error list.

```typescript
const baseResultsEmpty = filteredLiveResults.length === 0 && filteredHistorical.length === 0;
const fallbackEntries = baseResultsEmpty
  ? abbreviatedTransientFallback.filter((p) => !isShadowedByLive(p.name))
  : [];
```

## Why "last resort" matters
When Maiko Uchijima AND Moyuka Uchijima both appear in live standings as "M. Uchijima", `filteredLiveResults` is non-empty → `baseResultsEmpty = false` → fallback never fires. This prevents creating spurious ambiguity when both players ARE resolvable through normal means.

## When it fires
- API-Tennis circuit breaker is open (error 1006 "please make payment", or quota exhausted)
- Player has no entry in WTA/ATP standings (WTA 125K-only players)
- Player has no full-name singles entries in historical_matches (only abbreviated, or only doubles)

## Related
- The Uchijima test (`playerIdentity.uchijima.test.ts`) was pre-existing failing before this fix — it tests a separate issue (abbreviated live provider results vs full-name historical) that requires a different code path.

**Why:** Without this, the screenshot batch import rejects every WTA 125K match as "not found in any known player source", making the feature useless for any non-top-100 WTA event.
