---
name: ext-csv cross-tour Sofascore ID collision
description: ATP and WTA CSV files from this Sofascore-sourced format share the same numeric match_id namespace — the same integer can refer to two completely different matches, one ATP and one WTA.
---

## Rule
Always prefix the stored `external_id` with the tour when importing from these Sofascore-sourced CSVs: `atp-{match_id}` and `wta-{match_id}`. Never store the bare numeric `match_id` as the `external_id` in `historical_matches`.

**Why:** The unique constraint on `(provider, external_id)` only prevents exact-duplicate rows. When the same integer appears in both an ATP file and a WTA file (confirmed: `match_id=23421494` is a WTA Madrid match AND an ATP Karlsruhe Challenger match), the first insert lands with the bare ID, the backfill integrity guard later detects 10 feature snapshots on a match that should have 5, and the job halts. The entire partial import must be wiped and re-run.

**How to apply:** In `externalCsvBackfill.ts` → `rowToFixture()`, line where `scopedId` is constructed — keep the `${tour.toLowerCase()}-${externalId}` prefix. If this file is ever extended to support other cross-tour CSV sources (e.g. tennis-data.co.uk), apply the same tour-prefixing rule there too.

## Incident summary
- First run failed at match 256866 (WTA Apr-24) after ~25k rows were inserted
- Root cause: ATP Jul-24 match with the same numeric ID was processed second; the integrity check found 10 snapshots (2 × 5) on the WTA row
- Fix: scope the ID on line 294 of externalCsvBackfill.ts; wipe all partial ext-csv rows; re-run
- Second run completed cleanly: 14,316 ATP + 19,788 WTA rows inserted
