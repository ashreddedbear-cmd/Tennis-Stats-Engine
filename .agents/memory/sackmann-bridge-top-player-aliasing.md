---
name: Sackmann bridge — top-player aliasing ceiling
description: Why the sackmann-to-live-API bridge doesn't fire for top-100 players and why that's acceptable.
---

## Rule
The identity-index bridge (`buildPlayerIdentityIndex`) aliases a sackmann ID to a live API ID **only when `idMap.size === 2`** (exactly one sackmann- entry and one live entry under the same normalized name). Top-100 players typically have 3–7 ID variants (multiple sackmann CSV sources + multiple live sources: API-Tennis, tennis-data-co-uk, ext-*), so the guard correctly blocks the alias.

**Why:** The 2-ID requirement is a safety constraint against wrong-player merges. Abbreviated names like "Djokovic N." could appear for two different players under different ID systems; aliasing across >2 IDs silently corrupts all of their historical data.

**How to apply:** When investigating "why isn't the Sackmann bridge enriching player X's history?", check whether `idMap.size > 2` under their normalized name. The fix is NOT to relax the guard — it's to ensure the external CSV bridge has run (which resolves IDs at import time, not at scoring time).

## Production evidence (2026-08-10)
- `aliasCount: 2` in DB-tier-5 logs confirms the bridge IS firing, but as sackmann-to-sackmann aliases (multiple CSV format variants of the same Sackmann player), not sackmann-to-live-API aliases.
- Djokovic: 3 sackmann IDs + 4 live IDs → `idMap.size = 7` → bridge blocked (correct).
- Practical impact is low: live API (MatchStat/API-Tennis) provides 3+ years of recent data for active top-100 players; Sackmann's pre-2016 early-career depth is only material for retired/lower-ranked players.
