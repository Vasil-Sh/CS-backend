import 'dotenv/config';

// ═══════════════════════════════════════════
// MatchIQ Backend API Server
// ═══════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { authMiddleware } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { rateLimiterMiddleware } from './middleware/rateLimiter';
import pg from 'pg';

import authRoutes from './routes/auth';
import betRoutes from './routes/bets';
import goalRoutes from './routes/goals';
import bankrollRoutes from './routes/bankroll';
import strategyRoutes from './routes/strategies';
import aiRoutes from './routes/ai';
import telegramRoutes from './routes/telegram';
import telegramGroupRoutes from './routes/telegramGroups';
import riskyTeamRoutes from './routes/riskyTeams';

const app = new Hono();

// ── Global middleware ──
app.use('*', loggerMiddleware);
app.use('*', cors({ origin: '*', credentials: true }));
app.use('*', rateLimiterMiddleware);
app.use('*', authMiddleware);

// ── Health check (with DB verification) ──
app.get('/api/health', async (c) => {
  let db = 'unknown';
  try {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const result = await pool.query('SELECT 1');
    db = result.rows[0]?.['?column?'] === 1 ? 'connected' : 'error';
    await pool.end();
  } catch {
    db = 'disconnected';
  }
  return c.json({
    status: 'ok',
    database: db,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── API Docs (serves openapi.json) ──
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let openapiSpec: object | null = null;
try { openapiSpec = JSON.parse(readFileSync(join(__dirname, 'openapi.json'), 'utf-8')); } catch {}

if (openapiSpec) {
  app.get('/api/docs.json', (c) => c.json(openapiSpec!));
}

// ── Routes ──
app.route('/api/auth', authRoutes);
app.route('/api/bets', betRoutes);
app.route('/api/goals', goalRoutes);
app.route('/api/bankroll', bankrollRoutes);
app.route('/api/strategies', strategyRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/telegram', telegramRoutes);
app.route('/api/telegram-groups', telegramGroupRoutes);
app.route('/api/risky-teams', riskyTeamRoutes);

// ── Start ──
const port = parseInt(process.env.PORT || '3001', 10);

console.log(`🚀 MatchIQ API server starting on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
