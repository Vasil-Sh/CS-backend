/**
 * CS2 Matches API — wraps tips.gg CS2 scraper with caching, rate limiting,
 * stale-while-revalidate, graceful degradation.
 *
 * Mirrors dota2Matches.ts — same architecture, separate cache & store.
 */

import { Hono } from 'hono';
import { fetchCs2Matches, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure } from '../services/circuitBreaker';
import { cs2LiveScoresStore } from '../services/cs2LiveScoresStore';

const cs2Matches = new Hono();

// ── Cache config ──
const CACHE_TTL_FRESH = 5 * 60 * 1000;   // 5 min — normal TTL
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 1 hour — serve stale only if fresh fetch fails
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'cs2_matches.json');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

interface CacheEntry<T> {
  data: T;
  ts: number;
  day: string;
  from: 'fresh' | 'stale';
}

function readFileCache<T>(maxAge: number, key = CACHE_FILE): { data: T; stale: boolean } | null {
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

function writeFileCacheInternal(data: unknown, key = CACHE_FILE): void {
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

function rateLimitKey(c: any): string {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '127.0.0.1';
  return `${ip}::cs2-matches`;
}

// ── Stale-while-revalidate helper ──
let refreshPromise: Promise<TipsGgMatch[] | null> | null = null;
let refreshLock = false;

async function getMatchesWithSWR(): Promise<{ data: TipsGgMatch[]; fromCache: boolean }> {
  const memResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_FRESH, CACHE_FILE);
  if (memResult && !memResult.stale) {
    return { data: memResult.data, fromCache: true };
  }

  if (!refreshLock) {
    refreshLock = true;
    refreshPromise = fetchCs2Matches()
      .then(matches => {
        if (matches.length > 0) {
          writeFileCacheInternal(matches);
        } else {
          console.warn('[cs2Matches] Empty scrape — keeping existing cache');
        }
        return matches;
      })
      .catch(err => {
        console.error('[cs2Matches] Refresh failed:', (err as Error).message);
        recordFailure('tipsgg_fetchCs2Matches');
        return null;
      })
      .finally(() => {
        refreshPromise = null;
        refreshLock = false;
      });
  }

  if (memResult) {
    return { data: memResult.data, fromCache: true };
  }

  if (!memResult) {
    console.log('[cs2Matches] Cold start — serving empty, refresh runs in background');
    return { data: [], fromCache: false };
  }

  throw new Error('No cached data available and refresh failed');
}

// ── Routes ──

cs2Matches.get('/', async (c) => {
  if (!checkRateLimit(rateLimitKey(c))) {
    return c.json({ error: 'Too many requests, please retry later' }, 429);
  }

  const forceRefresh = c.req.query('refresh') === 'true';
  if (forceRefresh) {
    if (!checkRateLimit(rateLimitKey(c) + '::refresh')) {
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
    console.error('[cs2Matches] Scrape failed:', message);
    return c.json({ error: 'Failed to fetch CS2 matches', detail: message }, 502);
  }
});

// GET /api/v1/cs2-matches/live-scores — reads from in-memory Cs2LiveScoresStore
cs2Matches.get('/live-scores', (c) => {
  return c.json(cs2LiveScoresStore.getScores());
});

export default cs2Matches;
