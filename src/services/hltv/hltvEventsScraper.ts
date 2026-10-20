/**
 * HLTV Event Logo Scraper — event/tournament operator logos.
 *
 * Scrapes hltv.org/events → extracts event name → logo pairs, then DOWNLOADS
 * each logo to a local directory (like team logos), so the frontend never has
 * to hit the Cloudflare-protected img-cdn.hltv.org CDN directly.
 *
 * The /events page and its event logos load fine in a real browser context,
 * but img-cdn.hltv.org rejects plain HTTP + fresh-page fetches. By downloading
 * at scrape time (inside the authenticated page) and serving from disk, we
 * sidestep Cloudflare entirely.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBrowser } from '../tipsggScraper';

const HLTV_EVENTS_URL = 'https://www.hltv.org/events';
const PUPPETEER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Local directory where tournament logos are cached. */
const TOURNAMENT_LOGO_DIR = join(process.cwd(), '.cache', 'logos', 'tournaments');

/** Public serving path prefix (CS2 matches router). */
export const TOURNAMENT_LOGO_PATH_PREFIX = '/api/v1/cs2-matches/logo/tournament/';

/** Map of normalized event name → local filename on disk. */
export type HltvEventLogoMap = Map<string, string>;

/**
 * Normalize an event name into a sorted token array for fuzzy matching.
 * "CCT Europe 2026 Series #12" → ["12","2026","cct","europe","series"]
 */
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // strip #, -, ., etc.
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort();
}

/** Numeric tokens only — used to reject mismatched season/series numbers. */
function numericTokens(tokens: string[]): string[] {
  return tokens.filter((t) => /^\d+$/.test(t));
}

/**
 * Scrape the HLTV events page, download each event logo to local disk, and
 * build an event name → local filename map.
 */
export async function scrapeHltvEventLogos(): Promise<HltvEventLogoMap> {
  const map = new Map<string, string>();

  try {
    mkdirSync(TOURNAMENT_LOGO_DIR, { recursive: true });

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(PUPPETEER_UA);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(HLTV_EVENTS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      // Allow lazy images to settle (also lets Cloudflare pass the logo imgs)
      await new Promise((r) => setTimeout(r, 1200));

      // Extract name → signed src URL pairs from the DOM (signed imgix URLs
      // are required — the unsigned base URL is rejected by Cloudflare).
      const pairs = await page.evaluate(() => {
        const out: Array<{ name: string; url: string }> = [];
        const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
          (i.src || '').includes('eventlogo'),
        );
        for (const img of imgs) {
          const name = (img.alt || '').trim();
          const url = img.src;
          if (name && url) out.push({ name, url });
        }
        return out;
      });

      // Unique signed URL → local filename
      const urlToFile = new Map<string, string>();
      for (const { url } of pairs) {
        if (urlToFile.has(url)) continue;
        const base = url.split('?')[0];
        const filename = base.split('/').pop() || 'unknown.png';
        const safe = /\.(png|svg)$/i.test(filename) ? filename : `${filename}.png`;
        urlToFile.set(url, safe);
      }

      // Download each unique logo (fetch within the authenticated page context)
      const downloads = await page.evaluate(async (list: string[]): Promise<Record<string, string | null>> => {
        const out: Record<string, string | null> = {};
        for (const u of list) {
          try {
            const r = await fetch(u);
            if (!r.ok) { out[u] = null; continue; }
            const blob = await r.blob();
            const arr = new Uint8Array(await blob.arrayBuffer());
            let bin = '';
            for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
            out[u] = btoa(bin);
          } catch {
            out[u] = null;
          }
        }
        return out;
      }, [...urlToFile.keys()]);

      let downloaded = 0;
      for (const [url, filename] of urlToFile) {
        const b64 = downloads[url];
        if (!b64) continue;
        const target = join(TOURNAMENT_LOGO_DIR, filename);
        if (existsSync(target) && Date.now() - statSync(target).mtimeMs < 86400_000) {
          continue;
        }
        writeFileSync(target, Buffer.from(b64, 'base64'));
        downloaded++;
      }

      // Build name → filename map (first occurrence wins — the featured/main card)
      for (const { name, url } of pairs) {
        const filename = urlToFile.get(url);
        if (!filename) continue;
        const tokens = tokenize(name);
        if (tokens.length === 0) continue;
        const key = tokens.join(' ');
        if (!map.has(key)) map.set(key, filename);
      }

      console.log(`[hltvEvents] Scraped ${map.size} event logos, downloaded ${downloaded} new`);
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.warn('[hltvEvents] Scrape failed:', (err as Error).message);
  }

  return map;
}

// ── Global cache (survives server lifetime) ──

let _globalHltvEventLogoMap: HltvEventLogoMap | null = null;
let _scrapePromise: Promise<HltvEventLogoMap> | null = null;

/** Get (or scrape) the global HLTV event logo map. Thread-safe. */
export async function getHltvEventLogoMap(): Promise<HltvEventLogoMap> {
  if (_globalHltvEventLogoMap) return _globalHltvEventLogoMap;
  if (_scrapePromise) return _scrapePromise;

  _scrapePromise = scrapeHltvEventLogos()
    .then((map) => {
      _globalHltvEventLogoMap = map;
      _scrapePromise = null;
      return map;
    })
    .catch(() => {
      _scrapePromise = null;
      return new Map<string, string>();
    });

  return _scrapePromise;
}

/**
 * Look up the local filename of an HLTV event logo for a tournament name
 * using fuzzy token matching. Returns the filename or null.
 *
 * Matching rules:
 *  - exact token-set match → always accepted;
 *  - otherwise Jaccard similarity ≥ 0.6 AND numeric tokens (season/series/year)
 *    must match exactly (prevents "Series 11" ↔ "Series 12" collisions).
 */
export async function lookupHltvEventLogo(
  tournamentName: string | null | undefined,
): Promise<string | null> {
  if (!tournamentName) return null;

  const map = await getHltvEventLogoMap();
  if (map.size === 0) return null;

  const target = tokenize(tournamentName);
  if (target.length === 0) return null;
  const targetNums = numericTokens(target);

  let best: { filename: string; score: number } | null = null;

  for (const [key, filename] of map) {
    const tokens = key.split(' ');
    const a = new Set(target);
    const b = new Set(tokens);

    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    const jaccard = union > 0 ? inter / union : 0;

    // Exact match
    if (jaccard === 1) return filename;

    // Numeric tokens must agree exactly
    const bNums = numericTokens(tokens);
    if (targetNums.join(',') !== bNums.join(',')) continue;

    if (jaccard >= 0.6 && (!best || jaccard > best.score)) {
      best = { filename, score: jaccard };
    }
  }

  return best ? best.filename : null;
}

/**
 * Enrich a list of CS2 matches with locally-served HLTV event logos.
 * Overrides m.tournamentLogo with a local serving path when a confident
 * HLTV match is found (fuzzy name matching). Returns the enriched count.
 */
export async function enrichTournamentLogos(
  matches: Array<{ tournament: string; tournamentLogo: string | null }>,
): Promise<number> {
  let enriched = 0;
  try {
    for (const m of matches) {
      if (!m.tournament) continue;
      const filename = await lookupHltvEventLogo(m.tournament);
      if (filename) {
        m.tournamentLogo = TOURNAMENT_LOGO_PATH_PREFIX + filename;
        enriched++;
      }
    }
  } catch (err) {
    console.warn('[hltvEvents] Enrichment failed:', (err as Error).message);
  }
  return enriched;
}

/** Read a downloaded tournament logo from disk (for the serving endpoint). */
export function readTournamentLogo(filename: string): Buffer | null {
  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  const filePath = join(TOURNAMENT_LOGO_DIR, filename);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}
