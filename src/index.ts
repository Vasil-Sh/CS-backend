import 'dotenv/config';
import './utils/env'; // Fail-fast env validation

// ═══════════════════════════════════════════
// MatchIQ Backend API Server
// ═══════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { authMiddleware } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { rateLimiterMiddleware } from './middleware/rateLimiter';
import { bodyLimit } from './middleware/bodyLimit';
import { securityHeaders } from './middleware/securityHeaders';
import { numericNormalizer } from './middleware/numericNormalizer';
import { db, pool } from './db/client';
import { sql } from 'drizzle-orm';

import authRoutes from './routes/auth';
import betRoutes from './routes/bets';
import goalRoutes from './routes/goals';
import bankrollRoutes from './routes/bankroll';
import strategyRoutes from './routes/strategies';
import aiRoutes from './routes/ai';
import telegramRoutes from './routes/telegram';
import telegramGroupRoutes from './routes/telegramGroups';
import telegramBetsRoutes from './routes/telegramBets';
import matchRatingsRoutes from './routes/matchRatings';
import tiltBlocksRoutes from './routes/tiltBlocks';
import userPrefsRoutes from './routes/userPrefs';
import riskyTeamRoutes from './routes/riskyTeams';
import adminRoutes from './routes/admin';
import adminStatsRoutes from './routes/adminStats';
import dota2MatchesRoutes from './routes/dota2Matches';
import cs2MatchesRoutes from './routes/cs2Matches';
import publicProfileRoutes from './routes/publicProfile';
import matchesHistoryRoutes from './routes/matchesHistory';
import { closeBrowser } from './services/tipsggScraper';
import { fetchDota2Matches, fetchCs2Matches, fetchTodayMatches } from './services/tipsggScraper';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { liveScoresStore } from './services/liveScoresStore';
import { writeFileCacheInternal } from './services/createMatchesRouter';
import { upsertMatchHistoryBatch } from './services/matchHistoryService';
import { fetchCstestMatches, cstestLiveScoresStore } from './services/hltv/cstestClient';
import { scrapeHltvRankingLogos } from './services/hltv/hltvRankingScraper';
import { buildLocalLogoStore } from './services/logoStore';
import { runWithRequestContext } from './utils/requestContext';
import { AppError } from './utils/AppError';

const app = new Hono();

// ── Global middleware ──
// CORS MUST be first — handles preflight before other middleware
app.use('*', async (c, next) => runWithRequestContext(() => next()));
app.use('*', cors({
  origin: (origin) => {
    const isDev = process.env.NODE_ENV !== 'production';
    const allowed = isDev
      ? ['http://localhost:5173','http://localhost:5174','http://localhost:5175','http://localhost:5176','http://localhost:5199','http://localhost:3001','https://matchiq.vercel.app']
      : (process.env.CORS_ORIGINS || 'https://matchiq.pro,https://www.matchiq.pro').split(',');
    if (!origin) return isDev ? allowed[0] : allowed[0];
    // Allow all vercel.app subdomains — only in dev/preview
    if (isDev && origin.endsWith('.vercel.app')) return origin;
    if (allowed.some(a => origin.startsWith(a))) return origin;
    return null;
  },
  credentials: true,
}));
app.use('*', compress());

// ── CSRF protection ──
// Validates Origin/Referer on state-changing requests (POST/PUT/DELETE/PATCH).
// Non-browser clients (no Origin header) are allowed — they can't be CSRF attacks.
// GET/HEAD/OPTIONS are never checked — they don't modify state.
app.use('*', csrf({
  origin: (origin) => {
    if (!origin) return true; // non-browser: curl, mobile app, server-to-server
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) {
      // Dev: localhost + vercel previews
      return origin.startsWith('http://localhost') || origin.endsWith('.vercel.app');
    }
    // Prod: matchiq.pro only
    return origin === 'https://matchiq.pro' || origin === 'https://www.matchiq.pro';
  },
}));

app.use('*', securityHeaders);
app.use('*', loggerMiddleware);
app.use('*', rateLimiterMiddleware);
app.use('*', bodyLimit(1_000_000)); // 1MB max body
app.use('*', authMiddleware);

// ── Convert ALL string numbers to real numbers in JSON responses ──
// Skips responses smaller than 1KB (auth, health, tokens etc.) to avoid
// double-serialization overhead on every tiny request.
// TODO: migrate to Drizzle .$type<number>() casts to remove this entirely.
app.use('*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return;
  const cl = c.res.headers.get('Content-Length');
  if (cl && parseInt(cl, 10) < 1024) return; // skip sub-1KB responses
  const original = c.res.clone();
  try {
    const body = await original.json();
    const normalized = numericNormalizer(body);
    c.res = new Response(JSON.stringify(normalized), {
      status: c.res.status,
      headers: c.res.headers,
    });
  } catch {
    // pass through
  }
});

// ── Health check (reuses shared pool, no leak) ──
app.get('/api/health', async (c) => {
  let dbStatus = 'unknown';
  try {
    const result = await db.execute(sql`SELECT 1`);
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }
  return c.json({
    status: 'ok',
    database: dbStatus,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── API Docs (embedded TS — no file I/O) ──
import openapiSpec from './openapiEmbedded';

app.get('/api/docs.json', (c) => c.json(openapiSpec));

// Swagger UI
import fs from 'node:fs';
import path from 'node:path';

let _swaggerHtml = '';
try {
  _swaggerHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'swagger.html'), 'utf-8');
} catch {
  try {
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    _swaggerHtml = fs.readFileSync(path.join(__dirname, 'swagger.html'), 'utf-8');
  } catch {
    console.warn('⚠️ swagger.html not found');
  }
}

if (_swaggerHtml) {
  const isDev = process.env.NODE_ENV !== 'production';
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  app.get('/api/docs', (c) => {
    if (!isDev && adminPassword) {
      const key = c.req.query('key');
      if (key !== adminPassword) {
        throw new AppError('Access denied. Use ?key=<password>', 403, 'ACCESS_DENIED');
      }
    }
    return c.html(_swaggerHtml);
  });

  console.log(
    `📖 API Docs: http://localhost:${process.env.PORT || '3001'}/api/docs${
      !isDev ? '?key=<ADMIN_PASSWORD>' : ''
    }`
  );
}

// ── API v1 routes ──
const v1 = new Hono();
v1.route('/auth', authRoutes);
v1.route('/bets', betRoutes);
v1.route('/goals', goalRoutes);
v1.route('/bankroll', bankrollRoutes);
v1.route('/strategies', strategyRoutes);
v1.route('/ai', aiRoutes);
v1.route('/telegram', telegramRoutes);
v1.route('/telegram-groups', telegramGroupRoutes);
v1.route('/telegram-bets', telegramBetsRoutes);
v1.route('/match-ratings', matchRatingsRoutes);
v1.route('/tilt-blocks', tiltBlocksRoutes);
v1.route('/user', userPrefsRoutes);
v1.route('/risky-teams', riskyTeamRoutes);
v1.route('/dota2-matches', dota2MatchesRoutes);
v1.route('/cs2-matches', cs2MatchesRoutes);
v1.route('/matches-history', matchesHistoryRoutes);
v1.route('', adminRoutes);
v1.route('', adminStatsRoutes);
v1.route('/public-profile', publicProfileRoutes);

app.route('/api/v1', v1);

// ── Also mount at /api for backward compat (frontend uses /api/*) ──
app.route('/api', v1);

// ── Global error handler ──
app.onError((err, c) => {
  if (err instanceof AppError && err.isOperational) {
    // Operational: show the message to the client, log as warn
    console.warn(`[AppError] ${err.code} — ${err.message}`);
    return c.json(err.toJSON(), err.httpStatus as 400 | 401 | 403 | 404 | 429);
  }
  // Programmer error / unknown: mask the message, log full stack
  console.error('[Error]', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
});

// ── 404 handler ──
app.notFound((c) => {
  throw new AppError(`Not found: ${c.req.method} ${c.req.path}`, 404, 'NOT_FOUND');
});

// ── Start ──
const port = parseInt(process.env.PORT || '3001', 10);

console.log(`🚀 MatchIQ API server starting on http://localhost:${port}`);

// ── Cache warmup: pre-fetch Dota2 matches in background ──
setTimeout(() => {
  fetchDota2Matches()
    .then(matches => {
      writeFileCacheInternal(matches, join(process.cwd(), '.cache', 'dota2_matches.json'));
      console.log(`[warmup] Dota2 cache primed: ${matches.length} matches`);
    })
    .catch(e => console.warn('[warmup] Dota2 fetch failed:', (e as Error).message));
}, 500);

// ── Cache warmup: pre-fetch CS2 matches (cstest + tips.gg merged) in background ──
setTimeout(async () => {
  try {
    const [cstestMatches, tipsggMatches] = await Promise.allSettled([
      fetchCstestMatches(),
      fetchCs2Matches(),
    ]);
    const cstest = cstestMatches.status === 'fulfilled' ? cstestMatches.value : [];
    const tipsgg = tipsggMatches.status === 'fulfilled' ? tipsggMatches.value : [];

    // Merge: cstest primary, tips.gg enriches with tournament/coefficients
    const merged = new Map<string, any>();
    for (const m of cstest) merged.set(m.id, m);
    for (const tm of tipsgg) {
      const existing = merged.get(tm.id);
      if (existing) {
        if (!existing.tournament && tm.tournament) existing.tournament = tm.tournament;
        if (!existing.stage && tm.stage) existing.stage = tm.stage;
        if (existing.coeff1 == null && tm.coeff1 != null) existing.coeff1 = tm.coeff1;
        if (existing.coeff2 == null && tm.coeff2 != null) existing.coeff2 = tm.coeff2;
      } else {
        // Fuzzy dedup: same date + normalized team names → same match
        const allExisting = [...merged.values()];
        const fuzzyDupe = allExisting.find((m: any) =>
          m.date === tm.date &&
          (normalizeTeam(m.nameTeam1) === normalizeTeam(tm.nameTeam1) &&
           normalizeTeam(m.nameTeam2) === normalizeTeam(tm.nameTeam2)) ||
          (normalizeTeam(m.nameTeam1) === normalizeTeam(tm.nameTeam2) &&
           normalizeTeam(m.nameTeam2) === normalizeTeam(tm.nameTeam1))
        );
        if (fuzzyDupe) {
          if (!fuzzyDupe.tournament && tm.tournament) fuzzyDupe.tournament = tm.tournament;
          if (!fuzzyDupe.stage && tm.stage) fuzzyDupe.stage = tm.stage;
          if (fuzzyDupe.coeff1 == null && tm.coeff1 != null) fuzzyDupe.coeff1 = tm.coeff1;
          if (fuzzyDupe.coeff2 == null && tm.coeff2 != null) fuzzyDupe.coeff2 = tm.coeff2;
          continue;
        }
        merged.set(tm.id, tm);
      }
    }
    writeFileCacheInternal([...merged.values()], join(process.cwd(), '.cache', 'cs2_matches.json'));
    console.log(`[warmup] CS2 cache primed: ${merged.size} matches (cstest: ${cstest.length}, +tips.gg)`);
  } catch (err) {
    console.warn('[warmup] CS2 fetch failed:', (err as Error).message);
  }
}, 1000);

// ── Live scores background workers ──
// Dota2: poll tips.gg every 7s (HTTP fetch, fast)
// CS2: poll cstest API every 7s (matches the cstest match list directly)
liveScoresStore.startBackgroundWorker(7_000);
cstestLiveScoresStore.startBackgroundWorker(7_000);

// ── HLTV ranking logo scraper — run once at startup ──
// Fills the in-memory logo map for cstestClient to use as fallback
// when a team has no logo from cstest CDN (fallback.webp → null → HLTV CDN)
setTimeout(() => {
  scrapeHltvRankingLogos().catch(e =>
    console.warn('[hltvRanking] Startup scrape failed:', (e as Error).message)
  );
}, 3_000);

// ── Local logo extraction — extract cs2_icon.zip on first startup ──
setTimeout(() => {
  const zipPath = join(process.cwd(), 'cs2_icon.zip');
  const extractDir = join(process.cwd(), '.cache', 'logos', 'local');

  if (!existsSync(zipPath)) {
    console.log('[logoStore] cs2_icon.zip not found — skipping (place it in backend/)');
    buildLocalLogoStore(); // scan whatever is already there
    return;
  }

  if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true });

  try {
    // Only extract if directory has fewer than 10 files (first run)
    const existing = readdirSync(extractDir);
    if (existing.length > 10) {
      console.log(`[logoStore] ${existing.length} local logos already extracted`);
      buildLocalLogoStore();
      return;
    }

    console.log('[logoStore] Extracting cs2_icon.zip...');
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'pipe' });
    const count = readdirSync(extractDir).length;
    console.log(`[logoStore] Extracted ${count} files`);
    buildLocalLogoStore();
  } catch (err) {
    console.warn('[logoStore] Extraction failed:', (err as Error).message);
    buildLocalLogoStore(); // try anyway (maybe files already there)
  }
}, 4_000);

// ── Incremental refresh: fast HTTP fetch of today's page every 60s ──
// Merges new matches & scores into the file cache without a full 8-day scrape.
// This covers: new matches appearing on today's listing, score changes, status transitions.

/**
 * Normalize a team name for fuzzy matching: lowercase, strip suffixes like
 * "esports"/"gaming", remove non-alphanumeric chars.
 * "UNiTY esports" and "UNiTY" both → "unity"
 */
function normalizeTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(esports|gaming|team|academy|acad)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Check if two matches are likely the same: same date + fuzzy team name match.
 */
function isSameMatch(a: { date: string; nameTeam1: string; nameTeam2: string },
                     b: { date: string; nameTeam1: string; nameTeam2: string }): boolean {
  if (a.date !== b.date) return false;
  const a1 = normalizeTeam(a.nameTeam1);
  const a2 = normalizeTeam(a.nameTeam2);
  const b1 = normalizeTeam(b.nameTeam1);
  const b2 = normalizeTeam(b.nameTeam2);
  // Same teams in same order, OR swapped
  return (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1);
}

function startIncrementalRefresh(game: 'dota2' | 'cs2', cacheFile: string, tag: string): void {
  // For CS2, cstest is primary — never add new matches from tips.gg (prevents duplicates).
  // Only update scores & status for existing matches.
  const isPrimarySource = game === 'cs2';

  const interval = setInterval(async () => {
    try {
      const todayMatches = await fetchTodayMatches(game);
      if (!todayMatches || todayMatches.length === 0) return;

      // Read existing cache
      let existing: Record<string, any>[] = [];
      if (existsSync(cacheFile)) {
        try {
          const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
          existing = raw.data || [];
        } catch { /* stale cache */ }
      }

      // Build lookup: id → match + normalized name → match for fuzzy dedup
      const existingMap = new Map(existing.map((m: any) => [m.id, m]));
      const prevCount = existing.length; // track before merge to prevent shrinking
      const fuzzyIndex: Map<string, { match: any; namePair: string }> = new Map();
      for (const m of existing) {
        const pair = `${normalizeTeam(m.nameTeam1)}|||${normalizeTeam(m.nameTeam2)}`;
        fuzzyIndex.set(pair, { match: m, namePair: pair });
      }

      let updates = 0;
      let added = 0;
      let skippedDupes = 0;
      let skippedUnmatched = 0;
      const newlyFinished: any[] = [];

      for (const tm of todayMatches) {
        // ── Try exact ID match first ──
        const prev = existingMap.get(tm.id);
        if (prev) {
          if (prev.status !== 'finished') {
            if (tm.score1 != null) prev.score1 = tm.score1;
            if (tm.score2 != null) prev.score2 = tm.score2;
            if (tm.status !== 'upcoming') prev.status = tm.status;
            if (prev.status === 'finished') newlyFinished.push(prev);
            updates++;
          }
          continue;
        }

        // ── Fuzzy dedup: check normalized team names ──
        const fwd = `${normalizeTeam(tm.nameTeam1)}|||${normalizeTeam(tm.nameTeam2)}`;
        const rev = `${normalizeTeam(tm.nameTeam2)}|||${normalizeTeam(tm.nameTeam1)}`;
        const fuzzyHit = fuzzyIndex.get(fwd) || fuzzyIndex.get(rev);
        if (fuzzyHit) {
          if (fuzzyHit.match.status !== 'finished') {
            if (tm.score1 != null) fuzzyHit.match.score1 = tm.score1;
            if (tm.score2 != null) fuzzyHit.match.score2 = tm.score2;
            if (tm.status !== 'upcoming') fuzzyHit.match.status = tm.status;
            if (fuzzyHit.match.status === 'finished') newlyFinished.push(fuzzyHit.match);
            updates++;
          }
          skippedDupes++;
          continue;
        }

        // ── New match — only add if this is the Dota2 primary source ──
        if (!isPrimarySource) {
          existing.push(tm as any);
          existingMap.set(tm.id, tm as any);
          added++;
        } else {
          skippedUnmatched++;
        }
      }

      // ── Persist newly-finished matches to history DB ──
      // Incremental refresh detects score changes that mean a match just ended.
      if (newlyFinished.length > 0) {
        const historyEntries = newlyFinished.map(m => ({
          id: m.id,
          game,
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
        upsertMatchHistoryBatch(historyEntries).catch(e =>
          console.error(`[incr:${tag}] History sync failed:`, (e as Error).message)
        );
      }

      // ── Write back only if we didn't shrink the cache ──
      // Prevents incremental (today-only 3 matches) from overwriting
      // a full 8-day warmup result (31 matches).
      if (updates > 0 || added > 0) {
        if (existing.length < prevCount) {
          console.log(`[incr:${tag}] Skipped write (would shrink ${prevCount}→${existing.length})`);
        } else {
          writeFileCacheInternal(existing, cacheFile);
          const parts: string[] = [];
          if (added > 0) parts.push(`+${added} new`);
          if (skippedDupes > 0) parts.push(`${skippedDupes} deduped`);
          if (skippedUnmatched > 0) parts.push(`${skippedUnmatched} unmatched`);
          if (updates > 0) parts.push(`${updates} updated`);
          if (parts.length > 0) {
            console.log(`[incr:${tag}] ${parts.join(', ')} (${existing.length} total)`);
          }
        }
      }
    } catch (err) {
      // Silent — incremental refresh is best-effort
    }
  }, 60_000);
  if ('unref' in interval) (interval as NodeJS.Timeout).unref();
  console.log(`[incr:${tag}] Incremental refresh worker started (60s)` + (isPrimarySource ? ' (updates-only)' : ''));
}

// Start incremental refresh for both games (after warmup delay)
setTimeout(() => {
  startIncrementalRefresh('dota2', join(process.cwd(), '.cache', 'dota2_matches.json'), 'dota2');
  startIncrementalRefresh('cs2', join(process.cwd(), '.cache', 'cs2_matches.json'), 'cs2');
}, 5_000);

// ── Graceful shutdown ──
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing DB pool:', err);
  }
  closeBrowser();
  console.log('✅ Puppeteer browser closed');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

serve({
  fetch: app.fetch,
  port,
});

