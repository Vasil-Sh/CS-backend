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
import { getHltvLogoCache } from '../services/hltv/hltvRankingScraper';
import { batchComputeTeamForms } from './teamFormService';
import { lookupLocalLogo, getLocalLogoDir, lookupTipsggLogo, lookupDota2LocalLogo, getDota2LogoDir } from '../services/logoStore';
import { touchActivity } from './activityTracker';

interface MatchRouterConfig {
  game: 'dota2' | 'cs2';
  fetchFn: () => Promise<TipsGgMatch[]>;
  liveScoresStore: ILiveScoresStore;
  cacheFile: string;
  circuitBreakerName: string;
  healthUrl?: string;
}

const CACHE_TTL_FRESH = 60 * 60 * 1000;  // 1 hour — normal TTL (incremental refresh keeps it current)
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 1 hour — serve stale only if fresh fetch fails
const CACHE_DIR = join(process.cwd(), '.cache');

// ── Logo download queue — limit concurrent Puppeteer fetches ──
const logoDownloadsInFlight = new Map<string, { promise: Promise<Buffer>; ts: number }>();

// ── Team form cache — in-memory cache of computed team forms ──
import type { TeamFormResult } from './teamFormService';
const teamFormCache = new Map<string, { data: Map<string, TeamFormResult>; ts: number }>();

async function fetchAndCacheLogo(cdnUrl: string, cacheFile: string): Promise<Buffer> {
  // Deduplicate concurrent requests for the same file
  const existing = logoDownloadsInFlight.get(cacheFile);
  if (existing) return existing.promise;

  const promise = (async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      const base64DataUrl = await page.evaluate(async (url: string): Promise<string | null> => {
        try {
          const res = await fetch(url, { headers: { 'Referer': 'https://tips.gg/' } });
          if (!res.ok) return null;
          const blob = await res.blob();
          const arr = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
          return 'data:' + blob.type + ';base64,' + btoa(bin);
        } catch { return null; }
      }, cdnUrl);

      if (!base64DataUrl) throw new Error('Puppeteer fetch returned null');
      const base64Data = base64DataUrl.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      const dir = cacheFile.substring(0, cacheFile.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(cacheFile, buf);
      return buf;
    } finally {
      await page.close().catch(() => {});
      logoDownloadsInFlight.delete(cacheFile);
    }
  })();

  logoDownloadsInFlight.set(cacheFile, { promise, ts: Date.now() });
  return promise;
}

/**
 * Rewrite external logo URLs to use our internal HTTP proxy.
 * Applied server-side so ALL clients get CORS-safe, properly encoded URLs.
 * tips.gg CDN → /logo/cached/ (local disk cache, fast)
 * cstest/HLTV → /logo/external/{b64} (Puppeteer proxy)
 */
function proxyLogoUrl(url: string | null, prefix: string): string | null {
  if (!url) return null;
  if (/fallback\.(webp|png|svg)/i.test(url)) return null;
  if (url.startsWith('/api/')) return url;

  // All external URLs (tips.gg CDN, cstest, HLTV) → /logo/external
  const encoded = Buffer.from(url).toString('base64url');
  return `/api/v1/${prefix}-matches/logo/external/${encoded}`;
}

/**
 * Generate logo URL for a match that has null logo.
 * Priority: 1. HLTV local 2. tips.gg local 3. tips.gg CDN map 4. HLTV CDN 5. tips.gg slug.
 */
export function generateLogoFallback(teamName: string, prefix: string): string | null {
  // 1. HLTV local logo store — 2706 CS2 files, instant
  const localFile = lookupLocalLogo(teamName);
  if (localFile) {
    return `/api/v1/${prefix}-matches/logo/local/${encodeURIComponent(localFile)}`;
  }

  // 2. Dota2 local logo store — 1259 files (Dota2-only, skipped for CS2)
  if (prefix === 'dota2') {
    const dota2File = lookupDota2LocalLogo(teamName);
    if (dota2File) {
      return `/api/v1/${prefix}-matches/logo/dota2local/${encodeURIComponent(dota2File)}`;
    }
  }

  // 3. tips.gg CDN team logo map — exact URLs scraped from /teams/ (fallback)
  const gameKey = prefix === 'cs2' ? 'cs2' : 'dota2';
  const tipsggUrl = lookupTipsggLogo(teamName, gameKey);
  if (tipsggUrl) {
    const encoded = Buffer.from(tipsggUrl).toString('base64url');
    return `/api/v1/${prefix}-matches/logo/external/${encoded}`;
  }

  // 4. HLTV ranking CDN (img-cdn.hltv.org) — usually blocked
  const hltvMap = getHltvLogoCache();
  if (hltvMap) {
    const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const raw = teamName.toLowerCase().trim();
    const url = hltvMap.get(norm) || hltvMap.get(raw);
    if (url) {
      const encoded = Buffer.from(url).toString('base64url');
      return `/api/v1/${prefix}-matches/logo/external/${encoded}`;
    }
  }

  // 5. tips.gg CDN slug-based fallback (guesswork)
  const slug = teamName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const fallbackUrl = `https://files.tips.gg/static/image/teams/${slug}.png`;
  const encoded = Buffer.from(fallbackUrl).toString('base64url');
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
const RATE_LIMIT_MAX = 15; // increased from 5 — frontend retries during backend cold start
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

  // Debounce history persistence: track already-persisted match IDs to avoid
  // hammering the DB with duplicate upserts on every cache read.
  const _historyPersisted = new Set<string>();

  function persistFinishedIfNeeded(data: TipsGgMatch[], cfg: MatchRouterConfig): void {
    const finished = data.filter(
      (m) => m.status === 'finished' && !_historyPersisted.has(m.id),
    );
    if (finished.length === 0) return;
    for (const m of finished) _historyPersisted.add(m.id);

    const entries = finished.map((m) => ({
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
    upsertMatchHistoryBatch(entries).catch((e) =>
      console.error(`[${prefix}Matches] History persist failed:`, (e as Error).message),
    );
  }

  /** Persist ALL finished matches (not just new ones) — used after full re-scrape. */
  function syncFinishedToHistory(matches: TipsGgMatch[]): void {
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
        console.error(`[${prefix}Matches] History sync failed:`, (e as Error).message),
      );
    }
  }

  async function getMatchesWithSWR(forceRefresh = false): Promise<{ data: TipsGgMatch[]; fromCache: boolean }> {
    // Always read from disk — memCache can be stale when incremental refresh
    // updates the file without going through this function.
    memCache.delete(cacheFile);
    const memResult = readFileCache<TipsGgMatch[]>(CACHE_TTL_FRESH, cacheFile);

    // If user explicitly requested refresh, force a full re-scrape.
    // Skip all cache checks — trigger background fetch immediately.
    if (forceRefresh) {
      const state = getRefreshState(cacheFile);
      if (!state.lock) {
        state.lock = true;
        state.promise = fetchFn()
          .then(matches => {
            if (matches.length > 0) {
              writeFileCacheInternal(matches, cacheFile);
              syncFinishedToHistory(matches);
            }
            return matches;
          })
          .catch(err => {
            console.error(`[${prefix}Matches] Force refresh failed:`, (err as Error).message);
            recordFailure(circuitBreakerName);
            return null;
          })
          .finally(() => { state.promise = null; state.lock = false; });
      }
      // Return current cache while refresh runs in background
      if (memResult) {
        persistFinishedIfNeeded(memResult.data, cfg);
        return { data: memResult.data, fromCache: true };
      }
      // No cache at all — serve empty, refresh will populate
      console.log(`[${prefix}Matches] Force refresh — serving current data, full scrape in background`);
      return { data: [], fromCache: false };
    }

    // Cache is fresh (<1h) — serve immediately, no network requests.
    if (memResult && !memResult.stale) {
      // Fire-and-forget: persist finished matches to history DB.
      // This catches matches from warmup that never went through SWR refresh.
      persistFinishedIfNeeded(memResult.data, cfg);
      return { data: memResult.data, fromCache: true };
    }

    // Cache is stale but from today — serve it without triggering a full re-scrape.
    // Incremental refresh (120s) + live scores (20s) already keep data current.
    // Full re-scrape is heavy (8-day Puppeteer) and risks Cloudflare bans on tips.gg.
    if (memResult) {
      persistFinishedIfNeeded(memResult.data, cfg);
      return { data: memResult.data, fromCache: true };
    }

    // No cache at all (cold start or expired from yesterday) — must fetch.

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

    // Re-check: background fetch may have completed and written cache
    const recheck = readFileCache<TipsGgMatch[]>(CACHE_TTL_STALE, cacheFile);
    if (recheck) {
      persistFinishedIfNeeded(recheck.data, cfg);
      return { data: recheck.data, fromCache: true };
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
      // After waiting, refresh may have completed and written cache
      const recheck2 = readFileCache<TipsGgMatch[]>(CACHE_TTL_STALE, cacheFile);
      if (recheck2) return { data: recheck2.data, fromCache: true };
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
      // Track user activity — signals to live score workers that someone is watching.
      // Workers reduce polling frequency when idle to save tips.gg requests.
      touchActivity();
      const { data, fromCache } = await getMatchesWithSWR(forceRefresh);

      // ── Overlay live scores on match list ──
      // Live scores from the in-memory store are at most 7s old and correctly
      // count map wins. Only overlay matches that the live store considers
      // "live" or "upcoming" — finished matches in the live store are heldover
      // from a past state and may have incomplete scores (e.g. 1-0 map score
      // vs 2-1 series score from the full scrape).
      const liveScores = scoresStore.getScores();
      if (liveScores.length > 0) {
        const scoreMap = new Map(liveScores.map(s => [s.id, s]));
        for (const m of data) {
          const ls = scoreMap.get(m.id);
          if (!ls) continue;
          // Only overlay scores — status comes from the full scrape.
          // Live store status is unreliable when sourced from stale seed data.
          if (ls.status === 'finished') continue;
          if (ls.status === 'upcoming') continue;
          // Apply live scores (allow 0→0 override for started-but-no-score matches)
          if (ls.score1 != null) m.score1 = ls.score1;
          if (ls.score2 != null) m.score2 = ls.score2;
        }
      }

      // ── Safety net: auto-timeout stuck "live" / fix falsely "finished" matches ──
      const now = Date.now();
      const todayStr = new Date().toISOString().split('T')[0];
      // Format-dependent max durations:
      //   CS2:   Bo1=1h, Bo3=2.5h, Bo5=4.5h
      //   Dota2: Bo1=1h, Bo3=3.5h, Bo5=5.5h
      const getMaxHours = (type: string): number => {
        if (/bo5/i.test(type)) return game === 'dota2' ? 5.5 : 4.5;
        if (/bo3/i.test(type)) return game === 'dota2' ? 3.5 : 2.5;
        if (/bo1/i.test(type)) return 1;
        return 4;
      };
      // Score-decided thresholds:
      //   CS2:   Bo1=0.5h, Bo3=2h, Bo5=3.5h
      //   Dota2: Bo1=0.5h, Bo3=2.5h, Bo5=4h
      const getScoreDecidedHours = (type: string): number => {
        if (/bo5/i.test(type)) return game === 'dota2' ? 4 : 3.5;
        if (/bo3/i.test(type)) return game === 'dota2' ? 2.5 : 2;
        return 0.5; // Bo1
      };
      for (const m of data) {
        const hasStartDate = !!(m as any).startDate;
        const startTs = hasStartDate
          ? new Date((m as any).startDate).getTime()
          : new Date(m.date + 'T00:00:00Z').getTime();
        const msSinceStart = now - startTs;
        const hoursSinceStart = msSinceStart / (1000 * 60 * 60);
        const matchType = (m as any).type || (m as any).format || '';
        const maxHours = getMaxHours(matchType);

        if (m.status === 'live') {
          // If the match is from a previous day, it's definitely finished
          if (m.date < todayStr) {
            m.status = 'finished';
            continue;
          }
          if (!isNaN(startTs)) {
            const s1 = m.score1 ?? 0;
            const s2 = m.score2 ?? 0;
            const maxScore = Math.max(s1, s2);
            const isBo3Plus = /bo[3-9]/i.test(matchType);
            const isBo1 = /bo1/i.test(matchType);
            const isBo5 = /bo5/i.test(matchType);
            const scoreDecided = isBo1 ? (s1 + s2 >= 1 && Math.abs(s1 - s2) >= 1)
              : isBo3Plus ? (isBo5 ? maxScore >= 3 : maxScore >= 2)
              : maxScore >= 2;
            const hasScores = s1 > 0 || s2 > 0;

            // Score-decided + enough time passed → auto-finish
            const scoreDecidedHours = getScoreDecidedHours(matchType);
            if (hasScores && scoreDecided && hoursSinceStart > scoreDecidedHours) {
              m.status = 'finished';
              continue;
            }

            // Format-dependent hard timeout (with or without scores)
            if (hasStartDate && hoursSinceStart > maxHours) {
              m.status = 'finished';
            } else if (!hasStartDate && hoursSinceStart > maxHours * 1.5) {
              m.status = 'finished'; // no startDate = less precise, give 50% more time
            } else if (hasStartDate && hoursSinceStart > 0.5) {
              // Auto-cancelled: live match with no scores 30min past start
              if (!hasScores) {
                m.status = 'finished'; // effectively cancelled — won't play today
              }
            }
          }
        } else if (m.status === 'finished' && m.date >= todayStr) {
          // Reverse safety net: a "finished" match on today that started recently
          // is almost certainly still live (source dropped it between maps).
          if (!isNaN(startTs) && hoursSinceStart > 0 && hoursSinceStart < maxHours) {
            const s1 = m.score1 ?? 0;
            const s2 = m.score2 ?? 0;
            const maxScore = Math.max(s1, s2);
            const isBo5 = /bo5/i.test(matchType);
            const isBo3Plus = /bo[3-9]/i.test(matchType);
            // BO5: max < 3 means not finished; BO3: max < 2; BO1: score=0 suspicious
            if (isBo5 ? maxScore < 3 : isBo3Plus ? maxScore < 2 : maxScore === 0) {
              m.status = 'live';
            }
          }
        }
      }

      // Filter out matches from past days (date < today).
      // Today's finished matches are still returned — frontend handles auto-hide.
      const today = new Date().toISOString().split('T')[0];
      const filtered = data.filter(m => m.date >= today);

      // ── Rewrite logo URLs to internal proxy (CORS-safe, no broken URLs) ──
      // ── Cast team names to string — numeric names like "6666" become Int64 in JSON ──
      for (const m of filtered) {
        m.nameTeam1 = String(m.nameTeam1);
        m.nameTeam2 = String(m.nameTeam2);
        m.tournament = String(m.tournament ?? '');
        m.stage = String(m.stage ?? '');
        m.logoTeam1 = m.logoTeam1 ? proxyLogoUrl(m.logoTeam1, prefix) : generateLogoFallback(m.nameTeam1, prefix);
        m.logoTeam2 = m.logoTeam2 ? proxyLogoUrl(m.logoTeam2, prefix) : generateLogoFallback(m.nameTeam2, prefix);
      }

      // ── Enrich with team form data from match history ──
      // Cache hit → use immediately. Cache miss → await computation.
      // Stale cache → use cached, trigger background refresh.
      const cachedForm = teamFormCache.get(game);
      if (cachedForm && Date.now() - cachedForm.ts < 120_000) {
        for (const m of filtered) {
          (m as any).formTeam1 = cachedForm.data.get(String(m.nameTeam1))?.form ?? 'unknown';
          (m as any).formTeam2 = cachedForm.data.get(String(m.nameTeam2))?.form ?? 'unknown';
        }
      }

      // Compute or refresh forms
      if (!cachedForm || Date.now() - cachedForm.ts > 60_000) {
        const allTeams = new Set<string>();
        for (const m of filtered) {
          if (m.nameTeam1) allTeams.add(String(m.nameTeam1));
          if (m.nameTeam2) allTeams.add(String(m.nameTeam2));
        }
        const teams = [...allTeams];

        if (!cachedForm) {
          // Cold start — await computation so the response includes form data
          try {
            const formMap = await batchComputeTeamForms(teams, game);
            teamFormCache.set(game, { data: formMap, ts: Date.now() });
            for (const m of filtered) {
              (m as any).formTeam1 = formMap.get(String(m.nameTeam1))?.form ?? 'unknown';
              (m as any).formTeam2 = formMap.get(String(m.nameTeam2))?.form ?? 'unknown';
            }
            console.log(`[${prefix}Matches] Forms computed & cached for ${formMap.size} teams`);
          } catch (err) {
            console.error(`[${prefix}Matches] Initial form computation failed:`, (err as Error).message);
          }
        } else {
          // Stale cache — refresh in background, don't delay response
          batchComputeTeamForms(teams, game).then(formMap => {
            teamFormCache.set(game, { data: formMap, ts: Date.now() });
            console.log(`[${prefix}Matches] Forms refreshed for ${formMap.size} teams`);
          }).catch(err => {
            console.error(`[${prefix}Matches] Form refresh failed:`, (err as Error).message);
          });
        }
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

  // ── POST /team-forms — compute form stability for a list of team names ──
  router.post('/team-forms', async (c) => {
    try {
      const body = await c.req.json();
      const teams: string[] = Array.isArray(body.teams) ? body.teams : [];
      if (teams.length === 0) {
        return c.json({ error: 'No team names provided' }, 400);
      }
      const formMap = await batchComputeTeamForms(teams, game);
      const result: Record<string, TeamFormResult> = {};
      for (const [name, form] of formMap) {
        result[name] = form;
      }
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${prefix}Matches] Team forms failed:`, message);
      return c.json({ error: message }, 500);
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

  // ── GET /logo/cached/:gameSlug/:filename — serve locally cached logos ──
  // On cache miss, downloads from tips.gg CDN via Puppeteer and caches for next time.
  router.get('/logo/cached/:gameSlug/:filename', async (c) => {
    const filename = c.req.param('filename');
    const gameSlug = c.req.param('gameSlug');
    if (!filename || !gameSlug) return c.json({ error: 'Not found' }, 404);

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const logoDir = join(process.cwd(), '.cache', 'logos', gameSlug);
    const cacheFile = join(logoDir, safeName);

    // Serve from cache if fresh
    if (existsSync(cacheFile)) {
      const stat = statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < 86400_000) {
        const buf = readFileSync(cacheFile);
        const ext = safeName.split('.').pop() || 'png';
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

    // Cache miss — try downloading from tips.gg CDN via Puppeteer.
    // tips.gg CDN filenames are unpredictable — try stripping game suffix,
    // adding -csgo/-cs2/-dota2 variants, swapping underscores/hyphens.
    const bare = filename.replace(/\.(png|svg|webp)$/i, '');
    const noGame = bare.replace(/-(csgo|cs2|dota2)$/i, '');
    const candidates = [
      filename,
      `${noGame}.png`,
      `${noGame}-csgo.png`,
      `${noGame}-cs2.png`,
      `${noGame}-dota2.png`,
      `${noGame.replace(/_/g, '-')}.png`,
      `${noGame.replace(/_/g, '-')}-csgo.png`,
      `${noGame.replace(/_/g, '-')}-cs2.png`,
      `${noGame.replace(/-/g, '_')}.png`,
    ];
    const uniqueNames = [...new Set(candidates)];

    let buf: Buffer | null = null;
    if (!existsSync(logoDir)) mkdirSync(logoDir, { recursive: true });

    // Try each CDN filename variant through the dedup download queue
    for (const candidate of uniqueNames) {
      try {
        const cdnUrl = `https://files.tips.gg/static/image/teams/${candidate}`;
        buf = await fetchAndCacheLogo(cdnUrl, cacheFile);
        if (buf) {
          if (candidate !== filename) {
            console.log(`[logo] ${filename} → found at ${candidate}`);
          }
          break;
        }
      } catch { /* try next variant */ }
    }

    if (buf) {
      const ext = safeName.split('.').pop() || 'png';
      const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return new Response(buf, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return c.json({ error: 'Not found' }, 404);
  });

  // ── GET /logo/local/:filename — serve locally stored team logos ──
  router.get('/logo/local/:filename', (c) => {
    const filename = c.req.param('filename');
    if (!filename) return c.json({ error: 'Not found' }, 404);

    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const localDir = getLocalLogoDir();
    const filePath = join(localDir, filename);

    if (existsSync(filePath)) {
      const ext = filename.split('.').pop()?.toLowerCase() || 'png';
      const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return c.json({ error: 'Not found' }, 404);
  });

  // ── GET /logo/dota2local/:filename — serve locally stored Dota2 logos ──
  router.get('/logo/dota2local/:filename', (c) => {
    const filename = c.req.param('filename');
    if (!filename) return c.json({ error: 'Not found' }, 404);

    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const dota2Dir = getDota2LogoDir();
    const filePath = join(dota2Dir, filename);

    if (existsSync(filePath)) {
      const ext = filename.split('.').pop()?.toLowerCase() || 'png';
      const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return c.json({ error: 'Not found' }, 404);
  });

  // ── GET /logo/tipsgg/:game/:filename — serve locally-downloaded tips.gg logos ──
  router.get('/logo/tipsgg/:game/:filename', (c) => {
    const game = c.req.param('game');
    const filename = c.req.param('filename');
    if (!game || !filename) return c.json({ error: 'Not found' }, 404);

    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filePath = join(process.cwd(), '.cache', 'logos', 'tipsgg', game, filename);

    if (existsSync(filePath)) {
      const ext = filename.split('.').pop()?.toLowerCase() || 'png';
      const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return c.json({ error: 'Not found' }, 404);
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
      // Return 404 — frontend's img.onError will show placeholder SVG
      return c.json({ error: 'Not found' }, 404);
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
      return c.json({ error: 'Not found' }, 404);
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
