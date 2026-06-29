import 'dotenv/config';

// ═══════════════════════════════════════════
// MatchIQ Backend API Server
// ═══════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { authMiddleware } from './middleware/auth';

import authRoutes from './routes/auth';
import betRoutes from './routes/bets';
import goalRoutes from './routes/goals';
import bankrollRoutes from './routes/bankroll';
import strategyRoutes from './routes/strategies';
import aiRoutes from './routes/ai';
import telegramRoutes from './routes/telegram';
import riskyTeamRoutes from './routes/riskyTeams';

const app = new Hono();

// ── Global middleware ──
app.use('*', cors());
app.use('*', authMiddleware);

// ── Health check ──
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Routes ──
app.route('/api/auth', authRoutes);
app.route('/api/bets', betRoutes);
app.route('/api/goals', goalRoutes);
app.route('/api/bankroll', bankrollRoutes);
app.route('/api/strategies', strategyRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/telegram', telegramRoutes);
app.route('/api/risky-teams', riskyTeamRoutes);

// ── Start ──
const port = parseInt(process.env.PORT || '3001', 10);

console.log(`🚀 MatchIQ API server starting on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
