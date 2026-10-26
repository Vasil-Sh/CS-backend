/**
 * HLTV Ranking Logo Scraper — lightweight HTTP scraper for team logos.
 *
 * Scrapes hltv.org/ranking/teams → extracts team name → logo URL pairs.
 * HLTV CDN (img-cdn.hltv.org) is NOT behind Cloudflare — plain HTTP works.
 *
 * Run once at startup / periodically — generates a global logo lookup map.
 * Used by cstestClient.ts to fill in missing logos for teams without cstest CDN logos.
 */

import { getBrowser } from '../tipsggScraper';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HLTV_RANKING_URL = 'https://www.hltv.org/ranking/teams';

/** File cache written by the Scrapling Python script (scripts/scrapling/). */
const HLTV_LOGO_CACHE_FILE = join(process.cwd(), '.cache', 'hltv_logos.json');

/**
 * Read HLTV logo map from disk (written by the Scrapling Python script).
 * Returns null when the file is missing, stale (>24h), or malformed.
 */
function readHltvLogosFromDisk(): HltvLogoMap | null {
  try {
    if (!existsSync(HLTV_LOGO_CACHE_FILE)) return null;
    const raw = readFileSync(HLTV_LOGO_CACHE_FILE, 'utf-8');
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object' || typeof entry.data !== 'object') return null;
    const ts = typeof entry.ts === 'number' ? entry.ts : 0;
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return null;
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(entry.data)) {
      if (typeof v === 'string') map.set(k, v);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/** Map of normalized team name → logo CDN URL */
export type HltvLogoMap = Map<string, string>;

/**
 * Normalize team name to a comparable key.
 * "FaZe" → "faze", "Team Spirit" → "teamspirit", "Natus Vincere" → "natusvincere"
 */
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Scrape the HLTV ranking page and build team name → logo URL map.
 * Uses plain HTTP fetch + regex extraction — no Puppeteer needed.
 * HLTV serves team logos via img-cdn.hltv.org (not behind Cloudflare).
 */
export async function scrapeHltvRankingLogos(): Promise<HltvLogoMap> {
  // Fast path: use the cache written by the Scrapling Python script. It bypasses
  // the Cloudflare 403 that blocks our in-process HTTP fetch of the ranking page.
  const fromDisk = readHltvLogosFromDisk();
  if (fromDisk) {
    _globalHltvLogoMap = fromDisk;
    console.log(`[hltvRanking] Loaded ${fromDisk.size} team logos from Scrapling cache`);
    return fromDisk;
  }

  const map = new Map<string, string>();

  try {
    const resp = await fetch(HLTV_RANKING_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      console.warn(`[hltvRanking] HTTP ${resp.status} — cannot scrape ranking page`);
      return map;
    }

    const html = await resp.text();

    // Pattern: each ranking entry looks like:
    //   #1![Falcons](https://img-cdn.hltv.org/teamlogo/4eJSkDQINNM6Tbs4WvLzkN.png?...)
    //   ...
    //   Falcons(901 HLTV points)
    //
    // Strategy: find all teamlogo URLs, then match them with team names nearby.
    // HLTV format: numbered entries separated by newlines.

    // Extract all logo URLs with their surrounding context
    const logoRegex = /https:\/\/img-cdn\.hltv\.org\/teamlogo\/[a-zA-Z0-9_-]+\.(png|svg)[^)\s]*/gi;
    const urls: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = logoRegex.exec(html)) !== null) {
      // Take URL without query string parameters
      const cleanUrl = match[0].split('?')[0];
      if (!urls.includes(cleanUrl)) urls.push(cleanUrl);
    }

    // Extract team names: they appear as "TeamName(### HLTV points)" after the logo
    const teamRegex = /([A-Za-z0-9 ._-]{2,40})\(\d+ HLTV points\)/g;
    const teams: string[] = [];
    while ((match = teamRegex.exec(html)) !== null) {
      const name = match[1].trim();
      if (name && !teams.includes(name)) teams.push(name);
    }

    // Match: HLTV lists teams in order — logo URL #N corresponds to team #N
    const count = Math.min(urls.length, teams.length);
    for (let i = 0; i < count; i++) {
      const key = normalizeTeamName(teams[i]);
      if (key && !map.has(key)) {
        map.set(key, urls[i]);
      }
      // Also store the un-normalized name for exact lookups
      const originalKey = teams[i].toLowerCase().trim();
      if (originalKey !== key && !map.has(originalKey)) {
        map.set(originalKey, urls[i]);
      }
    }

    console.log(`[hltvRanking] Scraped ${map.size / 2} team logos from HLTV ranking`);
    _globalHltvLogoMap = map;
  } catch (err) {
    console.warn('[hltvRanking] Scrape failed:', (err as Error).message);
  }

  return map;
}

/** Global cache — populated once, survives server lifetime */
let _globalHltvLogoMap: HltvLogoMap | null = null;

/** Expose the in-memory cache for synchronous lookups. */
export function getHltvLogoCache(): HltvLogoMap | null {
  return _globalHltvLogoMap;
}

/**
 * Get (or scrape) the global HLTV logo map.
 * Thread-safe: only one concurrent scrape.
 */
let _scrapePromise: Promise<HltvLogoMap> | null = null;

export async function getHltvLogoMap(): Promise<HltvLogoMap> {
  if (_globalHltvLogoMap) return _globalHltvLogoMap;
  if (_scrapePromise) return _scrapePromise;

  _scrapePromise = scrapeHltvRankingLogos().then(map => {
    _globalHltvLogoMap = map;
    _scrapePromise = null;
    return map;
  }).catch(() => {
    _scrapePromise = null;
    return new Map<string, string>();
  });

  return _scrapePromise;
}

/**
 * Look up a single team logo from the HLTV ranking.
 * Returns the CDN URL or null if not found.
 */
export async function lookupHltvLogo(teamName: string): Promise<string | null> {
  const map = await getHltvLogoMap();

  // Try exact match first
  const key = teamName.toLowerCase().trim();
  if (map.has(key)) return map.get(key)!;

  // Try normalized match
  const norm = normalizeTeamName(teamName);
  if (map.has(norm)) return map.get(norm)!;

  return null;
}
