---
name: Sackmann backfill data sources
description: Status of Sackmann historical backfill data sources (GitHub private + Kaggle mirror coverage gaps)
---

## Current state

JeffSackmann's `tennis_atp` and `tennis_wta` GitHub repos are **private** (all raw.githubusercontent.com URLs return 404). Zero sackmann-provider rows in DB.

## Data sources implemented

| Source | ATP coverage | WTA coverage | Auth needed |
|---|---|---|---|
| GitHub | All years + qual/chall | All years + qual/itf | `GITHUB_PAT` env var |
| Kaggle `gmadevs/atp-matches-dataset` | 2000–2017 main-draw only | — | `KAGGLE_API_TOKEN` with download permission |
| Kaggle `gmadevs/wta-matches` | — | 2000–2016 main-draw only | `KAGGLE_API_TOKEN` with download permission |

## Auth token status

- `GITHUB_PAT`: not set — GitHub URLs return 404 without it (repo is private)
- `KAGGLE_API_TOKEN`: **present but read-only** — list/search API works but all download endpoints return HTTP 404 in the dev sandbox. Downloads may work in production. Token is 61 chars (not username:key format).

## Kaggle file format

Both `gmadevs` datasets use the exact Sackmann column format (`winner_id`, `loser_id`, `tourney_date` YYYYMMDD, etc.) — the parser in sackmannBackfill.ts works unchanged.

## `dissfya/atp-tennis-2000-2023daily-pull`

Single combined file `atp_tennis.csv` — NOT per-year format. Requires a different parser. Not yet implemented.

## Code location

`sackmannBackfill.ts` — `fetchCsvYear(githubUrl, kaggleDataset?, kaggleFilename?)` tries Kaggle first then GitHub. Qual/chall files skip Kaggle (no mirror).

**Why:** source precedence allows Kaggle to fill in 2000-2017 when GitHub is private, and GitHub fills the rest when PAT is available.

## Unblocking options

1. Set `GITHUB_PAT` with repo read access to the private Sackmann repos → full coverage
2. Provide a `KAGGLE_API_TOKEN` with download permission (current token is read-only) → partial coverage 2000-2017 ATP / 2000-2016 WTA
