import 'dotenv/config';
import './utils/env'; // Fail-fast env validation

// ═══════════════════════════════════════════
// MatchIQ Backend API Server
// ═══════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

const app = new Hono();

// ── Global middleware ──
app.use('*', compress());
app.use('*', securityHeaders);
app.use('*', loggerMiddleware);
app.use('*', cors({
  origin: (origin) => {
    const allowed = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001,https://matchiq.pro,https://www.matchiq.pro,https://matchiq.vercel.app,https://cs-backend-production-f9e8.up.railway.app').split(',');
    if (!origin) return allowed[0];
    // Allow all vercel.app subdomains (Vercel creates per-deployment preview URLs)
    if (origin.endsWith('.vercel.app')) return origin;
    if (allowed.some(a => origin.startsWith(a))) return origin;
    return null;
  },
  credentials: true,
}));
app.use('*', rateLimiterMiddleware);
app.use('*', bodyLimit(1_000_000)); // 1MB max body
app.use('*', authMiddleware);

// ── Convert ALL string numbers to real numbers in JSON responses ──
app.use('*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return;
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
import fs from 'fs';
import path from 'path';

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
        return c.json({ error: 'Access denied. Use ?key=<password>' }, 403);
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
v1.route('', adminRoutes);

app.route('/api/v1', v1);

// ── Also mount at /api for backward compat (frontend uses /api/*) ──
app.route('/api', v1);

// ── Global error handler ──
app.onError((err, c) => {
  console.error('[Error]', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

// ── 404 handler ──
app.notFound((c) => {
  return c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404);
});

// ── Start ──
const port = parseInt(process.env.PORT || '3001', 10);

console.log(`🚀 MatchIQ API server starting on http://localhost:${port}`);

// ── Graceful shutdown ──
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
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

