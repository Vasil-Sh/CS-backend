/**
 * Dota 2 Matches API — wraps tips.gg scraper with caching, rate limiting,
 * stale-while-revalidate, graceful degradation.
 */

import { Hono } from 'hono';
import { fetchDota2Matches, fetchDota2MatchDetail, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
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
    writeFileSync(key, JSON.stringify(entry), 'utf-8');
  } catch { /* ignore */ }
}

// ── Rate limiter ──
const RATE_LIMIT_WINDOW = 30000; // 30s
const RATE_LIMIT_MAX = 5;        // max 5 requests per window
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

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

async function getMatchesWithSWR(): Promise<{ data: TipsGgMatch[]; fromCache: boolean }> {
  // 1. Try in-memory fresh cache
  const memResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_FRESH, CACHE_FILE);
  if (memResult && !memResult.stale) {
    return { data: memResult.data, fromCache: true };
  }

  // 2. Try to refresh in background
  if (!refreshPromise) {
    refreshPromise = fetchDota2Matches()
      .then(matches => {
        writeFileCacheInternal(matches);
        return matches;
      })
      .catch(err => {
        console.error('[dota2Matches] Refresh failed:', (err as Error).message);
        recordFailure('tipsgg_fetchDota2Matches');
        return null;
      })
      .finally(() => { refreshPromise = null; });
  }

  // 3. If we have fresh cached data, return immediately while refresh happens in background
  if (memResult) {
    // Don't await the refresh — it runs in background
    return { data: memResult.data, fromCache: true };
  }

  // 4. No fresh cache — wait for the refresh
  const fresh = await refreshPromise;
  if (fresh) return { data: fresh, fromCache: false };

  // 5. Graceful degradation: return stale cache (>1 hour old)
  const staleResult = readFileCache<TipsGgMatch[]>(24 * 60 * 60 * 1000, CACHE_FILE);
  if (staleResult) {
    console.warn('[dota2Matches] Serving stale cache (graceful degradation)');
    return { data: staleResult.data, fromCache: true };
  }

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
    // Purge cached file — force fresh scrape
    try { if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE); } catch {}
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

// GET /api/dota2-matches/live-scores — lightweight live score updates
dota2Matches.get('/live-scores', async (c) => {
  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const url = `https://tips.gg/dota2/matches/${dd}-${mm}-${yyyy}/`;

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    
    const { stdout: html } = await execFileAsync('curl', [
      '-s', '-L', '--max-time', '10',
      '-H', `User-Agent: ${UA}`,
      '-H', 'Accept: text/html',
      url,
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 15000 });

    const scoreRegex = /class="score[^"]*">(\d{1,2})<\/span>/gi;
    const liveUpdates: Array<{ id: string; score1: number | null; score2: number | null; status: string }> = [];
    
    const matchBlocks = html.split(/class="element match/).slice(1);
    
    for (const block of matchBlocks) {
      const statusMatch = block.match(/class="element match (\w+)/);
      const status = statusMatch?.[1] || 'upcoming';
      
      const urlMatch = block.match(/href="\/matches\/dota2\/[^"]+\/([a-z0-9-]+-vs-[a-z0-9-]+)\//);
      if (!urlMatch) continue;
      
      const id = urlMatch[1];
      const scores = [...block.matchAll(scoreRegex)].map(m => parseInt(m[1], 10));
      
      liveUpdates.push({
        id,
        score1: scores[0] ?? null,
        score2: scores[1] ?? null,
        status,
      });
    }

    return c.json(liveUpdates);
  } catch (e) {
    return c.json({ error: 'Failed' }, 502);
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
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    
    const { stdout } = await execFileAsync('curl', [
      '-s', '-L', '--max-time', '10',
      '-H', `User-Agent: ${UA}`,
      '-H', 'Accept: text/html',
      url,
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 15000 });
    
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

// GET /api/dota2-matches/logo/* — proxy team logos through backend
dota2Matches.get('/logo/*', async (c) => {
  const logoPath = c.req.param('*');
  if (!logoPath) return c.json({ error: 'Missing path' }, 400);

  const logoUrl = `https://files.tips.gg/static/image/teams/${logoPath}`;
  
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    
    const { stdout } = await execFileAsync('curl', [
      '-s', '-L', '--max-time', '10',
      '-H', `User-Agent: ${UA}`,
      '-H', 'Referer: https://tips.gg/',
      '--output', '-',
      logoUrl,
    ], { maxBuffer: 512 * 1024, timeout: 12000, encoding: 'buffer' });
    
    if (!stdout || stdout.length === 0) {
      return c.json({ error: 'Not found' }, 404);
    }

    return new Response(stdout, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
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
