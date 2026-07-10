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

// GET /api/dota2-matches/live-scores — lightweight endpoint for live score updates
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

export default dota2Matches;
