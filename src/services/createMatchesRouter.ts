/**
 * Matches Router Factory — creates a Hono router for Dota2 or CS2 matches.
 *
 * Shares cache, rate limiting, SWR, and logo proxy logic between both games.
 * Mirrors the previous dota2Matches.ts / cs2Matches.ts architecture.
 */

import { Hono } from 'hono';
import { fetchMatchDetail, getBrowser, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure } from '../services/circuitBreaker';
import type { LiveScoresStore } from '../services/liveScoresStore';

interface MatchRouterConfig {
  game: 'dota2' | 'cs2';
  fetchFn: () => Promise<TipsGgMatch[]>;
  liveScoresStore: LiveScoresStore;
  cacheFile: string;
  circuitBreakerName: string;
  healthUrl?: string;
}

const CACHE_TTL_FRESH = 5 * 60 * 1000;   // 5 min — normal TTL
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 1 hour — serve stale only if fresh fetch fails
const CACHE_DIR = join(process.cwd(), '.cache');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

interface CacheEntry<T> {
  data: T;
  ts: number;
  day: string;
  from: 'fresh' | 'stale';
}

function readFileCache<T>(maxAge: number, key: string): { data: T; stale: boolean } | null {
  try {
    if (!existsSync(key)) return null;
    const raw = readFileSync(key, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    if (entry.day && entry.day !== today) return null;
    const age = Date.now() - entry.ts;
    if (age < maxAge) return { data: entry.data, stale: false };
    return { data: entry.data, stale: true };
  } catch { return null; }
}

function writeFileCacheInternal(data: unknown, key: string): void {
  try {
    ensureCacheDir();
    const today = new Date().toISOString().split('T')[0];
    const entry: CacheEntry<unknown> = { data, ts: Date.now(), day: today, from: 'fresh' };
    const tmp = key + '.tmp';
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    try { if (existsSync(key)) unlinkSync(key); } catch {}
    renameSync(tmp, key);
  } catch { /* ignore */ }
}

// ── Rate limiter ──
const RATE_LIMIT_WINDOW = 30000;
const RATE_LIMIT_MAX = 5;
const RATE_CLEANUP_INTERVAL = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, RATE_CLEANUP_INTERVAL).unref();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

function rateLimitKey(c: any, prefix: string): string {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '127.0.0.1';
  return `${ip}::${prefix}`;
}

// ── Stale-while-revalidate helper ──
const refreshStates = new Map<string, {
  promise: Promise<TipsGgMatch[] | null> | null;
  lock: boolean;
}>();

function getRefreshState(name: string) {
  if (!refreshStates.has(name)) {
    refreshStates.set(name, { promise: null, lock: false });
  }
  return refreshStates.get(name)!;
}

// Image headers — permissive for <img> tag compatibility
const imgHeaders = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': '',
  'X-Content-Type-Options': '',
};

/**
 * Create a Hono router for match listing, live scores, logos, and detail.
 */
export function createMatchesRouter(cfg: MatchRouterConfig): Hono {
  const router = new Hono();
  const { game, fetchFn, liveScoresStore: scoresStore, cacheFile, circuitBreakerName, healthUrl } = cfg;
  const prefix = game === 'dota2' ? 'dota2' : 'cs2';
  const gameLabel = game === 'dota2' ? 'Dota 2' : 'CS2';
  const imgCachePrefix = game === 'dota2' ? 'logo_' : 'logo_cs2_';

  async function getMatchesWithSWR(): Promise<{ data: TipsGgMatch[]; fromCache: boolean }> {
    const memResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_FRESH, cacheFile);
    if (memResult && !memResult.stale) {
      return { data: memResult.data, fromCache: true };
    }

    const state = getRefreshState(cacheFile);
    if (!state.lock) {
      state.lock = true;
      state.promise = fetchFn()
        .then(matches => {
          if (matches.length > 0) {
            writeFileCacheInternal(matches, cacheFile);
          } else {
            console.warn(`[${prefix}Matches] Empty scrape — keeping existing cache`);
          }
          return matches;
        })
        .catch(err => {
          console.error(`[${prefix}Matches] Refresh failed:`, (err as Error).message);
          recordFailure(circuitBreakerName);
          return null;
        })
        .finally(() => {
          state.promise = null;
          state.lock = false;
        });
    }

    if (memResult) {
      return { data: memResult.data, fromCache: true };
    }

    if (!memResult) {
      console.log(`[${prefix}Matches] Cold start — serving empty, refresh runs in background`);
      return { data: [], fromCache: false };
    }

    throw new Error('No cached data available and refresh failed');
  }

  // ── GET / — list matches ──
  router.get('/', async (c) => {
    if (!checkRateLimit(rateLimitKey(c, prefix))) {
      return c.json({ error: 'Too many requests, please retry later' }, 429);
    }

    const forceRefresh = c.req.query('refresh') === 'true';
    if (forceRefresh) {
      if (!checkRateLimit(rateLimitKey(c, prefix + '::refresh'))) {
        return c.json({ error: 'Too many refresh requests, please wait 60s' }, 429);
      }
    }

    try {
      const { data, fromCache } = await getMatchesWithSWR();
      c.header('X-Cache', fromCache ? 'HIT' : 'MISS');
      c.header('Cache-Control', `public, max-age=${CACHE_TTL_FRESH / 1000}`);
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${prefix}Matches] Scrape failed:`, message);
      return c.json({ error: `Failed to fetch ${gameLabel} matches`, detail: message }, 502);
    }
  });

  // ── GET /live-scores — in-memory, <1ms ──
  router.get('/live-scores', (c) => {
    return c.json(scoresStore.getScores());
  });

  // ── GET /logo/:filename — proxy team logos via Puppeteer ──
  router.get('/logo/:filename', async (c) => {
    const logoPath = c.req.param('filename');
    if (!logoPath) return c.json({ error: 'Missing path' }, 400);

    const logoUrl = `https://files.tips.gg/static/image/teams/${logoPath}`;
    const cacheFile = join(CACHE_DIR, `${imgCachePrefix}${logoPath.replaceAll('/', '_')}`);

    const cached = readFileCache<{ data: number[] }>(86400_000, cacheFile);
    if (cached && !cached.stale) {
      return new Response(Uint8Array.from(cached.data.data), { headers: imgHeaders });
    }

    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

      const base64DataUrl = await page.evaluate(async (url: string): Promise<string | null> => {
        try {
          const res = await fetch(url, { headers: { 'Referer': 'https://tips.gg/' } });
          if (!res.ok) return null;
          const blob = await res.blob();
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return 'data:image/png;base64,' + btoa(binary);
        } catch { return null; }
      }, logoUrl);

      await page.close().catch(() => {});

      if (!base64DataUrl) throw new Error('Puppeteer fetch returned null');

      const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      writeFileCacheInternal({ type: 'buffer', data: Array.from(new Uint8Array(buffer)) }, cacheFile);

      return new Response(buffer, { headers: imgHeaders });
    } catch {
      if (cached) {
        return new Response(Uint8Array.from(cached.data.data), {
          headers: { ...imgHeaders, 'Cache-Control': 'public, max-age=3600' },
        });
      }
      return c.json({ error: 'Failed to fetch logo' }, 502);
    }
  });

  // ── GET /health — validate HTML structure ──
  if (healthUrl) {
    router.get('/health', async (c) => {
      const checks: Record<string, boolean | string> = {};
      let ok = true;

      try {
        const res = await fetch(healthUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(15000),
        });
        const stdout = await res.text();

        checks['html_response'] = stdout.length > 5000;
        checks['json_ld'] = stdout.includes('application/ld+json');
        checks['json_ld_count'] = String((stdout.match(/application\/ld\+json/gi) || []).length);
        checks['score_elements'] = stdout.includes('class="score');
        checks['bookmaker_section'] = stdout.includes('bookmakers-analysis-counters');
        checks['match_listing'] = stdout.includes('class="element match');

        if (!checks['json_ld'] || !checks['match_listing']) ok = false;
      } catch (e) {
        checks['error'] = e instanceof Error ? e.message : 'Unknown';
        ok = false;
      }

      return c.json({ ok, checks });
    });
  }

  // ── GET /:date/:slug/:time — single match detail (Dota2 only) ──
  if (game === 'dota2') {
    router.get('/:date/:slug/:time', async (c) => {
      const { date, slug, time } = c.req.param();
      const matchUrl = `/matches/dota2/${date}/${slug}/${time}/`;

      const detailCacheFile = join(CACHE_DIR, `detail_${date}_${slug}.json`);
      const cached = readFileCache<TipsGgMatch>(CACHE_TTL_FRESH, detailCacheFile);
      if (cached && !cached.stale) return c.json(cached.data);

      try {
        const match = await fetchMatchDetail(matchUrl, 'dota2');
        if (!match) return c.json({ error: 'Match not found' }, 404);
        writeFileCacheInternal(match, detailCacheFile);
        return c.json(match);
      } catch (err) {
        if (cached) return c.json(cached.data);
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[${prefix}Matches] Detail scrape failed:`, message);
        return c.json({ error: 'Failed to fetch match detail', detail: message }, 502);
      }
    });
  }

  return router;
}
