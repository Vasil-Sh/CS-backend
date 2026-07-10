/**
 * Dota 2 Matches API — wraps tips.gg scraper with in-memory + file caching.
 */

import { Hono } from 'hono';
import { fetchDota2Matches, fetchDota2MatchDetail, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dota2Matches = new Hono();

// ── Two-tier cache: in-memory (fast) + file (survives restart) ──
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'dota2_matches.json');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function readFileCache<T>(): T | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts < CACHE_TTL) return data as T;
  } catch { /* ignore */ }
  return null;
}

function writeFileCache(data: unknown): void {
  try {
    ensureCacheDir();
    writeFileSync(CACHE_FILE, JSON.stringify({ data, ts: Date.now() }), 'utf-8');
  } catch { /* ignore */ }
}

// In-memory cache (same TTL, but instant)
const memCache = new Map<string, { data: unknown; ts: number }>();

function getCache<T>(key: string): T | null {
  const entry = memCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data as T;
  memCache.delete(key);
  return null;
}

function setCache(key: string, data: unknown): void {
  memCache.set(key, { data, ts: Date.now() });
}

// GET /api/dota2/matches — today's + tomorrow's matches
dota2Matches.get('/', async (c) => {
  const cacheKey = 'matches_today_tomorrow';

  // 1. Try in-memory
  let matches = getCache<TipsGgMatch[]>(cacheKey);
  if (matches) return c.json(matches);

  // 2. Try file cache
  matches = readFileCache<TipsGgMatch[]>();
  if (matches) {
    setCache(cacheKey, matches);
    return c.json(matches);
  }

  // 3. Fetch fresh
  try {
    matches = await fetchDota2Matches();
    setCache(cacheKey, matches);
    writeFileCache(matches);
    return c.json(matches);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[dota2Matches] Scrape failed:', message);
    return c.json({ error: 'Failed to fetch Dota 2 matches', detail: message }, 502);
  }
});

// GET /api/dota2/matches/:date/:slug/:time — single match detail
dota2Matches.get('/:date/:slug/:time', async (c) => {
  const { date, slug, time } = c.req.param();
  const matchUrl = `/matches/dota2/${date}/${slug}/${time}/`;

  const cacheKey = `detail_${matchUrl}`;
  const cached = getCache<TipsGgMatch>(cacheKey);
  if (cached) return c.json(cached);

  try {
    const match = await fetchDota2MatchDetail(matchUrl);
    if (!match) return c.json({ error: 'Match not found' }, 404);
    setCache(cacheKey, match);
    return c.json(match);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[dota2Matches] Detail scrape failed:', message);
    return c.json({ error: 'Failed to fetch match detail', detail: message }, 502);
  }
});

export default dota2Matches;
