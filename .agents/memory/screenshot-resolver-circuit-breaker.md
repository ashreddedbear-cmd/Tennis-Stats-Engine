---
name: Screenshot resolver circuit-breaker resilience
description: Three bugs that caused "P1: NOT READ / P2: NOT READ" when the api-tennis circuit breaker was open, plus a normalizeName bug affecting double-initial names like J.J. Wolf.
---

## The bugs and fixes

### 1. `searchKnownPlayers` threw on circuit-breaker-open
`provider.searchPlayers()` calls inside `searchKnownPlayers` (playerIdentity.ts) had no error handling. Circuit-breaker open → throws → propagated all the way to `resolveScreenshotMatchup` → ScreenshotImportService catch block → `recognizedName: null` for both players (the OCR-read names were discarded).

**Fix:** Wrap `provider.searchPlayers()` in a `searchSafely()` helper that catches and returns `[]`, letting the function fall through to historical-DB results.

### 2. `resolveEventMatch` threw on circuit-breaker-open
`provider.findTournamentSurfaceByName()` call had no try-catch. Same propagation path.

**Fix:** Wrap in try-catch; surface stays null on error (graceful degradation).

### 3. ScreenshotImportService cached failed resolver results
When the resolver threw (bugs 1+2), the catch block built a result with `recognizedName: null`. This result was then cached (`cacheSet`). Every subsequent upload of the same image instantly returned the bad cached result, even after the provider recovered.

**Fix:** Added `resolutionThrew` flag; skip `cacheSet` when the resolver itself threw a hard error.

### 4. normalizeName collapsed "J.J." to "jj" (single token)
`normalizeName` in screenshotMatchupResolver.ts used `replace(/[^a-z0-9\s]/g, "")` which **removes** dots, making "J.J. Wolf" → "jj wolf" (one token "jj"). `wordsMatch` only treats 1-char tokens as initials, so "jj" never matched "jeffrey" or "john".

**Fix:** Added pre-normalization step: `.replace(/\b([a-z])\.([a-z])\./g, "$1 $2 ")` expands "j.j." → "j j " before stripping, giving tokens ["j","j","wolf"] that the bijective initial-expansion handles correctly.

**Why:** `wordsMatch(a, b)` checks `b.length === 1` for initial expansion. Multi-initial abbreviations like "J.J." must be split into separate single-char tokens first.

## Key debugging insight
"P1: NOT READ" / "P2: NOT READ" (recognizedName === null) does NOT mean OCR failed — it means either (a) the ScreenshotImportService resolver threw and the catch block discarded the names, or (b) a cached failed result is being returned. Always check for "Player resolution failed" warning + 1-line debug log (cache hit) as indicators of this path.
