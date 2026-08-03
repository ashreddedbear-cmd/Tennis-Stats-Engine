---
name: OCR fuzzy fallback design
description: How the screenshot resolver recovers from OCR character misreads using edit-distance ≤1 on the surname token
---

## Rule
When `resolvePlayerMatch` finds zero confident candidates, `ocrFuzzyFallback` is called before returning `"not-found"`. It generates targeted OCR-error variants of the surname (l↔I, 0↔O, rn↔m, VV→W), searches each via `searchKnownPlayers`, and returns exactly one candidate if its normalized surname is within Levenshtein distance ≤1. Status `"best-guess"` is distinct from `"resolved"` — the player IS set (prediction can proceed), but a disclaimer warning is always emitted.

**Why:** Common OCR misreads ("l" as "I", "0" as "O", "rn" as "m") produced hard "not-found" blocks for players whose names differ by a single character from the OCR reading. The best-guess path lets predictions proceed with a visible disclaimer rather than blocking the user entirely.

**How to apply:**
- `"best-guess"` status lives in `PlayerResolveOutcome` in `screenshotMatchupResolver.ts`
- Disclaimer warnings are emitted in `resolveOneMatchup` when status is `"best-guess"` and player is non-null
- The existing `"not-found"` path is preserved when no fuzzy candidate exists or when multiple candidates tie
- `ocrFuzzyFallback` only runs after `isWeakOcrIdentityKey` check passes (short/weak names skip it)
- Minimum surname length is 3 chars to avoid false positives on very short tokens
