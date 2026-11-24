import { telegramAvatarRoutes } from './routes/telegramAvatar';
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
import { adminAudit } from './middleware/adminAudit';
import { loggerMiddleware } from './middleware/logger';
import { rateLimiterMiddleware } from './middleware/rateLimiter';
import { bodyLimit } from './middleware/bodyLimit';
import { securityHeaders } from './middleware/securityHeaders';
import { numericNormalizer } from './middleware/numericNormalizer';
import { db, pool } from './db/client';
import { sql } from 'drizzle-orm';
import { bootstrapOwner } from './services/bootstrapOwner';
import { logSchemaCheck } from './services/schemaCheck';
import { loadParserPauses } from './services/circuitBreaker';

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
import bannerRoutes from './routes/banners';
import adminRoutes from './routes/admin';
import adminStatsRoutes from './routes/adminStats';
import adminUsersRoutes from './routes/adminUsers';
import adminInsightsRoutes from './routes/adminInsights';
import adminOperationsRoutes from './routes/adminOperations';
import adminParsersRoutes from './routes/adminParsers';
import adminAdsRoutes from './routes/adminAds';
import adminTelegramGroupsRoutes from './routes/adminTelegramGroups';
import adminSupportRoutes from './routes/adminSupport';
import adminSubscriptionsRoutes from './routes/adminSubscriptions';
import adminMatchesRoutes from './routes/adminMatches';
import { startProExpiry } from './services/subscriptionActions';
import settingsRoutes from './routes/settings';
import dota2MatchesRoutes from './routes/dota2Matches';
import cs2MatchesRoutes from './routes/cs2Matches';
import publicProfileRoutes from './routes/publicProfile';
import matchesHistoryRoutes from './routes/matchesHistory';
import { fetchDota2Matches, fetchCs2Matches, fetchTodayMatches, feedPaused, teamKey } from './services/matchFeed';
import { diffMatch, flushChanges, recordChanges } from './services/matchChanges';
import { saveClosing } from './services/closingLines';
import { trackFeed } from './services/feedStats';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { writeFileCacheInternal } from './services/createMatchesRouter';
import { upsertMatchHistoryBatch } from './services/matchHistoryService';
import { buildLocalLogoStore, loadTipsggLogos, buildDota2LocalStore, extractLogoPacks } from './services/logoStore';
import { hydrateTeamLogos } from './services/teamLogos';
import { startMaintenance } from './services/maintenance';
import { restoreDurableFiles, startDurableSync, syncDurableFiles } from './services/durableFiles';
import { captureServerErrors, flushServerErrors, recordServerError } from './services/serverErrors';
import { citoReady } from './services/citoFeed';
import { pandascoreReady } from './services/pandascoreFeed';
import { knownParsers } from './routes/adminParsers';
import { listCircuits, pauseInfo } from './services/circuitBreaker';
import { runWithRequestContext } from './utils/requestContext';
import { AppError } from './utils/AppError';
import { allowedOrigins, isAllowedOrigin } from './utils/allowedOrigins';

// ── Server errors → Postgres for the admin (console.error, unhandled rejections, API 500s) ──
captureServerErrors();

// ── Caches wiped by a deploy: put the saved copies back before anything reads them (≤10 s, then go on without) ──
await Promise.race([restoreDurableFiles(), new Promise((r) => setTimeout(r, 10_000))]);
startDurableSync();
startMaintenance();

const app = new Hono();

// ── Global middleware ──
// CORS MUST be first — handles preflight before other middleware
app.use('*', async (c, next) => runWithRequestContext(() => next()));
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return allowedOrigins()[0];
    return isAllowedOrigin(origin) ? origin : null;
  },
  credentials: true,
}));
app.use('*', compress());

// ── CSRF protection ──
// Validates Origin/Referer on state-changing requests (POST/PUT/DELETE/PATCH).
// Non-browser clients (no Origin header) are allowed — they can't be CSRF attacks.
// GET/HEAD/OPTIONS are never checked — they don't modify state.
app.use('*', csrf({
  // Same allow-list as CORS (CORS_ORIGINS in production).
  origin: (origin) => !origin || isAllowedOrigin(origin),
}));

app.use('*', securityHeaders);
app.use('*', loggerMiddleware);
app.use('*', rateLimiterMiddleware);
app.use('*', bodyLimit(2_100_000)); // 2.1MB max body (1.5MB file + base64 overhead)
app.use('*', authMiddleware);
app.use('*', adminAudit);

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
// For an uptime monitor (UptimeRobot etc.): 503 when the database is down; «degraded» when a match source is down.
app.get('/api/health', async (c) => {
  let dbStatus = 'unknown';
  const t0 = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }
  const circuits = listCircuits();
  const parsers = Object.fromEntries(knownParsers().map((n) => [n, pauseInfo(n) ? 'paused' : circuits.find((x) => x.name === n)?.open ? 'down' : 'ok']));
  const down = Object.values(parsers).filter((s) => s === 'down').length;
  const status = dbStatus !== 'connected' ? 'down' : down ? 'degraded' : 'ok';
  return c.json({
    status,
    database: dbStatus,
    dbMs: Date.now() - t0,
    parsers,
    uptime: Math.floor(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    version: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || undefined,
    timestamp: new Date().toISOString(),
  }, status === 'down' ? 503 : 200);
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
v1.route('/banners', bannerRoutes);
v1.route('/telegram-avatar', telegramAvatarRoutes);
v1.route('/dota2-matches', dota2MatchesRoutes);
v1.route('/cs2-matches', cs2MatchesRoutes);
v1.route('/matches-history', matchesHistoryRoutes);
v1.route('', adminRoutes);
v1.route('', adminStatsRoutes);
v1.route('', adminUsersRoutes);
v1.route('', adminInsightsRoutes);
v1.route('', adminOperationsRoutes);
v1.route('', adminParsersRoutes);
v1.route('', adminAdsRoutes);
v1.route('', adminTelegramGroupsRoutes);
v1.route('', adminSupportRoutes);
v1.route('', adminSubscriptionsRoutes);
v1.route('', adminMatchesRoutes);
v1.route('', settingsRoutes);
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
  // Programmer error / unknown: mask the message, log full stack (kept for the admin with the route; stderr directly — not twice via console.error)
  recordServerError('api', err.message, err.stack || '', `${c.req.method} ${c.req.path}`, 500);
  process.stderr.write(`[Error] ${err.message} ${err.stack?.split('\n').slice(0, 3).join(' | ') || ''}\n`);
  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
});

// ── 404 handler ──
app.notFound((c) => {
  throw new AppError(`Not found: ${c.req.method} ${c.req.path}`, 404, 'NOT_FOUND');
});

// ── Start ──
const port = parseInt(process.env.PORT || '3001', 10);

console.log(`🚀 MatchIQ API server starting on http://localhost:${port}`);

// ── One-off owner bootstrap (only when BOOTSTRAP_OWNER_USERNAME is set) ──
void bootstrapOwner();
void logSchemaCheck();
void loadParserPauses();

// ── Cache warmup: pre-fetch Dota2 matches in background ──
// Uses tips.gg scraper.
//
// SKIP warmup if today's cache already exists on disk — incremental refresh
// will fill any gaps. Avoids a full 8-day scrape on every restart.
setTimeout(async () => {
  const cacheFile = join(process.cwd(), '.cache', 'dota2_matches.json');
  try {
    // Check if today's cache already exists (from previous run)
    if (existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
        const today = new Date().toISOString().split('T')[0];
        if (raw.day === today && (raw.data?.length || 0) > 0) {
          console.log(`[warmup] Dota2 cache exists (${raw.data.length} matches, today) — skipping warmup`);
          return;
        }
      } catch { /* corrupt cache — fetch fresh */ }
    }

    const tipsggMatches = await fetchDota2Matches();
    if (tipsggMatches.length > 0) {
      writeFileCacheInternal(tipsggMatches, cacheFile);
      persistFinishedToHistory(tipsggMatches, 'dota2', 'warmup:dota2');
      console.log(`[warmup] Dota2 cache primed: ${tipsggMatches.length} matches (tips.gg)`);
      return;
    }
    console.warn('[warmup] tips.gg returned 0 Dota2 matches');
  } catch (e) {
    console.warn('[warmup] Dota2 tips.gg fetch failed:', (e as Error).message);
  }
}, 500);

// ── Helper: persist finished matches from data array to history DB ──
function persistFinishedToHistory(
  matches: any[],
  game: 'dota2' | 'cs2',
  tag: string,
): void {
  const finished = matches
    .filter((m) => m.status === 'finished')
    .map((m) => ({
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
  if (finished.length > 0) {
    upsertMatchHistoryBatch(finished).catch((e) =>
      console.error(`[${tag}] History sync failed:`, (e as Error).message),
    );
  }
}

// ── Seed: persist all finished matches from existing caches to DB on startup ──
setTimeout(() => {
  for (const [file, game] of [
    [join(process.cwd(), '.cache', 'dota2_matches.json'), 'dota2'] as const,
    [join(process.cwd(), '.cache', 'cs2_matches.json'), 'cs2'] as const,
  ] as const) {
    try {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      const items: any[] = raw.data || [];
      persistFinishedToHistory(items, game, `seed:${String(game)}`);
    } catch { /* best effort */ }
  }
}, 3_000);

// ── Dedup existing caches on startup ──
function dedupCache(cacheFile: string, tag: string): void {
  try {
    if (!existsSync(cacheFile)) return;
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    const items: any[] = raw.data || [];
    if (items.length === 0) return;

    const seen = new Map<string, any>();
    let removed = 0;
    for (const m of items) {
      // Try exact ID first
      if (seen.has(m.id)) { removed++; continue; }
      // Fuzzy: same date + same normalized teams → duplicate
      const isDup = [...seen.values()].some((s: any) => isSameMatch(s, m));
      if (isDup) { removed++; continue; }
      seen.set(m.id, m);
    }
    if (removed > 0) {
      writeFileCacheInternal([...seen.values()], cacheFile);
      console.log(`[dedup] ${tag}: removed ${removed} duplicates (${seen.size} kept)`);
    }
  } catch { /* best effort */ }
}

setTimeout(() => {
  dedupCache(join(process.cwd(), '.cache', 'dota2_matches.json'), 'dota2');
  dedupCache(join(process.cwd(), '.cache', 'cs2_matches.json'), 'cs2');
}, 2_000);

/** Cito / PandaScore matches cached earlier that the new feed no longer has (Liquipedia lists them now, under its own id) — dropped,
 *  so the same match is not shown twice. Older than 2 days stay: Cito's lists no longer reach that far back. */
function dropCitoGone(cached: any[], fresh: any[]): any[] {
  const ids = new Set(fresh.map((m: any) => m.id));
  const from = Date.now() - 2 * 86_400_000;
  const gone = (m: any, prefix: string, ready: boolean) => ready && String(m.id).startsWith(prefix) && !ids.has(m.id) && Date.parse(m.startDate) >= from;
  return cached.filter((m: any) => !gone(m, 'ct-', citoReady()) && !gone(m, 'ps-', pandascoreReady()));
}

// ── Cache warmup: CS2 schedule (Liquipedia + OddsPapi) merged into today's cache, never shrinking it ──
setTimeout(async () => {
  const cacheFile = join(process.cwd(), '.cache', 'cs2_matches.json');
  try {
    const fresh = await fetchCs2Matches();
    let existingArr: any[] = [];
    if (existsSync(cacheFile)) {
      try { existingArr = JSON.parse(readFileSync(cacheFile, 'utf-8')).data || []; } catch { /* ignore corrupt cache */ }
    }
    // Liquipedia gives the schedule: drop the OddsPapi stand-ins cached before it (same matches, other ids)
    if (fresh.some((m: any) => String(m.id).startsWith('lp-'))) existingArr = existingArr.filter((m: any) => !String(m.id).startsWith('op-'));
    existingArr = dropCitoGone(existingArr, fresh);
    const merged = new Map<string, any>(existingArr.map((m: any) => [m.id, m]));
    for (const m of fresh) merged.set(m.id, merged.has(m.id) ? { ...merged.get(m.id), ...m } : m);
    const mergedArr = [...merged.values()];
    if (mergedArr.length === 0) {
      console.warn('[warmup] CS2: no matches — keeping existing cache untouched');
      return;
    }
    writeFileCacheInternal(mergedArr, cacheFile);
    persistFinishedToHistory(mergedArr, 'cs2', 'warmup:cs2');
    console.log(`[warmup] CS2 cache primed: ${merged.size} matches`);
  } catch (err) {
    console.warn('[warmup] CS2 fetch failed:', (err as Error).message);
  }
}, 1000);

// ── Live scores workers REMOVED ──
// No more live polling. Matches are shown as a static list sorted by time.
// Incremental refresh (every 120s) keeps scores current in the file cache.
// Users click through to HLTV/tips.gg for real-time scores.
//
// Now: 0 requests for live scores. Only warmup + incremental refresh.

console.log('[live] Live score polling disabled — static match list mode');



// ── Admin-uploaded team logos (index in memory) ──
hydrateTeamLogos();

// ── Team logo packs: unpack cs2_logos.zip / dota2_logos.zip on start, then index them ──
setTimeout(() => {
  extractLogoPacks()
    .catch((e) => console.warn('[logoStore] packs:', (e as Error).message))
    .finally(() => { buildLocalLogoStore(); buildDota2LocalStore(); });
}, 4_000);

// ── Load tips.gg CDN logo map + scan local Dota2 logos ──
setTimeout(() => {
  loadTipsggLogos();
  buildDota2LocalStore();
}, 4_500);

// ── Incremental refresh: fast HTTP fetch of today's page every 60s ──
// Merges new matches & scores into the file cache without a full 8-day scrape.
// This covers: new matches appearing on today's listing, score changes, status transitions.

import { normalizeTeam, isSameMatch } from './utils/matchUtils.js';
import { validateScores, needsScoreBackfill } from './utils/scoreValidation.js';
import { isIdle, IDLE_POLL_MS } from './services/activityTracker.js';

const IDLE_BET_REFRESH_MS = 15 * 60_000;
let pendingCheck = { at: 0, yes: false };
/** A pending bet placed in the last 2 days (checked at most once a minute). */
async function hasRecentPendingBets(): Promise<boolean> {
  if (Date.now() - pendingCheck.at < 60_000) return pendingCheck.yes;
  try {
    const { rows } = await pool.query(`SELECT 1 FROM bets WHERE result = 'Pending' AND date >= CURRENT_DATE - 1 LIMIT 1`);
    pendingCheck = { at: Date.now(), yes: rows.length > 0 };
  } catch { pendingCheck = { at: Date.now(), yes: false }; }
  return pendingCheck.yes;
}

function startIncrementalRefresh(game: 'dota2' | 'cs2', cacheFile: string, tag: string): void {
  // One source for both games now (Liquipedia): new matches are added for CS2 too.
  const isPrimarySource = false;
  const ACTIVE_INTERVAL = 120_000;

  let lastIdleRun = 0;
  const tick = async () => {
    // No visitors: no refresh — except every 15 min while someone has a pending bet from the last 2 days,
    // so a match that ended at night is «finished» before the ticker drops it (the morning would find it stuck)
    if (feedPaused() || (isIdle() && (Date.now() - lastIdleRun < IDLE_BET_REFRESH_MS || !(await hasRecentPendingBets())))) {
      setTimeout(tick, IDLE_POLL_MS).unref();
      return;
    }
    if (isIdle()) lastIdleRun = Date.now();

    try {
      const todayMatches = await fetchTodayMatches(game);
      // nothing today (or the sources are down after a deploy): try again at the next tick — a bare «return» here
      // used to skip the scheduling below and stopped this refresh until the next restart
      if (!todayMatches || todayMatches.length === 0) { setTimeout(tick, ACTIVE_INTERVAL).unref(); return; }

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
          const before = { ...prev };
          // Enrich tournament/logo metadata from fresh tips.gg parse (best-effort)
          if (!prev.tournament && tm.tournament) prev.tournament = tm.tournament;
          // Fresh odds, opening/closing line, logos, stage/tier and a moved start time come in every 2 min, not only with the 4-h full refresh
          let enriched = false;
          for (const k of ['coeff1', 'coeff2', 'openCoeff1', 'openCoeff2', 'closeCoeff1', 'closeCoeff2', 'bestCoeff1', 'bestCoeff2', 'bestBook1', 'bestBook2', 'maps', 'oddsFixtureId'] as const) {
            const v = (tm as any)[k];
            if (v != null && JSON.stringify(v) !== JSON.stringify(prev[k])) { prev[k] = v; enriched = true; }
          }
          for (const k of ['logoTeam1', 'logoTeam2', 'tournamentPage', 'stage', 'tier', 'closedBy'] as const) {
            const v = (tm as any)[k];
            if (v && !prev[k]) { prev[k] = v; enriched = true; }
          }
          if (prev.status === 'upcoming' && tm.startDate && tm.startDate !== prev.startDate) { prev.startDate = tm.startDate; enriched = true; }
          if (enriched) updates++;
          if (!prev.stage && tm.stage) prev.stage = tm.stage;
          if (!prev.tournamentLogo && tm.tournamentLogo) prev.tournamentLogo = tm.tournamentLogo;
          if (prev.status !== 'finished') {
            // Validate scores before writing — reject impossible values
            const err = validateScores(tm.score1, tm.score2, tm.type || prev.type || '');
            if (!err) {
              if (tm.score1 != null) prev.score1 = tm.score1;
              if (tm.score2 != null) prev.score2 = tm.score2;
            }
            if (tm.status !== 'upcoming') prev.status = tm.status;
            if (prev.status === 'finished') newlyFinished.push(prev);
            updates++;
          } else if (tm.status === 'live' && !prev.score1 && !prev.score2) {
            // «finished» with no score while the source says live: a wrong finish from the old
            // «no score 30 min after start» rule — the match is back to live with the source's data
            prev.status = 'live';
            if (tm.score1 != null) prev.score1 = tm.score1;
            if (tm.score2 != null) prev.score2 = tm.score2;
            updates++;
          } else {
            // For finished matches: only update if the current score is suspicious
            // and today's page shows a better one (prevents good 2-1 → 1-0 regression).
            if (needsScoreBackfill(prev.score1, prev.score2, prev.type || '')) {
              const err = validateScores(tm.score1, tm.score2, prev.type || '');
              if (!err && tm.score1 != null) prev.score1 = tm.score1;
              if (!err && tm.score2 != null) prev.score2 = tm.score2;
              // Don't downgrade status from finished
            }
          }
          recordChanges(diffMatch(game, before, prev));
          continue;
        }

        // ── OddsPapi stand-in from a Liquipedia outage: the real Liquipedia match takes its place (no duplicate) ──
        if (String(tm.id).startsWith('lp-')) {
          const t = Date.parse(tm.startDate);
          const idx = existing.findIndex((m: any) => /^(op|ct|ps)-/.test(String(m.id)) && Math.abs(Date.parse(m.startDate) - t) < 6 * 3_600_000
            && ((teamKey(m.nameTeam1) === teamKey(tm.nameTeam1) && teamKey(m.nameTeam2) === teamKey(tm.nameTeam2)) || (teamKey(m.nameTeam1) === teamKey(tm.nameTeam2) && teamKey(m.nameTeam2) === teamKey(tm.nameTeam1))));
          if (idx >= 0) {
            existingMap.delete(existing[idx].id);
            existing[idx] = { ...tm, coeff1: tm.coeff1 ?? existing[idx].coeff1, coeff2: tm.coeff2 ?? existing[idx].coeff2 } as any;
            existingMap.set(tm.id, existing[idx]);
            updates++;
            continue;
          }
        }

        // ── Fuzzy dedup: check normalized team names ──
        const fwd = `${normalizeTeam(tm.nameTeam1)}|||${normalizeTeam(tm.nameTeam2)}`;
        const rev = `${normalizeTeam(tm.nameTeam2)}|||${normalizeTeam(tm.nameTeam1)}`;
        const fuzzyHit = fuzzyIndex.get(fwd) || fuzzyIndex.get(rev);
        if (fuzzyHit) {
          if (!fuzzyHit.match.tournament && tm.tournament) fuzzyHit.match.tournament = tm.tournament;
          if (!fuzzyHit.match.stage && tm.stage) fuzzyHit.match.stage = tm.stage;
          if (!fuzzyHit.match.tournamentLogo && tm.tournamentLogo) fuzzyHit.match.tournamentLogo = tm.tournamentLogo;
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

      saveClosing(game, existing); // closing lines of matches that have started
      void trackFeed(game, existing); // «Матчі за 7 днів» on the dashboard

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

    // Schedule next tick at active rate
    setTimeout(tick, ACTIVE_INTERVAL).unref();
  };

  // Fire first tick, then chain
  tick();
  console.log(`[incr:${tag}] Incremental refresh started (${ACTIVE_INTERVAL / 1000}s active, ${IDLE_POLL_MS / 1000}s idle)` +
    (isPrimarySource ? ' (updates-only)' : ''));
}

// Start incremental refresh for both games (after warmup delay, staggered)
setTimeout(() => {
  startIncrementalRefresh('dota2', join(process.cwd(), '.cache', 'dota2_matches.json'), 'dota2');
  // Stagger CS2 incr refresh by 5s to avoid simultaneous tips.gg page fetches
  setTimeout(() => {
    startIncrementalRefresh('cs2', join(process.cwd(), '.cache', 'cs2_matches.json'), 'cs2');
  }, 5_000);
}, 5_000);

// ── Periodic full refresh: re-scrape 8-day window every hour ──
// Catches new matches for future days that the 120s incremental refresh
// (today-only) would miss. Uses tips.gg for Dota2, cstest for CS2.
// every hour: matches of the coming days from PandaScore / Cito / tournament pages show up within the hour
// (the sources keep their own caches and limits, so this costs them almost nothing)
const FULL_REFRESH_MS = 60 * 60 * 1000;

function startFullRefresh(game: 'dota2' | 'cs2', cacheFile: string, tag: string): void {
  const tick = async () => {
    if (feedPaused()) {
      // Skip if banned — try again in 4h
      setTimeout(tick, FULL_REFRESH_MS).unref();
      return;
    }
    try {
      const fetchFn = game === 'dota2' ? fetchDota2Matches : fetchCs2Matches;
      const fresh = await fetchFn();
      if (fresh && fresh.length > 0) {
        // Merge: don't lose cstest entries for CS2
        if (game === 'cs2') {
          let existing: any[] = [];
          try {
            if (existsSync(cacheFile)) {
              const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
              existing = raw.data || [];
            }
          } catch { /* stale */ }
          // Liquipedia now gives the schedule: drop the OddsPapi stand-ins cached before it (same matches, other ids)
          if (fresh.some((m: any) => String(m.id).startsWith('lp-'))) existing = existing.filter((m: any) => !String(m.id).startsWith('op-'));
          existing = dropCitoGone(existing, fresh);
          const merged = new Map<string, any>(existing.map((m: any) => [m.id, m]));
          for (const m of fresh) {
            if (merged.has(m.id)) { recordChanges(diffMatch(game, merged.get(m.id), m)); merged.set(m.id, { ...merged.get(m.id), ...m }); continue; }
            // Another source (cstest / HLTV) may already have this match under its own id:
            // then only add what it lacks — odds and tournament name.
            const same = [...merged.values()].find((x: any) => x.date === m.date && isSameMatch(x, m));
            if (same) {
              if (m.coeff1 != null && m.coeff2 != null) {
                const swapped = normalizeTeam(same.nameTeam1) !== normalizeTeam(m.nameTeam1);
                same.coeff1 = swapped ? m.coeff2 : m.coeff1;
                same.coeff2 = swapped ? m.coeff1 : m.coeff2;
              }
              if (!same.tournament && m.tournament) same.tournament = m.tournament;
              continue;
            }
            merged.set(m.id, m);
          }
          writeFileCacheInternal([...merged.values()], cacheFile);
          persistFinishedToHistory([...merged.values()], game, `full-refresh:${tag}`);
          void trackFeed(game, [...merged.values()], 7);
          console.log(`[full-refresh] ${tag}: ${fresh.length} fresh merged into ${merged.size} total`);
        } else {
          writeFileCacheInternal(fresh, cacheFile);
          persistFinishedToHistory(fresh, game, `full-refresh:${tag}`);
          console.log(`[full-refresh] ${tag}: ${fresh.length} matches`);
        }
      }
    } catch (err) {
      console.warn(`[full-refresh] ${tag} failed:`, (err as Error).message);
    }
    setTimeout(tick, FULL_REFRESH_MS).unref();
  };
  setTimeout(tick, 60_000).unref(); // first run 1min after startup
  console.log(`[full-refresh] ${tag}: periodic hourly full scan registered`);
}

setTimeout(() => {
  startFullRefresh('dota2', join(process.cwd(), '.cache', 'dota2_matches.json'), 'dota2');
  setTimeout(() => {
    startFullRefresh('cs2', join(process.cwd(), '.cache', 'cs2_matches.json'), 'cs2');
  }, 10_000);
}, 10_000);

startProExpiry();

// ── Graceful shutdown ──
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  // keep the caches and the not-yet-saved errors for the next start (a deploy wipes the disk)
  await Promise.race([Promise.all([flushServerErrors(), flushChanges()]), new Promise((r) => setTimeout(r, 3_000))]);
  await Promise.race([syncDurableFiles().then((n) => console.log(`[durable] ${n} cache files saved`)), new Promise((r) => setTimeout(r, 5_000))]);
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing DB pool:', err);
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

serve({
  fetch: app.fetch,
  port,
});

