/**
 * Dota 2 Matches API — wraps tips.gg scraper with caching.
 */

import { Hono } from 'hono';
import { fetchDota2Matches, fetchDota2MatchDetail, type TipsGgMatch } from '../services/tipsggScraper';

const dota2Matches = new Hono();

// In-memory cache (5 min TTL)
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

function cacheSet(key: string, data: unknown): void {
  cache.set(key, { data, ts: Date.now() });
}

// GET /api/dota2/matches — today's and upcoming matches
dota2Matches.get('/', async (c) => {
  const dateParam = c.req.query('date'); // optional DD-MM-YYYY

  const cacheKey = `matches_${dateParam || 'today'}`;
  const cached = cacheGet<TipsGgMatch[]>(cacheKey);
  if (cached) return c.json(cached);

  try {
    const matches = await fetchDota2Matches(dateParam || undefined);
    cacheSet(cacheKey, matches);
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
  const cached = cacheGet<TipsGgMatch>(cacheKey);
  if (cached) return c.json(cached);

  try {
    const match = await fetchDota2MatchDetail(matchUrl);
    if (!match) return c.json({ error: 'Match not found' }, 404);
    cacheSet(cacheKey, match);
    return c.json(match);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[dota2Matches] Detail scrape failed:', message);
    return c.json({ error: 'Failed to fetch match detail', detail: message }, 502);
  }
});

export default dota2Matches;
