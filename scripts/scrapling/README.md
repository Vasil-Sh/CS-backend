# Scrapling scraper for MatchIQ

Standalone Python scraper built on [Scrapling](https://github.com/D4Vinci/Scrapling).
It pulls **matches + predictions + bookmaker odds (кефи)** from tips.gg and **team
logos** from HLTV, then writes JSON cache files into `backend/.cache/` — in the exact
format the existing TS/Hono backend already reads.

## Why Scrapling

| Existing pain point | Scrapling feature |
|---|---|
| tips.gg Cloudflare bans (`shouldSkipTipsgg`, proxy pool, ban cooldown) | `StealthyFetcher(..., solve_cloudflare=True)` auto-solves Turnstile/Interstitial |
| Slow Puppeteer `page.goto(networkidle2)` (3–15s) | `Fetcher.get(..., impersonate='chrome', stealthy_headers=True)` — fast TLS-impersonated HTTP |
| HLTV ranking scraper HTTP 403 | Same `StealthyFetcher`/`Fetcher` with real browser fingerprint |

## Setup

```powershell
cd backend/scripts/scrapling
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
# download the Chromium browser used by StealthyFetcher (one-time, ~150MB)
.venv\Scripts\python -m patchright install chromium
```

## Run

```powershell
# from backend/
.venv\Scripts\python scripts\scrapling\scrapling_scrape.py all
.venv\Scripts\python scripts\scrapling\scrapling_scrape.py dota2
.venv\Scripts\python scripts\scrapling\scrapling_scrape.py cs2
.venv\Scripts\python scripts\scrapling\scrapling_scrape.py hltv
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--no-coeffs` | off | Skip predictions/odds enrichment (faster, no predictions-page fetches) |
| `--days` | `8` | How many days of matches to scrape (yesterday + today + next N-2) |
| `--max-coeff` | `25` | Cap on predictions pages fetched per game (mirrors backend safety cap) |
| `--coeff-pause` | `2.0` | Seconds between predictions-page requests |

## Output

| File | Consumed by |
|---|---|
| `backend/.cache/dota2_matches.json` | `createMatchesRouter.readFileCache` → `GET /api/v1/dota2-matches` |
| `backend/.cache/cs2_matches.json` | `createMatchesRouter.readFileCache` → `GET /api/v1/cs2-matches` |
| `backend/.cache/dota2_coefficients.json` | coefficients cache (shared, 20-min TTL) |
| `backend/.cache/hltv_logos.json` | `hltvRankingScraper` disk-read hook |

## How it integrates with the TS backend

The backend already serves whatever is in those cache files. A Python-written cache
with `day = today` and a fresh `ts` is served as-is (no TS-side re-scrape) for the
whole day — the TS `getMatchesWithSWR` only triggers its own Puppeteer scrape when the
cache is missing or from a previous day.

So a typical setup is: run the Python script on a schedule (cron / Windows Task
Scheduler), and the TS backend just serves the results.

## Notes

- **tips.gg hard-blocks by IP** (HTTP 403 "Sorry, you have been blocked"), it is *not* a
  solvable Turnstile challenge — so `solve_cloudflare=True` alone does not bypass it.
  This is the same limitation the TS scraper has. To scrape tips.gg you need rotating
  proxies: set the same `TIPSGG_PROXIES` env var the backend uses
  (`TIPSGG_PROXIES="http://user:pass@host:port,http://u2:p2@host2:port2"`). The script
  reads it and rotates to the next proxy on 403/429.
- **HLTV works out of the box** — `Fetcher` returns 200 directly (no proxy needed), so
  the HLTV logo scrape is reliable without any extra config.
- `Fetcher` (HTTP) is tried first for every page; on a block it falls back to
  `StealthyFetcher` with `solve_cloudflare=True` (45s timeout).
- The scraper respects the same safety margins as the TS pipeline: 800ms between
  requests, odds only for today's non-finished matches, capped at 25 predictions pages.
- HLTV ranking is parsed from the current DOM (`div.ranking-header` → `.name` +
  `.team-logo img`); the old `TeamName(NNN HLTV points)` text format no longer exists.
