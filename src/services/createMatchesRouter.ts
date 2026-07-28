/**
 * Matches Router Factory — creates a Hono router for Dota2 or CS2 matches.
 *
 * Shares cache, rate limiting, SWR, and logo proxy logic between both games.
 * Mirrors the previous dota2Matches.ts / cs2Matches.ts architecture.
 */

import { Hono } from 'hono';
import { fetchMatchDetail, getBrowser, fetchHtml, type TipsGgMatch } from '../services/tipsggScraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure } from '../services/circuitBreaker';
import type { ILiveScoresStore } from '../services/liveScoresStore';
import { upsertMatchHistoryBatch } from '../services/matchHistoryService';

interface MatchRouterConfig {
  game: 'dota2' | 'cs2';
  fetchFn: () => Promise<TipsGgMatch[]>;
  liveScoresStore: ILiveScoresStore;
  cacheFile: string;
  circuitBreakerName: string;
  healthUrl?: string;
}

const CACHE_TTL_FRESH = 5 * 60 * 1000;   // 5 min — normal TTL
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 1 hour — serve stale only if fresh fetch fails
const CACHE_DIR = join(process.cwd(), '.cache');

/**
 * Rewrite external logo URLs to use our internal HTTP proxy.
 * Applied server-side so ALL clients get CORS-safe, properly encoded URLs.
 */
function proxyLogoUrl(url: string | null, prefix: string): string | null {
  if (!url) return null;
  if (/fallback\.(webp|png|svg)/i.test(url)) return null;
  if (url.startsWith('/api/')) return url;
  const encoded = Buffer.from(url).toString('base64url');
  return `/api/v1/${prefix}-matches/logo/external/${encoded}`;
}

// In-memory cache — avoids sync file reads on every request
const memCache = new Map<string, { data: unknown; ts: number; day: string }>();
const MEM_CACHE_TTL = 30_000; // 30s before stale-check falls back to disk

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
    // Check in-memory cache first (fast path — no I/O)
    const memEntry = memCache.get(key);
    if (memEntry) {
      const today = new Date().toISOString().split('T')[0];
      if (memEntry.day !== today) { memCache.delete(key); }
      else {
        const memAge = Date.now() - memEntry.ts;
        if (memAge < MEM_CACHE_TTL) return { data: memEntry.data as T, stale: memAge >= maxAge };
      }
    }

    if (!existsSync(key)) return null;
    const raw = readFileSync(key, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    if (entry.day && entry.day !== today) return null;
    const age = Date.now() - entry.ts;
    // Populate in-memory cache on disk read
    memCache.set(key, { data: entry.data, ts: entry.ts, day: entry.day });
    if (age < maxAge) return { data: entry.data, stale: false };
    return { data: entry.data, stale: true };
  } catch { return null; }
}

export function writeFileCacheInternal(data: unknown, key: string): void {
  try {
    ensureCacheDir();
    const today = new Date().toISOString().split('T')[0];
    const entry: CacheEntry<unknown> = { data, ts: Date.now(), day: today, from: 'fresh' };
    const tmp = key + '.tmp';
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    try { if (existsSync(key)) unlinkSync(key); } catch {}
    renameSync(tmp, key);
    // Update in-memory cache too
    memCache.set(key, { data, ts: Date.now(), day: today });
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
            // Persist finished matches to DB for history
            const finished = matches
              .filter(m => m.status === 'finished')
              .map(m => ({
                id: m.id,
                game: cfg.game,
                team1: m.nameTeam1,
                team2: m.nameTeam2,
                date: m.date,
                score1: m.score1 ?? 0,
                score2: m.score2 ?? 0,
                status: 'finished' as const,
                tournament: m.tournament || m.stage || '',
                matchType: m.type,
                logoTeam1: m.logoTeam1,
                logoTeam2: m.logoTeam2,
              }));
            if (finished.length > 0) {
              upsertMatchHistoryBatch(finished).catch(e =>
                console.error(`[${prefix}Matches] History sync failed:`, (e as Error).message)
              );
            }
          } else {
            // Scrape returned 0 matches — don't overwrite cache. Return cached data if available.
            console.warn(`[${prefix}Matches] Empty scrape — keeping existing cache`);
            // Read stale cache to serve (don't bother writing empty)
            const stale = readFileCache<TipsGgMatch[]>(CACHE_TTL_STALE, cacheFile);
            return stale ? stale.data : [];
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

    // Cold start: wait for initial fetch to complete (up to 15s) so the first
    // visitor doesn't see an empty list. Only return empty if both refresh
    // and stale cache are unavailable.
    if (!memResult) {
      if (state.promise) {
        try {
          const fresh = await Promise.race([
            state.promise,
            new Promise<null>(r => setTimeout(() => r(null), 15_000)),
          ]);
          if (fresh && fresh.length > 0) return { data: fresh, fromCache: false };
        } catch { /* fall through */ }
      }
      // Re-check: refresh may have completed and written cache between checks
      const recheck = readFileCache<TipsGgMatch[]>(CACHE_TTL_STALE, cacheFile);
      if (recheck) return { data: recheck.data, fromCache: true };
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

      // ── Overlay live scores on match list ──
      // Even when the match list is cached (5min TTL), live scores from
      // LiveScoresStore are at most 7s old. This gives near-real-time scores
      // without needing to wait for a full Puppeteer re-scrape.
      if (fromCache) {
        const liveScores = scoresStore.getScores();
        if (liveScores.length > 0) {
          const scoreMap = new Map(liveScores.map(s => [s.id, s]));
          for (const m of data) {
            const ls = scoreMap.get(m.id);
            if (!ls) continue;
            if (m.status === 'finished') continue; // don't touch finished
            // Apply live scores (allow 0→0 override for started-but-no-score matches)
            if (ls.score1 != null) m.score1 = ls.score1;
            if (ls.score2 != null) m.score2 = ls.score2;
            // Status: only upgrade (upcoming→live, live→finished), never downgrade
            if (ls.status === 'live' && m.status === 'upcoming') m.status = 'live';
            else if (ls.status === 'finished') m.status = 'finished';
          }
        }
      }

      // Filter out matches from past days (date < today).
      // Today's finished matches are still returned — frontend handles auto-hide.
      const today = new Date().toISOString().split('T')[0];
      const filtered = data.filter(m => m.date >= today);

      // ── Rewrite logo URLs to internal proxy (CORS-safe, no broken URLs) ──
      for (const m of filtered) {
        m.logoTeam1 = proxyLogoUrl(m.logoTeam1, prefix);
        m.logoTeam2 = proxyLogoUrl(m.logoTeam2, prefix);
      }

      c.header('X-Cache', fromCache ? 'HIT' : 'MISS');
      c.header('Cache-Control', `public, max-age=${CACHE_TTL_FRESH / 1000}`);
      return c.json(filtered);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${prefix}Matches] Scrape failed:`, message);
      return c.json({ error: `Failed to fetch ${gameLabel} matches`, detail: message }, 502);
    }
  });

  // ── GET /live-scores — only changed scores (compact, efficient) ──
  router.get('/live-scores', (c) => {
    const changed = scoresStore.getChangedScores();
    return c.json(changed);
  });

  // ── GET /live-scores/all — full snapshot (debug / initial load) ──
  router.get('/live-scores/all', (c) => {
    return c.json(scoresStore.getResponse());
  });

  // ── GET /logo/external/:b64url — proxy any external logo URL ──
  // Encoded as base64url → our server fetches, caches, serves.
  // Handles cstest.pp.ua, HLTV, and any other external CDN.
  router.get('/logo/external/:b64url', async (c) => {
    const b64url = c.req.param('b64url');
    if (!b64url) return c.json({ error: 'Missing URL' }, 400);

    let externalUrl: string;
    try {
      externalUrl = Buffer.from(b64url, 'base64url').toString('utf-8');
      if (!externalUrl.startsWith('http')) throw new Error('Invalid URL');
    } catch {
      return c.json({ error: 'Invalid URL encoding' }, 400);
    }

    // Cache key: hash the URL
    const crypto = await import('node:crypto');
    const urlHash = crypto.createHash('sha256').update(externalUrl).digest('hex').slice(0, 16);
    const ext = externalUrl.match(/\.(png|svg|webp|jpg|jpeg|gif)(\?|$)/i)?.[1] || 'png';
    const binCacheFile = join(CACHE_DIR, `extlogo_${urlHash}.${ext}`);

    // Serve from cache (24h TTL)
    if (existsSync(binCacheFile)) {
      const stat = statSync(binCacheFile);
      if (Date.now() - stat.mtimeMs < 86400_000) {
        const buf = readFileSync(binCacheFile);
        const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        return new Response(buf, {
          headers: {
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    // Fetch: tips.gg CDN uses Puppeteer + tries filename variants (CDN naming is inconsistent)
    try {
      const isTipsGgCdn = externalUrl.includes('files.tips.gg');
      let buf: Buffer | null = null;

      if (isTipsGgCdn) {
        // Build variant URLs to try (tips.gg CDN filenames are unpredictable)
        const baseUrl = externalUrl.replace(/\.(png|svg|webp)$/i, '');
        const candidateUrls = [externalUrl];

        // Strip game suffix: team-dota2.png → team.png, team-csgo.png → team.png
        const noGame = baseUrl.replace(/-(csgo|cs2|dota2)$/i, '');
        if (noGame !== baseUrl) {
          candidateUrls.push(`${noGame}.png`);
          candidateUrls.push(`${noGame}-csgo.png`);
          candidateUrls.push(`${noGame}-cs2.png`);
          candidateUrls.push(`${noGame}-dota2.png`);
        }

        // Swap underscores ↔ hyphens
        const swapped = noGame.replace(/_/g, '-');
        if (swapped !== noGame) {
          candidateUrls.push(`${swapped}.png`);
          candidateUrls.push(`${swapped}-dota2.png`);
          candidateUrls.push(`${swapped}-csgo.png`);
        }

        // Deduplicate
        const uniqueUrls = [...new Set(candidateUrls)];

        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
          for (const url of uniqueUrls) {
            const base64DataUrl = await page.evaluate(async (u: string): Promise<string | null> => {
              try {
                const res = await fetch(u, { headers: { 'Referer': 'https://tips.gg/' } });
                if (!res.ok) return null;
                const blob = await res.blob();
                const arr = new Uint8Array(await blob.arrayBuffer());
                let bin = '';
                for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
                return 'data:' + blob.type + ';base64,' + btoa(bin);
              } catch { return null; }
            }, url);

            if (base64DataUrl) {
              const base64Data = base64DataUrl.replace(/^data:[^;]+;base64,/, '');
              buf = Buffer.from(base64Data, 'base64');
              if (url !== externalUrl) {
                console.log(`[logo] ${externalUrl.split('/').pop()} → found at ${url.split('/').pop()}`);
              }
              break;
            }
          }
        } finally {
          await page.close().catch(() => {});
        }
        if (!buf) throw new Error('All CDN variants failed');
      } else {
        // Non-tips.gg CDN — plain HTTP fetch is fine
        const resp = await fetch(externalUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 100) throw new Error('Too small');
      }

      ensureCacheDir();
      writeFileSync(binCacheFile, buf);

      const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return new Response(buf, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      // Serve stale cache if available
      if (existsSync(binCacheFile)) {
        const buf = readFileSync(binCacheFile);
        const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        return new Response(buf, {
          headers: {
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      return c.json({ error: 'Failed to fetch external logo' }, 502);
    }
  });

  // ── GET /logo/:filename — proxy team logos via Puppeteer ──
  router.get('/logo/:filename', async (c) => {
    const logoPath = c.req.param('filename');
    if (!logoPath) return c.json({ error: 'Missing path' }, 400);

    const safeName = logoPath.replaceAll('/', '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    const jsonCacheFile = join(CACHE_DIR, `${imgCachePrefix}${safeName}`);
    const binCacheFile = join(CACHE_DIR, `${imgCachePrefix}${safeName}.bin`);

    // Serve from disk cache (prefer .bin, fallback to legacy .json)
    if (existsSync(binCacheFile)) {
      const stat = statSync(binCacheFile);
      const age = Date.now() - stat.mtimeMs;
      if (age < 86400_000) {
        const buf = readFileSync(binCacheFile);
        return new Response(buf, { headers: imgHeaders });
      }
    } else if (existsSync(jsonCacheFile)) {
      try {
        const entry = JSON.parse(readFileSync(jsonCacheFile, 'utf-8'));
        const data = entry.data?.data || entry.data;
        if (Array.isArray(data)) {
          const age = Date.now() - (entry.ts || 0);
          if (age < 86400_000) {
            return new Response(Uint8Array.from(data), { headers: imgHeaders });
          }
        }
      } catch { /* stale/malformed — re-fetch */ }
    }

    // Build candidate CDN URLs to try (CDN naming is unpredictable)
    const candidates = [
      `https://files.tips.gg/static/image/teams/${logoPath}`,
    ];
    const base = logoPath.replace(/\.png$/i, '');
    const bare = base.replace(/-(csgo|cs2|dota2)$/i, '');
    if (bare !== base) {
      candidates.push(`https://files.tips.gg/static/image/teams/${bare}.png`);
      candidates.push(`https://files.tips.gg/static/image/teams/${bare}-csgo.png`);
      candidates.push(`https://files.tips.gg/static/image/teams/${bare}-cs2.png`);
      candidates.push(`https://files.tips.gg/static/image/teams/${bare}-dota2.png`);
    }
    // Also try with underscores ↔ hyphens swapped (CDN uses both)
    const swapped = bare.replace(/_/g, '-');
    if (swapped !== bare) {
      candidates.push(`https://files.tips.gg/static/image/teams/${swapped}.png`);
      candidates.push(`https://files.tips.gg/static/image/teams/${swapped}-csgo.png`);
      candidates.push(`https://files.tips.gg/static/image/teams/${swapped}-cs2.png`);
    }
    const uniqueUrls = [...new Set(candidates)];

    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

      let buffer: Buffer | null = null;
      for (const url of uniqueUrls) {
        const base64DataUrl = await page.evaluate(async (url: string): Promise<string | null> => {
          try {
            const res = await fetch(url, { headers: { 'Referer': 'https://tips.gg/' } });
            if (!res.ok) return null;
            const blob = await res.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return 'data:image/png;base64,' + btoa(binary);
          } catch { return null; }
        }, url);

        if (base64DataUrl) {
          const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
          buffer = Buffer.from(base64Data, 'base64');
          console.log(`[logo] ${logoPath} → OK (${url})`);
          break;
        }
      }

      await page.close().catch(() => {});

      if (!buffer) throw new Error('All CDN URLs failed');

      // Write raw .bin cache (much smaller than number[] JSON)
      ensureCacheDir();
      writeFileSync(binCacheFile, buffer);

      // Clean up legacy JSON cache if exists
      try { if (existsSync(jsonCacheFile)) unlinkSync(jsonCacheFile); } catch {}

      return new Response(buffer, { headers: imgHeaders });
    } catch {
      // If we had a legacy JSON cache, serve stale
      if (existsSync(jsonCacheFile)) {
        try {
          const entry = JSON.parse(readFileSync(jsonCacheFile, 'utf-8'));
          const data = entry.data?.data || entry.data;
          if (Array.isArray(data)) {
            return new Response(Uint8Array.from(data), {
              headers: { ...imgHeaders, 'Cache-Control': 'public, max-age=3600' },
            });
          }
        } catch {}
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
        const stdout = await fetchHtml(healthUrl, 1);

        checks['html_response'] = stdout.length > 5000;
        checks['json_ld'] = stdout.includes('application/ld+json');
        checks['json_ld_count'] = String((stdout.match(/application\/ld\+json/gi) || []).length);
        checks['score_elements'] = stdout.includes('class="score');
        checks['bookmaker_section'] = stdout.includes('bookmakers-analysis-counters');
        checks['match_listing'] = stdout.includes('class="element match');
        checks['fetch_method'] = 'puppeteer';

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
