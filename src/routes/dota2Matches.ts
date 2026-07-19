/**
 * Dota 2 Matches API — wraps tips.gg scraper with caching, rate limiting,
 * stale-while-revalidate, graceful degradation.
 */

import { Hono } from 'hono';
import { fetchDota2Matches, fetchDota2MatchDetail, fetchHtml, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure } from '../services/circuitBreaker';

const dota2Matches = new Hono();

// ── Cache config ──
const CACHE_TTL_FRESH = 5 * 60 * 1000;   // 5 min — normal TTL
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 1 hour — serve stale only if fresh fetch fails
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'dota2_matches.json');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

interface CacheEntry<T> {
  data: T;
  ts: number;
  from: 'fresh' | 'stale';
}

function readFileCache<T>(maxAge: number, key = CACHE_FILE): { data: T; stale: boolean } | null {
  try {
    if (!existsSync(key)) return null;
    const raw = readFileSync(key, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(raw);
    const age = Date.now() - entry.ts;
    if (age < maxAge) return { data: entry.data, stale: false };
    // Return as stale (graceful degradation)
    return { data: entry.data, stale: true };
  } catch { return null; }
}

function writeFileCacheInternal(data: unknown, key = CACHE_FILE): void {
  try {
    ensureCacheDir();
    const entry: CacheEntry<unknown> = { data, ts: Date.now(), from: 'fresh' };
    // Atomic write: write to temp file, then rename (atomic on most filesystems)
    const tmp = key + '.tmp';
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    // On Windows, rename fails if target exists — remove first
    try { if (existsSync(key)) unlinkSync(key); } catch {}
    renameSync(tmp, key);
  } catch { /* ignore */ }
}

// ── Rate limiter ──
const RATE_LIMIT_WINDOW = 30000; // 30s
const RATE_LIMIT_MAX = 5;        // max 5 requests per window
const RATE_CLEANUP_INTERVAL = 60_000; // clean expired buckets every 60s
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup of expired rate-limit buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, RATE_CLEANUP_INTERVAL).unref(); // unref so it doesn't keep the process alive

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

// Compound key: IP + route
function rateLimitKey(c: any): string {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '127.0.0.1';
  return `${ip}::dota2-matches`;
}

// ── Stale-while-revalidate helper ──
let refreshPromise: Promise<TipsGgMatch[] | null> | null = null;
let refreshLock = false; // prevent concurrent scrape starts

async function getMatchesWithSWR(): Promise<{ data: TipsGgMatch[]; fromCache: boolean }> {
  // 1. Try in-memory fresh cache
  const memResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_FRESH, CACHE_FILE);
  if (memResult && !memResult.stale) {
    return { data: memResult.data, fromCache: true };
  }

  // 2. Deduplicated refresh: only one concurrent scrape
  if (!refreshLock) {
    refreshLock = true;
    refreshPromise = fetchDota2Matches()
      .then(matches => {
        if (matches.length > 0) {
          writeFileCacheInternal(matches);
        } else {
          console.warn('[dota2Matches] Empty scrape — keeping existing cache');
        }
        return matches;
      })
      .catch(err => {
        console.error('[dota2Matches] Refresh failed:', (err as Error).message);
        recordFailure('tipsgg_fetchDota2Matches');
        return null;
      })
      .finally(() => {
        refreshPromise = null;
        refreshLock = false;
      });
  }

  // 3. If we have cached data (even stale), return immediately while refresh runs
  if (memResult) {
    return { data: memResult.data, fromCache: true };
  }

  // 4. No cache — wait for refresh (snapshot promise before .finally() nulls it)
  const capturedPromise = refreshPromise;
  const fresh = await capturedPromise;
  if (fresh && fresh.length > 0) return { data: fresh, fromCache: false };

  // 5. Fresh empty → try stale (use CACHE_TTL_STALE, not hardcoded 24h)
  const staleResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_STALE, CACHE_FILE);
  if (staleResult && staleResult.data.length > 0) {
    console.warn('[dota2Matches] Serving stale cache (graceful degradation)');
    return { data: staleResult.data, fromCache: true };
  }

  if (fresh) return { data: fresh, fromCache: false };
  throw new Error('No cached data available and refresh failed');
}

// ── Routes ──

// GET /api/dota2-matches — today's + tomorrow's matches (SWR + graceful degradation)
dota2Matches.get('/', async (c) => {
  if (!checkRateLimit(rateLimitKey(c))) {
    return c.json({ error: 'Too many requests, please retry later' }, 429);
  }

  const forceRefresh = c.req.query('refresh') === 'true';

  if (forceRefresh) {
    if (!checkRateLimit(rateLimitKey(c) + '::refresh')) {
      return c.json({ error: 'Too many refresh requests, please wait 60s' }, 429);
    }
    // Don't delete cache before refresh — if fresh scrape returns empty, serve stale
  }

  try {
    const { data, fromCache } = await getMatchesWithSWR();
    c.header('X-Cache', fromCache ? 'HIT' : 'MISS');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_FRESH / 1000}`);
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[dota2Matches] Scrape failed:', message);
    return c.json({ error: 'Failed to fetch Dota 2 matches', detail: message }, 502);
  }
});

// GET /api/dota2-matches/health — validates scraper HTML structure
dota2Matches.get('/health', async (c) => {
  const checks: Record<string, boolean | string> = {};
  let ok = true;

  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const url = `https://tips.gg/dota2/matches/${dd}-${mm}-${yyyy}/`;

    // Use a fresh fetch (no retry needed for health check)
    const res = await fetch(url, {
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

// GET /api/dota2-matches/logo/:filename — proxy team logos via Puppeteer browser context
dota2Matches.get('/logo/:filename', async (c) => {
  const logoPath = c.req.param('filename');
  if (!logoPath) return c.json({ error: 'Missing path' }, 400);

  const logoUrl = `https://files.tips.gg/static/image/teams/${logoPath}`;
  const cacheFile = join(CACHE_DIR, `logo_${logoPath.replaceAll('/', '_')}`);

  // Serve from disk cache
  const cached = readFileCache<{ data: number[] }>(86400_000, cacheFile); // 24h
  if (cached && !cached.stale) {
    return new Response(Uint8Array.from(cached.data.data), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Fetch via Puppeteer page.evaluate (bypasses CDN hotlink with real browser context)
  try {
    const { getBrowser } = await import('../services/tipsggScraper');
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      // First navigate to tips.gg to get session cookies, then fetch CDN image
      await page.goto('https://tips.gg/dota2/matches/', { waitUntil: 'networkidle0', timeout: 20000 });
      
      const base64 = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      }, logoUrl);

      await page.close().catch(() => {});

      if (!base64 || !base64.startsWith('data:image/')) {
        if (cached) {
          return new Response(Uint8Array.from(cached.data.data), {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
          });
        }
        return c.json({ error: 'Not found' }, 404);
      }

      // Convert base64 data URL to buffer
      const base64Data = base64.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      // Cache to disk
      writeFileCacheInternal({ data: Array.from(buffer) }, cacheFile);

      return new Response(buffer, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' },
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch {
    if (cached) {
      return new Response(Uint8Array.from(cached.data.data), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      });
    }
    return c.json({ error: 'Failed to fetch logo' }, 502);
  }
});

// ── Dynamic routes (MUST be after static routes) ──

// GET /api/dota2-matches/:date/:slug/:time — single match detail
dota2Matches.get('/:date/:slug/:time', async (c) => {
  const { date, slug, time } = c.req.param();
  const matchUrl = `/matches/dota2/${date}/${slug}/${time}/`;

  const detailCacheFile = join(CACHE_DIR, `detail_${date}_${slug}.json`);
  const cached = readFileCache<TipsGgMatch>(CACHE_TTL_FRESH, detailCacheFile);
  if (cached && !cached.stale) return c.json(cached.data);

  try {
    const match = await fetchDota2MatchDetail(matchUrl);
    if (!match) return c.json({ error: 'Match not found' }, 404);
    writeFileCacheInternal(match, detailCacheFile);
    return c.json(match);
  } catch (err) {
    // Graceful degradation for detail
    if (cached) return c.json(cached.data);
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[dota2Matches] Detail scrape failed:', message);
    return c.json({ error: 'Failed to fetch match detail', detail: message }, 502);
  }
});

export default dota2Matches;
