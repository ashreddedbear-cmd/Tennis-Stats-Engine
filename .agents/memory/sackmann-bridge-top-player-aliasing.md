---
name: Sackmann bridge — top-player aliasing ceiling
description: Why the sackmann-to-live-API bridge doesn't fire for top-100 players and why that's acceptable.
---

## Rule
The identity-index bridge (`buildPlayerIdentityIndex`) aliases a sackmann ID to a live API ID **only when `idMap.size === 2`** (exactly one sackmann- entry and one live entry under the same normalized name). Top-100 players typically have 3–7 ID variants (multiple sackmann CSV sources + multiple live sources: API-Tennis, tennis-data-co-uk, ext-*), so the guard correctly blocks the alias.

**Why:** The 2-ID requirement is a safety constraint against wrong-player merges. Abbreviated names like "Djokovic N." could appear for two different players under different ID systems; aliasing across >2 IDs silently corrupts all of their historical data.

**How to apply:** When investigating "why isn't the Sackmann bridge enriching player X's history?", check whether `idMap.size > 2` under their normalized name. The fix is NOT to relax the guard — it's to ensure the external CSV bridge has run (which resolves IDs at import time, not at scoring time).

## Verified impact of the gap (2026-08-10 audit)

**The Elo module has NO hard date cutoff** — it replays all supplied matches with exponential decay (half-life 545 days, floor 0.12). Pre-2016 data contributes 12% weight — not zero. So the bridge gap does affect Elo quality when those rows are unavailable.

**Why the practical impact is still narrow:**
- API-Tennis returns 548 days (~18 months) of data. BSD returns 3 years (capped at 1,000). MatchStat has no match-history endpoint.
- DB tier-5 fallback fires only when live providers return <5 records (`compositeProvider.ts:247-302`). Active top-100 players will almost always exceed 5 records from the live API, so tier-5 never fires for them.
- Layer 4 name-search is restricted to `NOW() - INTERVAL '2 years'` in live mode, also unreachable for pre-2016 data.

**Real failure mode (narrow but not zero):** All three live providers down simultaneously AND the player has <5 live-ID rows in historical_matches from prior walk-forward runs → scoring falls to thin-data disclosure instead of reaching Sackmann career depth. The bridge gap is load-bearing only in degraded provider state.

## Production evidence (2026-08-10)
- `aliasCount: 2` in DB-tier-5 logs: bridge fires as sackmann-to-sackmann aliases (multiple CSV variants), NOT sackmann-to-live-API aliases.
- Djokovic: 3 sackmann IDs + 4 live IDs → `idMap.size = 7` → bridge blocked (correct by design).
- No code path outside the identity bridge allows a live-API ID query to reach sackmann-prefixed rows.
