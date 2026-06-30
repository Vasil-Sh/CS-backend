import 'dotenv/config';
import './utils/env'; // Fail-fast env validation

// ═══════════════════════════════════════════
// MatchIQ Backend API Server
// ═══════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { authMiddleware } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { rateLimiterMiddleware } from './middleware/rateLimiter';
import { bodyLimit } from './middleware/bodyLimit';
import { securityHeaders } from './middleware/securityHeaders';
import { db } from './db/client';
import { sql } from 'drizzle-orm';

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
app.use('*', securityHeaders);
app.use('*', loggerMiddleware);
app.use('*', cors({ origin: '*', credentials: true }));
app.use('*', rateLimiterMiddleware);
app.use('*', bodyLimit(1_000_000)); // 1MB max body
app.use('*', authMiddleware);

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

// ── API Docs (serves openapi.json) ──
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let openapiSpec: object | null = null;
try { openapiSpec = JSON.parse(readFileSync(join(__dirname, 'openapi.json'), 'utf-8')); } catch (e: any) {
  console.warn('⚠️ openapi.json not loaded:', e.message);
}

if (openapiSpec) {
  app.get('/api/docs.json', (c) => c.json(openapiSpec!));

  // Swagger UI (interactive docs)
  // In production, protected by query param ?key=<ADMIN_PASSWORD>
  // In dev, open access
  const isDev = process.env.NODE_ENV !== 'production';
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  let swaggerHtml = '';
  try { swaggerHtml = readFileSync(join(__dirname, 'swagger.html'), 'utf-8'); } catch {}

  if (swaggerHtml) {
    app.get('/api/docs', (c) => {
      if (!isDev && adminPassword) {
        const key = c.req.query('key');
        if (key !== adminPassword) {
          return c.json({ error: 'Access denied. Use ?key=<password>' }, 403);
        }
      }
      return c.html(swaggerHtml);
    });

    console.log(
      `📖 API Docs: http://localhost:${process.env.PORT || '3001'}/api/docs` +
      (!isDev ? `?key=<ADMIN_PASSWORD>` : '')
    );
  }
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

// ── Graceful shutdown ──
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  // The Hono serve() returns a Server; we'd close it here.
  // For now, exit cleanly so Railway restarts with zero downtime.
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

serve({
  fetch: app.fetch,
  port,
});
