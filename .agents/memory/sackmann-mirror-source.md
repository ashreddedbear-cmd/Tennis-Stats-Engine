---
name: Sackmann mirror source
description: Public GitHub mirror used for Sackmann ATP historical backfill; covers 1968–2024 main-draw only
---

## Source
`farhadGithub/tennis-atp-data` — public GitHub repo, exact Sackmann column schema.
Path: `data/raw/atp_matches_YYYY.csv`, years 1968–2024 (57 match files + atp_players.csv).

Confirmed reachable from Replit via both:
- `raw.githubusercontent.com/farhadGithub/tennis-atp-data/master/data/raw/...` (HTTP 200, no auth)
- `api.github.com/repos/farhadGithub/tennis-atp-data/contents/data/raw/...` with PAT (HTTP 200)

The code uses `FARHAD_ATP_MIRROR_BASE` for ATP main-draw and falls back to the private
`JeffSackmann/tennis_atp` for ATP Challenger/qual files (those 404 gracefully — no public mirror).

## Coverage gaps
- **No Challenger/ITF files** — only main-draw. Players like Jodar (primarily Challenger) get no benefit.
- **No WTA** — no public mirror found; WTA URLs point to private Sackmann repo and 404.
- **2022 gap** — `atp_matches_2022.csv` exists in the mirror but imported 0 rows. Needs investigation (file may be empty or all matches skipped as duplicates in the mirror).
- **2025+** — mirror ends at 2024; future years need the private Sackmann repo or another source.

**Why:** JeffSackmann/tennis_atp and tennis_wta are private repos; the PAT provided belongs to
`demeqouis-code` (not JeffSackmann) so has no collaborator access.

## Validated run results
- Narrow 2023 ATP: 2,986 rows, 13,282 feature rows, 0 duplicates, 79s
- Full 2010–2022 ATP: 34,229 total sackmann rows (31,243 added), years 2010–2021 confirmed
- Player coverage post-import: Mannarino 643 total (524 sackmann), Nishikori 628 total (589 sackmann)
- Jodar: 107 total (API-Tennis only — Challenger player, not in main-draw files)
