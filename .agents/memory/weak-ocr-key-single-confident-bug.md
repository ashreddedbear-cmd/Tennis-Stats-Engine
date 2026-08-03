---
name: isWeakOcrIdentityKey blocks single-confident abbreviated resolution
description: isWeakOcrIdentityKey returned player:null for abbreviated "X. Surname" names even when exactly one confident candidate existed; fix: move confident.length===1 check before the weak-key gate.
---

## Rule
In `screenshotMatchupResolver.ts → resolvePlayerMatch`, the `confident.length === 1` check must come **before** `isWeakOcrIdentityKey`. A single-candidate match is unambiguous by definition; the weak-key guard is only meaningful when multiple candidates exist.

**Why:** `isWeakOcrIdentityKey` returns `true` for any name whose first token is one letter (e.g. "e meri", "s kopp", "t pereira"). The guard was designed to prevent false positives when "G. Castro" could match many players. But it also blocked ITF/lower-tier players whose canonical DB names are abbreviated — returning `player: null` and `status: "ambiguous"/"not-found"` even when the DB held exactly one matching record. Effect: every parlay leg with abbreviated-name players showed "LOW DATA" / unresolved when the live provider (API-Tennis) was down.

**How to apply:** Any time `isWeakOcrIdentityKey` behaviour is edited, verify the single-confident case still resolves. The guard should only reject when `confident.length > 1` (genuinely ambiguous) or `confident.length === 0` (nothing found).

**Root-cause signal:** When API-Tennis circuit breaker is OPEN, all `filteredLiveResults` are empty. Abbreviated historical rows go to `abbreviatedTransientFallback` (because `isWeakIdentityNameKey` detects "s kopp" as weak). The fallback is added when `baseResultsEmpty === true`. So the candidate DOES reach `gatherCandidates` — but then `isWeakOcrIdentityKey` kills it before the `confident.length === 1` path can fire.
