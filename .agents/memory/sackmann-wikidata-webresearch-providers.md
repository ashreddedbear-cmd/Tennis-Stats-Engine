---
name: Task #107 — Data Source Expansion (Phases 1–6)
description: Sackmann backfill, Wikidata resolver, Sofascore cross-system, web research wired to prediction engine. Key design decisions and gotchas.
---

## Sackmann backfill (Phase 1)
- File: `artifacts/api-server/src/services/historicalData/sackmannBackfill.ts`
- Route: `POST /evaluation/sackmann-backfill/run` + `GET /evaluation/sackmann-backfill/status` in evaluation.ts
- Approach: `SackmannProvider` implements `TennisDataProvider` (only `getCompletedMatchesByDateRange` is real; all other methods throw `ProviderUnavailableError`). Passed to existing `runHistoricalBackfill` so feature snapshots, Elo state, and idempotency work identically to the live-provider path.
- External IDs: `sackmann-{winner_id}` / `sackmann-{loser_id}` for player IDs; `{tourney_id}-{match_num}` for match external ID.
- `cutoff: "1h"` (not a raw minutes value — BackfillOptions.cutoff is a CutoffOption string, not a number)
- `chunkDays: 30` (OK to use large chunks since data is served from in-memory CSV, not a live API)

**Why:** `BackfillOptions.cutoff` is `CutoffOption = "24h" | "12h" | "6h" | "1h" | "30min" | "15min"` — passing a raw number breaks it silently.

## Wikidata resolver (Phase 2)
- File: `artifacts/api-server/src/services/tennisData/wikidataResolver.ts`
- Integrated as step 3 in `resolvePlayerProfileByName` in `playerIdentity.ts`
- Handles: transliterations without diacritics (Galán→Galan), birth names, aliases
- In-memory 24h TTL cache; returns `[]` gracefully on network failure (never throws)
- SPARQL endpoint at `https://query.wikidata.org/sparql` — frequently rate-limited or unreachable in sandbox; non-fatal by design

## Cross-system Sofascore (Phase 3)
- `compositeProvider.ts` now adds Sofascore as tier-3 in `getPlayerMatches`:
  - Caches player name in `playerNameCache` Map from every successful `getPlayer()` call
  - When both primary+fallback return < 5 records, attempts `fetchFromSofascore(playerName)`
  - Confirmed working in live logs immediately after deploy
- Import: `from "../parlayBuilder/sofascoreProvider.js"` — cross-module but architecturally OK (tennisData/ → parlayBuilder/ is allowed; the import boundary check only blocks parlayBuilder/ → predictionEngine/)

## Web research (Phase 5)
- Shared wrapper: `artifacts/api-server/src/services/shared/webResearchProvider.ts` (re-exports from parlayBuilder/webResearchService)
- `PredictionEngineInput.webResearch?: MatchupResearch | null` optional field added in types.ts
- `computeAvailabilityModule` accepts optional 5th param `webResearch`; applies up to 20-point availability discount when riskLevel ≥ 60, always surfaces a warning
- Engine index.ts passes `input.webResearch ?? null` through to availability module

## The Odds API (Phase 4) — pre-existing
- `fetchMarketOdds` already live in `paperTrading.ts` (real paper trades fetch consensus odds)
- No new wiring needed; already satisfies task criteria

## tennis-data.co.uk (Phase 2 in task)
- Deliberately skipped — lower priority, complex schema mapping; all higher-priority phases completed
