/**
 * HLTV Match Scraper — Puppeteer-based scraper for hltv.org.
 *
 * Uses JS scripts adapted from petrynyak/SC's WebView2 approach.
 * Key difference: WebView2's ExecuteScriptAsync = Puppeteer's page.evaluate().
 *
 * Flow:
 * 1. Navigate to hltv.org/matches
 * 2. Inject MatchesParser.js → get list of upcoming/live matches
 * 3. For live/interesting matches, navigate to match page
 * 4. Inject GameParser.js → get scores, status, format
 * 5. Convert to unified TipsGgMatch format for frontend compatibility
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer';
import { isOpen, recordSuccess, recordFailure } from '../circuitBreaker';
import type {
  HltvMatch,
  HltvGameDetail,
  HltvUnifiedMatch,
  HltvRankedTeam,
  HltvTeamMapStat,
  HltvGameDetailsFull,
} from './hltvTypes';

// ── Constants ──

const HLTV_BASE = 'https://www.hltv.org';
const CIRCUIT_NAME = 'hltv_scraper';
const PUPPETEER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Browser reference (shared via tipsggScraper's getBrowser) ──

let _getBrowser: (() => Promise<import('puppeteer').Browser>) | null = null;

export function setBrowserFactory(fn: () => Promise<import('puppeteer').Browser>): void {
  _getBrowser = fn;
}

// ── JS Script Loader ──

const JS_DIR = path.join(process.cwd(), 'src', 'services', 'hltv', 'js');

/** Read and cache JS files (loaded once at startup). */
const _jsCache = new Map<string, string>();
function loadJs(filename: string): string {
  if (!_jsCache.has(filename)) {
    _jsCache.set(filename, fs.readFileSync(path.join(JS_DIR, filename), 'utf-8'));
  }
  return _jsCache.get(filename)!;
}

// ── Page helpers ──

async function newPage(browser: import('puppeteer').Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(PUPPETEER_UA);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  return page;
}

async function navigateAndWait(page: Page, url: string, waitMs = 5000): Promise<string> {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // Extra wait for HLTV's Vue.js to hydrate dynamic content
  await new Promise(r => setTimeout(r, waitMs));
  const html = await page.content();
  if (html.length < 2000) {
    throw new Error(`Empty/too-short response (${html.length} bytes) from ${url}`);
  }
  return html;
}

// ── Match Listing Parser ──

/**
 * Navigate to hltv.org/matches and extract all matches.
 * Returns raw HLTV match data (not yet enriched with scores).
 */
async function fetchMatchListing(page: Page): Promise<HltvMatch[]> {
  await navigateAndWait(page, `${HLTV_BASE}/matches`, 3000);

  const script = loadJs('MatchesParser.js');
  // MatchesParser.js is already an IIFE — evaluate directly (no extra wrapping)
  const raw = await page.evaluate(script);

  // page.evaluate returns JSON-serialized; Puppeteer auto-deserializes
  if (!Array.isArray(raw)) {
    console.warn('[hltv] MatchesParser returned non-array:', typeof raw);
    return [];
  }

  return raw as HltvMatch[];
}

// ── Game Detail Parser ──

/**
 * Navigate to a specific match page and extract game details.
 * Reuses an existing page (caller manages lifecycle).
 */
async function fetchGameDetail(
  page: Page,
  matchUrl: string,
): Promise<HltvGameDetail | null> {
  const fullUrl = matchUrl.startsWith('http') ? matchUrl : `${HLTV_BASE}${matchUrl}`;

  await navigateAndWait(page, fullUrl, 3000);

  const script = loadJs('GameParser.js');

  try {
    const raw = await page.evaluate(script);
    if (!raw || typeof raw !== 'object') return null;
    return raw as HltvGameDetail;
  } catch {
    return null;
  }
}

/**
 * Fetch game detail with its own page lifecycle (creates/closes a page).
 * Use this from routes that don't manage pages themselves.
 */
/**
 * Fetch match score with its own stealth browser (bypasses HLTV Cloudflare).
 * Uses local puppeteer-extra + stealth plugin even when BROWSERLESS is configured.
 */
export async function fetchMatchScore(
  matchUrl: string,
): Promise<{ score1: number; score2: number; type: string } | null> {
  // Dynamic imports so this module doesn't force puppeteer-extra dependency on startup
  const puppeteerExtra = (await import('puppeteer-extra')).default;
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  puppeteerExtra.use(StealthPlugin());

  const browser = await puppeteerExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(PUPPETEER_UA);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const fullUrl = matchUrl.startsWith('http') ? matchUrl : `${HLTV_BASE}${matchUrl}`;

    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    // Wait for HLTV Vue.js hydration
    await new Promise(r => setTimeout(r, 4000));

    const script = loadJs('GameParser.js');
    const raw = await page.evaluate(script);
    const detail = raw && typeof raw === 'object' ? raw as HltvGameDetail : null;

    if (!detail) {
      console.warn(`[hltv:score] Parser returned null for ${fullUrl}`);
      return null;
    }

    const hasPositiveScore = detail.score1 > 0 || detail.score2 > 0;
    if (!hasPositiveScore) {
      console.warn(`[hltv:score] No scores for ${fullUrl}: ${detail.score1}-${detail.score2}`);
      return null;
    }

    console.log(`[hltv:score] ${detail.nameTeam1} ${detail.score1}-${detail.score2} ${detail.nameTeam2}`);
    return { score1: detail.score1, score2: detail.score2, type: detail.type };
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Unified Match Converter ──

/**
 * Simple string hash for stable IDs, same as tipsggScraper.
 */
function stringHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Convert HLTV match to unified format compatible with our frontend.
 */
function hltvToUnified(m: HltvMatch, detail?: HltvGameDetail | null): HltvUnifiedMatch {
  // Determine status
  let status: 'upcoming' | 'live' | 'finished' = 'upcoming';
  if (detail?.isMatchOver) {
    status = 'finished';
  } else if (m.isLive || detail?.isLive) {
    status = 'live';
  } else if (m.unixTime && m.unixTime < Date.now()) {
    // Match time passed but not marked live — treat as potential finished
    // (HLTV sometimes lags on updating the listing page status)
    status = 'finished';
  }

  // Date: use unixTime in ms from HLTV
  const dateFromUnix = m.unixTime
    ? new Date(m.unixTime).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Scores from detail page if available
  const score1 = detail?.score1 ?? null;
  const score2 = detail?.score2 ?? null;

  // Odds from HLTV listing (csgoempire odds if present)
  const coeff1 = m.odds1 ?? null;
  const coeff2 = m.odds2 ?? null;

  // Derived predictions from odds
  let pred1 = 50, pred2 = 50;
  if (coeff1 && coeff2 && coeff1 > 0 && coeff2 > 0) {
    const imp1 = 1 / coeff1;
    const imp2 = 1 / coeff2;
    const total = imp1 + imp2;
    if (total > 0) {
      pred1 = Math.round((imp1 / total) * 100);
      pred2 = Math.round((imp2 / total) * 100);
    }
  }

  const name1 = m.team1 || detail?.nameTeam1 || 'TBD';
  const name2 = m.team2 || detail?.nameTeam2 || 'TBD';
  const tournament = detail?.event || m.eventName || '';
  const matchType = (detail?.type || m.type || 'BO3').toUpperCase();

  const link = m.url || '';

  return {
    id: String(stringHash(link || `${name1}-${name2}-${dateFromUnix}`)),
    date: dateFromUnix,
    link: link.startsWith('http') ? link : `${HLTV_BASE}${link}`,
    type: matchType,
    score1,
    score2,
    nameTeam1: name1,
    nameTeam2: name2,
    logoTeam1: null, // populated separately via logo scraper
    logoTeam2: null,
    tournament,
    stage: '',
    status,
    tipsCount: 0,
    performer: null,
    startDate: m.unixTime ? new Date(m.unixTime).toISOString() : '',
    pred1,
    pred2,
    coeff1,
    coeff2,
    source: 'hltv',
  };
}

// ── Main Scraper ──

/**
 * Fetch all upcoming/live matches from HLTV, enriching live/finished matches
 * with scores from their detail pages.
 */
export async function fetchHltvMatches(): Promise<HltvUnifiedMatch[]> {
  if (isOpen(CIRCUIT_NAME)) {
    throw new Error(`Circuit breaker open for ${CIRCUIT_NAME}`);
  }

  const startTime = Date.now();

  if (!_getBrowser) {
    throw new Error('HLTV scraper: browser factory not set. Call setBrowserFactory() first.');
  }

  const browser = await _getBrowser();
  const page = await newPage(browser);

  try {
    // Step 1: Get match listing
    const listing = await fetchMatchListing(page);
    console.log(`[hltv] Listing: ${listing.length} matches`);

    // Step 2: Enrich live/finished matches with scores
    const toEnrich = listing.filter(
      m => m.isLive || (m.unixTime && m.unixTime < Date.now() - 3600000),
    );

    const details = new Map<string, HltvGameDetail | null>();
    const DETAIL_CONCURRENCY = 3;
    for (let i = 0; i < toEnrich.length; i += DETAIL_CONCURRENCY) {
      const batch = toEnrich.slice(i, i + DETAIL_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          if (!m.url) return;
          const detail = await fetchGameDetail(page, m.url);
          details.set(m.url, detail);
        }),
      );
      // Delay between batches
      if (i + DETAIL_CONCURRENCY < toEnrich.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Step 3: Convert to unified format
    const matches: HltvUnifiedMatch[] = listing.map(m => {
      const detail = m.url ? details.get(m.url) : undefined;
      return hltvToUnified(m, detail);
    });

    const totalTime = Date.now();
    const liveCount = matches.filter(m => m.status === 'live').length;
    const finishedCount = matches.filter(m => m.status === 'finished').length;
    const enrichedCount = matches.filter(m => m.score1 != null).length;

    console.log(
      `[hltv] Done: ${matches.length} matches ` +
      `(${liveCount} live, ${finishedCount} finished, ${enrichedCount} with scores) | ` +
      `${totalTime - startTime}ms`,
    );

    recordSuccess(CIRCUIT_NAME);
    return matches;
  } catch (err) {
    recordFailure(CIRCUIT_NAME);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Team Ranking Parser ──

/**
 * Fetch HLTV world ranking (top 30 teams).
 * Navigates to hltv.org/ranking/teams and runs TeamBasicParser.js.
 */
export async function fetchHltvRanking(): Promise<HltvRankedTeam[]> {
  if (!_getBrowser) {
    throw new Error('HLTV scraper: browser factory not set.');
  }

  const browser = await _getBrowser();
  const page = await newPage(browser);

  try {
    await navigateAndWait(page, `${HLTV_BASE}/ranking/teams`, 3000);

    const script = loadJs('TeamBasicParser.js');
    const raw = await page.evaluate(script);

    if (!Array.isArray(raw)) {
      console.warn('[hltv:ranking] Unexpected output:', typeof raw);
      return [];
    }

    console.log(`[hltv:ranking] Fetched ${raw.length} teams`);
    return raw as HltvRankedTeam[];
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Team Maps Parser ──

/**
 * Fetch map statistics for a specific HLTV team.
 * Navigates to hltv.org/stats/teams/maps/{teamId}/{teamName} and runs MapsParser.js.
 */
export async function fetchHltvTeamMaps(
  teamId: number,
  teamName: string,
): Promise<HltvTeamMapStat[]> {
  if (!_getBrowser) {
    throw new Error('HLTV scraper: browser factory not set.');
  }

  const browser = await _getBrowser();
  const page = await newPage(browser);

  try {
    const url = `${HLTV_BASE}/stats/teams/maps/${teamId}/${encodeURIComponent(teamName.toLowerCase().replace(/\s+/g, '-'))}`;
    await navigateAndWait(page, url, 3000);

    const script = loadJs('MapsParser.js');
    const raw = await page.evaluate(script);

    if (!Array.isArray(raw)) {
      console.warn('[hltv:maps] Unexpected output:', typeof raw);
      return [];
    }

    return raw as HltvTeamMapStat[];
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Game Details Parser ──

/**
 * Fetch full game details: per-map scores, coefficients, betting link, logos.
 * Navigates to a specific match page and runs GameDetailsParser.js.
 */
export async function fetchHltvGameDetails(
  matchUrl: string,
): Promise<HltvGameDetailsFull | null> {
  if (!_getBrowser) {
    throw new Error('HLTV scraper: browser factory not set.');
  }

  const browser = await _getBrowser();
  const page = await newPage(browser);

  try {
    const fullUrl = matchUrl.startsWith('http') ? matchUrl : `${HLTV_BASE}${matchUrl}`;
    await navigateAndWait(page, fullUrl, 5000); // 5s — match pages have more JS to load

    const script = loadJs('GameDetailsParser.js');
    // Note: GameDetailsParser uses synchronous XHR for logo base64 — works in Puppeteer
    const raw = await page.evaluate(script);

    if (!raw || typeof raw !== 'object') {
      console.warn('[hltv:details] Unexpected output:', typeof raw);
      return null;
    }

    return raw as HltvGameDetailsFull;
  } catch (err) {
    console.warn('[hltv:details] Failed:', (err as Error).message);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
