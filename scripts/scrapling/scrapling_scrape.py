#!/usr/bin/env python3
"""
Scrapling-based scraper for MatchIQ.

Fetches matches + predictions + bookmaker odds (кефи) from tips.gg and team
logos from HLTV, then writes JSON cache files in the EXACT format the TS/Hono
backend reads from `backend/.cache/`:

  dota2_matches.json   -> {"data": [TipsGgMatch...], "ts": <ms>, "day": "YYYY-MM-DD", "from": "fresh"}
  cs2_matches.json     -> same shape, CS2
  hltv_logos.json      -> {"data": {"normalizedTeamName": "cdn url", ...}, ...}

The TS backend already serves these files via `createMatchesRouter.readFileCache`
(no TS changes needed for matches). HLTV logos are picked up by a small disk-read
hook in `hltvRankingScraper.ts`.

Why Scrapling instead of the existing Puppeteer pipeline:
  * `Fetcher` does fast TLS-impersonated HTTP (`impersonate='chrome'`,
    `stealthy_headers`) — often enough for tips.gg static JSON-LD pages.
  * `StealthyFetcher` runs a stealth browser and can auto-solve Cloudflare
    Turnstile/Interstitial (`solve_cloudflare=True`) — the #1 pain point we had
    with tips.gg and HLTV (403 / "Just a moment" pages).

Usage (run from backend/):
  python scripts/scrapling/scrapling_scrape.py all
  python scripts/scrapling/scrapling_scrape.py dota2
  python scripts/scrapling/scrapling_scrape.py cs2
  python scripts/scrapling/scrapling_scrape.py hltv
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Scrapling imports (installed via requirements.txt) ──────────────────────
try:
    from scrapling.fetchers import Fetcher, StealthyFetcher
    from scrapling.parser import Selector
except Exception as exc:  # pragma: no cover - bootstrapping helper
    print(
        "[scrapling] Scrapling is not installed.\n"
        "  cd backend/scripts/scrapling\n"
        "  python -m venv .venv\n"
        "  .venv/Scripts/python -m pip install -r requirements.txt\n"
        f"  (underlying error: {exc})",
        file=sys.stderr,
    )
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────────────
TIPSGG_BASE = "https://tips.gg"
BACKEND_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = BACKEND_DIR / ".cache"

COEFF_CACHE_FILE = CACHE_DIR / "dota2_coefficients.json"
COEFF_TTL_MS = 20 * 60 * 1000  # 20 min — mirrors backend/src/services/coefficientsCache.ts

GAME_PATHS = {"dota2": "dota2", "cs2": "csgo"}
GAME_TAGS = {"dota2": "dota2", "cs2": "cs2"}

# Known CDN filename overrides — mirrors LOGO_OVERRIDES in tipsggScraper.ts
LOGO_OVERRIDES = {
    "nigma-galaxy-dota2": "nigma-galaxy-dota2-dota2",
    "playtime-dota2": "PlayTime-dota2",
    "nemiga-gaming-dota2": "nemiga-gaming-2020-dota2",
    "gamerlegion-dota2": "Gamerlegion-cs21",
    "betboom-team-dota2": "betboom-dota2",
    "team-spirit-dota2": "team-spirit-2021-dota2",
    "psg-lgd-gaming-dota2": "psg-lgd-gaming-dota2",
    "team-syntax-dota2": "Team-Syntax-dota2",
}

BLOCK_MARKERS = ("_cf_chl_opt", "just a moment", "cf-browser-verify", "sorry, you have been blocked")


# ── Small helpers ────────────────────────────────────────────────────────────
def _body_text(page) -> str:
    body = getattr(page, "body", b"")
    if isinstance(body, bytes):
        return body.decode("utf-8", "replace")
    return str(body)


def _is_blocked(html: str) -> bool:
    if not html:
        return True
    low = html.lower()
    return any(marker in low for marker in BLOCK_MARKERS)


def slug_from_url(url: str) -> str:
    parts = url.rstrip("/").split("/")
    if len(parts) >= 2:
        return parts[-2]
    return parts[-1] if parts else url


def parse_iso_date(s: str) -> str:
    if not s or not isinstance(s, str):
        return ""
    parts = s.split("T")[0]
    try:
        datetime.strptime(parts, "%Y-%m-%d")
        return parts
    except ValueError:
        return ""


def _parse_dt_ms(s: str) -> float | None:
    """Best-effort ISO-8601 -> epoch ms. Handles 'Z' and '+0300' offsets."""
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    s = re.sub(r"([+-])(\d{2})(\d{2})$", r"\1\2:\3", s)
    try:
        return datetime.fromisoformat(s).timestamp() * 1000
    except ValueError:
        return None


def parse_match_type(desc: str) -> str:
    m = re.search(r"BO(\d+)", desc or "", re.I)
    return f"BO{m.group(1)}" if m else "BO3"


def parse_stage(desc: str) -> str:
    for part in [p.strip() for p in (desc or "").split(".")]:
        if re.search(
            r"group|playoff|final|stage|quarter|semi|grand|lower.?bracket|upper.?bracket|decider|tiebreaker",
            part,
            re.I,
        ):
            return part
    return ""


def normalize_team_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower()).strip()


def tournament_logo_from_organizer_url(organizer_url: str | None) -> str | None:
    if not organizer_url:
        return None
    m = re.search(r"tips\.gg/tournament/([^/?#]+)", organizer_url, re.I)
    if not m:
        return None
    return f"https://files.tips.gg/static/image/tournaments/{m.group(1)}.png"


# ── Fetching (fast HTTP -> stealth browser fallback) ─────────────────────────
_last_request = 0.0
MIN_DELAY_S = 0.8  # mirror the TS rate limiter (800ms between tips.gg requests)
PROXY_BAN_MS = 10 * 60 * 1000  # ban a blocked proxy for 10 min

# Proxy pool — mirrors backend/src/services/proxyPool.ts. Reads the same
# TIPSGG_PROXIES env var (comma-separated URLs). tips.gg serves a HARD 403
# (IP block), not a solvable Turnstile challenge, so rotating IPs is the only
# reliable bypass — identical to the TS scraper's limitation.
_proxies = [p.strip() for p in (os.environ.get("TIPSGG_PROXIES", "") or "").split(",") if p.strip()]
_proxy_cursor = 0
_proxy_banned_until: dict[int, float] = {}


def _current_proxy() -> str | None:
    global _proxy_cursor
    if not _proxies:
        return None
    now = time.time() * 1000
    for i in range(len(_proxies)):
        idx = (_proxy_cursor + i) % len(_proxies)
        if now >= _proxy_banned_until.get(idx, 0):
            _proxy_cursor = idx
            return _proxies[idx]
    idx = min(range(len(_proxies)), key=lambda i: _proxy_banned_until.get(i, 0))
    _proxy_cursor = idx
    return _proxies[idx]


def _ban_current_proxy(ms: float = PROXY_BAN_MS) -> None:
    if _proxies:
        _proxy_banned_until[_proxy_cursor] = time.time() * 1000 + ms


def _rate_limit() -> None:
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_DELAY_S:
        time.sleep(MIN_DELAY_S - elapsed)
    _last_request = time.time()


def fetch_html_fast(url: str) -> str | None:
    _rate_limit()
    attempts = len(_proxies) if _proxies else 1
    for _ in range(attempts):
        proxy = _current_proxy()
        try:
            page = Fetcher.get(
                url,
                stealthy_headers=True,
                impersonate="chrome",
                timeout=20,
                retries=1,
                proxy=proxy,
            )
            status = getattr(page, "status", None)
            if status == 200:
                html = _body_text(page)
                if not _is_blocked(html):
                    return html
            elif status in (403, 429, 503):
                _ban_current_proxy()
        except Exception:
            _ban_current_proxy()
    return None


def fetch_html_stealth(url: str) -> str | None:
    proxy = _current_proxy()
    try:
        page = StealthyFetcher.fetch(
            url,
            solve_cloudflare=True,
            headless=True,
            timeout=45000,
            wait_selector='script[type="application/ld+json"]',
            proxy=proxy,
        )
        html = _body_text(page)
        return None if _is_blocked(html) else html
    except Exception:
        return None


def fetch_html(url: str) -> str | None:
    html = fetch_html_fast(url)
    if html:
        return html
    return fetch_html_stealth(url)


# ── JSON-LD extraction (mirrors extractJsonLd in tipsggScraper.ts) ───────────
def extract_json_ld(html: str, game: str) -> list[dict]:
    results: list[dict] = []
    sport_pattern = (
        re.compile(r"cs2|csgo|counter[- ]?strike", re.I)
        if game == "cs2"
        else re.compile(r"dota\s*2", re.I)
    )
    for m in re.finditer(
        r'<script[^>]*type="application/ld\+json"[^>]*>([\s\S]*?)</script>',
        html,
        re.I,
    ):
        try:
            data = json.loads(m.group(1))
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        typ = data.get("@type")
        is_event = typ in ("SportsEvent", "Event")
        sport = data.get("sport") or ""
        is_correct_sport = not sport or bool(sport_pattern.search(sport))
        competitors = data.get("competitor") or []
        if (
            is_event
            and is_correct_sport
            and isinstance(competitors, list)
            and len(competitors) >= 2
        ):
            results.append(data)
    return results


# ── Score + status extraction (mirrors extractScoresFromHtml) ────────────────
def extract_scores_from_html(html: str, raw_match_url: str):
    slug = slug_from_url(raw_match_url)
    if not slug:
        return None, None, "upcoming"

    sel = Selector(html)
    match_el = None
    for el in sel.css(".element.match"):
        links = el.css("a.match-link")
        if links and slug in (links[0].attrib.get("href") or ""):
            match_el = el
            break
    if match_el is None:
        return None, None, "upcoming"

    classes = (match_el.attrib.get("class") or "").split()
    status = "upcoming"
    if "finished" in classes:
        status = "finished"
    elif "live" in classes:
        status = "live"

    scores: list[int] = []
    for s in match_el.css(".scores .score"):
        txt = (s.text or "").strip()
        if txt.isdigit():
            scores.append(int(txt))
        else:
            mm = re.search(r"\d+", txt)
            if mm:
                scores.append(int(mm.group()))

    all_low = len(scores) > 0 and all(v <= 5 for v in scores)
    if all_low:
        score1 = scores[0] if len(scores) > 0 else 0
        score2 = scores[1] if len(scores) > 1 else 0
    else:
        score1 = 0
        score2 = 0
        for i in range(0, len(scores) - 1, 2):
            if scores[i] > scores[i + 1]:
                score1 += 1
            elif scores[i + 1] > scores[i]:
                score2 += 1

    if len(scores) >= 1:
        all_zero = score1 == 0 and score2 == 0
        return score1, score2, (status if status != "upcoming" else ("upcoming" if all_zero else "live"))

    text = match_el.get_all_text() or ""
    mm = re.search(r"\b([0-5])\s*:\s*([0-5])\b", text)
    if mm:
        return int(mm.group(1)), int(mm.group(2)), (status if status != "upcoming" else "finished")

    return None, None, status


def extract_tips_count(html: str, raw_match_url: str) -> int:
    absolute = raw_match_url if raw_match_url.startswith("http") else TIPSGG_BASE + raw_match_url
    href_marker = f'href="{absolute}"'
    idx = html.find(href_marker)
    if idx == -1:
        return 0
    chunk = html[max(0, idx - 500): idx + 500]
    mm = re.search(r"(\d+)\s+tips?", chunk, re.I)
    return int(mm.group(1)) if mm else 0


# ── Logo map (mirrors buildLogoMap) ──────────────────────────────────────────
def build_logo_map(html: str, game: str) -> dict[str, str]:
    sport_pattern = (
        re.compile(r"\s[-–—]\s(Counter-Strike|CS2|CSGO)\s", re.I)
        if game == "cs2"
        else re.compile(r"\s[-–—]\sDota\s2\s", re.I)
    )
    sel = Selector(html)
    result: dict[str, str] = {}
    for img in sel.css("img"):
        alt = (img.attrib.get("alt") or "").strip()
        if not sport_pattern.search(alt):
            continue
        src = img.attrib.get("data-src") or img.attrib.get("src") or ""
        if not src or src.startswith("data:") or "default" in src:
            continue
        team = re.sub(
            r"\s*[-–—]\s*(Dota 2|Counter-Strike|CS2|CSGO)\s*(Team)?$",
            "",
            alt,
            flags=re.I,
        ).strip()
        if team and team not in result:
            result[team] = src
    return result


def get_team_logo(team_name: str, team_url: str, logo_map: dict[str, str]) -> str | None:
    if team_name in logo_map:
        return logo_map[team_name]
    for key, url in logo_map.items():
        if key.lower() == team_name.lower():
            return url
    slug = team_url.rstrip("/").split("/")[-1] if team_url else ""
    override = LOGO_OVERRIDES.get(slug)
    if override:
        return f"https://files.tips.gg/static/image/teams/{override}.png"
    return None


# ── Event status (mirrors parseEventStatus) ──────────────────────────────────
def parse_event_status(event_status: str, start_date: str) -> str:
    es = event_status or ""
    if "EventCancelled" in es or "EventPostponed" in es or "EventScheduled" in es or "EventRescheduled" in es:
        return "upcoming"
    if "EventCompleted" in es:
        return "finished"
    start = _parse_dt_ms(start_date)
    if start is not None:
        hours = (time.time() * 1000 - start) / 3_600_000
        if hours > 6:
            return "finished"
        if start < time.time() * 1000:
            return "live"
    return "upcoming"


# ── Match parsing (mirrors parseMatchesFromHtml) ─────────────────────────────
def parse_matches_from_html(html: str, game: str) -> list[dict]:
    logo_map = build_logo_map(html, game)
    matches: list[dict] = []

    for ld in extract_json_ld(html, game):
        try:
            competitors = ld.get("competitor") or []
            comp1, comp2 = competitors[0], competitors[1]
            if not (isinstance(comp1, dict) and isinstance(comp2, dict)):
                continue

            description = ld.get("description") or ""
            date_key = parse_iso_date(ld.get("startDate") or "")
            raw_url = ld.get("url") or ""
            score1, score2, html_status = extract_scores_from_html(html, raw_url)

            status = html_status if html_status != "upcoming" else parse_event_status(
                ld.get("eventStatus") or "", ld.get("startDate") or ""
            )

            match_type = parse_match_type(description)
            s1 = score1 if score1 is not None else 0
            s2 = score2 if score2 is not None else 0
            winner = max(s1, s2)
            is_score_decided = (
                (match_type == "BO3" and winner >= 2)
                or (match_type == "BO5" and winner >= 3)
                or (match_type == "BO2" and (s1 + s2) >= 2 and winner >= 2)
                or (match_type == "BO1" and (s1 + s2) >= 1 and abs(s1 - s2) >= 1)
            )
            has_scores = (s1 + s2) > 0

            if is_score_decided:
                status = "finished"
            elif has_scores and status == "upcoming":
                status = "live"
            elif not has_scores and status == "live":
                start = _parse_dt_ms(ld.get("startDate") or "")
                if start is not None and (time.time() * 1000 - start) > 3_600_000:
                    status = "upcoming"

            if status == "live":
                start = _parse_dt_ms(ld.get("startDate") or "")
                if start is not None:
                    hours_since_start = (time.time() * 1000 - start) / 3_600_000
                    is_cs2 = game == "cs2"
                    max_hours = (
                        1
                        if match_type == "BO1"
                        else (4.5 if is_cs2 else 5.5)
                        if match_type == "BO5"
                        else (3.25 if is_cs2 else 3.5)
                    )
                    if hours_since_start > max_hours and (not has_scores or is_score_decided):
                        status = "finished"

            final_status = status if status != "upcoming" else parse_event_status(
                ld.get("eventStatus") or "", ld.get("startDate") or ""
            )

            organizer = ld.get("organizer") or {}
            performer = ld.get("performer") or {}

            matches.append(
                {
                    "id": slug_from_url(raw_url),
                    "date": date_key,
                    "link": raw_url,
                    "type": match_type,
                    "score1": score1,
                    "score2": score2,
                    "nameTeam1": comp1.get("name") or "",
                    "nameTeam2": comp2.get("name") or "",
                    "logoTeam1": get_team_logo(comp1.get("name") or "", comp1.get("url") or "", logo_map),
                    "logoTeam2": get_team_logo(comp2.get("name") or "", comp2.get("url") or "", logo_map),
                    "tournament": organizer.get("name") if isinstance(organizer, dict) else "",
                    "stage": parse_stage(description),
                    "status": final_status,
                    "tipsCount": extract_tips_count(html, raw_url),
                    "performer": (performer.get("name") if isinstance(performer, dict) else None),
                    "startDate": ld.get("startDate") or "",
                    "pred1": None,
                    "pred2": None,
                    "coeff1": None,
                    "coeff2": None,
                    "positionTeam1": None,
                    "positionTeam2": None,
                    "tournamentLogo": tournament_logo_from_organizer_url(
                        (organizer or {}).get("url") if isinstance(organizer, dict) else None
                    ),
                }
            )
        except Exception as exc:  # noqa: BLE001 - skip malformed entries like TS does
            print(f"[scrapling] skipped malformed match: {exc}")

    return matches


# ── Coefficients cache (mirrors coefficientsCache.ts) ────────────────────────
def _read_coeff_cache() -> dict:
    try:
        return json.loads(COEFF_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_coeff_cache(data: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = COEFF_CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        if COEFF_CACHE_FILE.exists():
            COEFF_CACHE_FILE.unlink()
        tmp.rename(COEFF_CACHE_FILE)
    except Exception:
        pass


def get_cached_coeff(slug: str):
    entry = _read_coeff_cache().get(slug)
    if not entry:
        return None
    if time.time() * 1000 - entry.get("ts", 0) > COEFF_TTL_MS:
        return None
    return {"coeff1": entry["coeff1"], "coeff2": entry["coeff2"]}


def set_cached_coeff(slug: str, coeff1: float, coeff2: float) -> None:
    cache = _read_coeff_cache()
    cache[slug] = {"coeff1": coeff1, "coeff2": coeff2, "ts": int(time.time() * 1000)}
    now = time.time() * 1000
    for key in list(cache.keys()):
        if now - cache[key].get("ts", 0) > COEFF_TTL_MS * 2:
            del cache[key]
    _write_coeff_cache(cache)


# ── Odds extraction (mirrors fetchCoefficientsFromPredictions) ───────────────
def fetch_coefficients_from_predictions(link: str, retries: int = 1):
    slug = slug_from_url(link)
    cached = get_cached_coeff(slug)
    if cached:
        return cached

    pred_path = link if link.endswith("/") else link + "/"
    pred_url = TIPSGG_BASE + pred_path + "predictions/"

    for attempt in range(retries + 1):
        try:
            html = fetch_html_fast(pred_url)
            if not html:
                continue

            ba_idx = html.find('<div class="bookmakers-analysis-counters">')
            if ba_idx == -1:
                ba_idx = html.find('class="bookmakers-analysis-counters"')
            if ba_idx == -1:
                return None

            chunk = html[ba_idx: ba_idx + 3000]

            first_named = re.search(r'team-first[\s\S]*?avg-odd">([\d.]+)</span>', chunk, re.I)
            second_named = re.search(r'team-second[\s\S]*?avg-odd">([\d.]+)</span>', chunk, re.I)
            if first_named and second_named:
                res = {"coeff1": float(first_named.group(1)), "coeff2": float(second_named.group(1))}
                set_cached_coeff(slug, res["coeff1"], res["coeff2"])
                return res

            non_draw: list[float] = []
            for m in re.finditer(r'avg-odd">([\d.]+)</span>', chunk, re.I):
                snippet = chunk[max(0, m.start() - 100): m.start()]
                if not re.search(r"team-draw", snippet, re.I):
                    non_draw.append(float(m.group(1)))
                if len(non_draw) >= 2:
                    break

            if len(non_draw) >= 2:
                res = {"coeff1": non_draw[0], "coeff2": non_draw[1]}
                set_cached_coeff(slug, res["coeff1"], res["coeff2"])
                return res

            return None
        except Exception:
            if attempt == retries:
                return None
            time.sleep((attempt + 1) * 0.5)
    return None


def enrich_coefficients(matches: list[dict], max_matches: int = 25, pause_s: float = 2.0) -> None:
    today_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    to_fetch = [
        m
        for m in matches
        if m["status"] != "finished" and (m.get("startDate") or "").startswith(today_key)
    ][:max_matches]

    if not to_fetch:
        return

    success = 0
    for i, m in enumerate(to_fetch):
        try:
            res = fetch_coefficients_from_predictions(m["link"])
            if res:
                m["coeff1"] = res["coeff1"]
                m["coeff2"] = res["coeff2"]
                imp1 = 1 / res["coeff1"]
                imp2 = 1 / res["coeff2"]
                total = imp1 + imp2
                if total > 0:
                    m["pred1"] = round((imp1 / total) * 100)
                    m["pred2"] = round((imp2 / total) * 100)
                success += 1
        except Exception:
            pass
        if i + 1 < len(to_fetch):
            time.sleep(pause_s)

    print(f"[scrapling] coefficients: {success}/{len(to_fetch)} enriched (today only, cap {max_matches})")


# ── tips.gg scrape ───────────────────────────────────────────────────────────
def scrape_tipsgg(game: str, with_coeffs: bool, days: int, max_coeff: int, pause_s: float) -> list[dict]:
    game_path = GAME_PATHS[game]
    game_tag = GAME_TAGS[game]
    start = time.time()

    by_id: dict[str, dict] = {}
    day_counts: list[str] = []
    today = datetime.now()
    for i in range(-1, days - 1):  # yesterday + today + next (days-2) days
        d = today + timedelta(days=i)
        date_str = d.strftime("%d-%m-%Y")
        url = f"{TIPSGG_BASE}/{game_path}/matches/{date_str}/"
        html = fetch_html(url)
        if not html:
            day_counts.append(f"0 {date_str} (failed)")
            continue
        day_matches = parse_matches_from_html(html, game)
        day_counts.append(f"{len(day_matches)} {date_str}")
        for m in day_matches:
            by_id[m["id"]] = m

    matches = list(by_id.values())

    if with_coeffs:
        enrich_coefficients(matches, max_matches=max_coeff, pause_s=pause_s)

    with_coeffs_count = sum(1 for m in matches if m["coeff1"] is not None)
    print(
        f"[scrapling:{game_tag}] done: {len(matches)} matches "
        f"({', '.join(day_counts)}) | coeffs: {with_coeffs_count}/{len(matches)} | "
        f"{time.time() - start:.1f}s"
    )
    return matches


# ── HLTV ranking logos (mirrors scrapeHltvRankingLogos) ──────────────────────
def scrape_hltv_logos() -> dict[str, str]:
    url = "https://www.hltv.org/ranking/teams"
    html = fetch_html(url)
    if not html:
        print("[scrapling:hltv] could not fetch ranking page")
        return {}

    # Current HLTV DOM: each <div class="ranking-header"> has
    #   <span class="team-logo"><img alt="Team" src="https://img-cdn.hltv.org/teamlogo/..."></span>
    #   ... <span class="name">Team</span>
    sel = Selector(html)
    result: dict[str, str] = {}
    for el in sel.css(".ranking-header"):
        name_els = el.css(".name")
        img_els = el.css(".team-logo img")
        if not name_els or not img_els:
            continue
        name = (name_els[0].text or "").strip()
        if not name:
            continue
        src = (img_els[0].attrib.get("src") or "").split("?")[0]
        if not src:
            continue
        key = normalize_team_name(name)
        if key and key not in result:
            result[key] = src
        orig = name.lower().strip()
        if orig != key and orig not in result:
            result[orig] = src

    print(f"[scrapling:hltv] scraped {len(result)} team logos from HLTV ranking")
    return result


# ── Cache writers (format = backend createMatchesRouter.writeFileCacheInternal) ──
def _write_cache_file(filename: str, data) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "data": data,
        "ts": int(time.time() * 1000),
        "day": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "from": "fresh",
    }
    final = CACHE_DIR / filename
    tmp = CACHE_DIR / (filename + ".tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
    if final.exists():
        final.unlink()
    tmp.rename(final)
    print(f"[scrapling] wrote {final} ({len(data) if isinstance(data, list) else len(data)} entries)")


def write_matches_cache(game: str, matches: list[dict]) -> None:
    filename = "dota2_matches.json" if game == "dota2" else "cs2_matches.json"
    _write_cache_file(filename, matches)


def write_hltv_cache(logo_map: dict[str, str]) -> None:
    _write_cache_file("hltv_logos.json", logo_map)


# ── CLI ──────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="Scrapling scraper for MatchIQ")
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        choices=["all", "tipsgg", "dota2", "cs2", "hltv"],
        help="what to scrape (default: all; tipsgg = dota2 + cs2)",
    )
    parser.add_argument("--no-coeffs", action="store_true", help="skip odds/predictions enrichment")
    parser.add_argument("--days", type=int, default=8, help="how many days of matches to scrape (default: 8)")
    parser.add_argument("--max-coeff", type=int, default=25, help="cap on predictions pages fetched (default: 25)")
    parser.add_argument(
        "--coeff-pause",
        type=float,
        default=2.0,
        help="seconds between predictions-page requests (default: 2.0)",
    )
    args = parser.parse_args()

    with_coeffs = not args.no_coeffs

    if args.target in ("all", "tipsgg", "dota2"):
        print(f"[scrapling] scraping dota2 ({args.days} days)...")
        write_matches_cache("dota2", scrape_tipsgg("dota2", with_coeffs, args.days, args.max_coeff, args.coeff_pause))

    if args.target in ("all", "tipsgg", "cs2"):
        print(f"[scrapling] scraping cs2 ({args.days} days)...")
        write_matches_cache("cs2", scrape_tipsgg("cs2", with_coeffs, args.days, args.max_coeff, args.coeff_pause))

    if args.target in ("all", "hltv"):
        print("[scrapling] scraping HLTV ranking logos...")
        write_hltv_cache(scrape_hltv_logos())


if __name__ == "__main__":
    main()
