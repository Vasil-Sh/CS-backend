import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createBetSchema, updateBetSchema } from '../middleware/validation';
import { getPagination } from '../utils/response';
import { betService } from '../services/betService';

const bets = new Hono();

// ── GET /api/bets?page=1&limit=50 ──
bets.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const { page, limit } = getPagination(c);
  const { rows, total } = await betService.getBets(user.userId, page, limit);
  return c.json({ data: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// ── POST /api/bets ──
bets.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  let body;
  try { body = createBetSchema.parse(await c.req.json()); }
  catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const bet = await betService.createBet(user.userId, body);
  return c.json(bet, 201);
});

// ── PUT /api/bets/:id ──
bets.put('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') || '';
  let body;
  try { body = updateBetSchema.parse(await c.req.json()); }
  catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await betService.updateBet(id, user.userId, body);
  if (!updated) return c.json({ error: 'Bet not found' }, 404);
  return c.json(updated);
});

// ── PATCH /api/bets/:id ──
bets.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') || '';
  let body;
  try { body = updateBetSchema.parse(await c.req.json()); }
  catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await betService.updateBet(id, user.userId, body);
  if (!updated) return c.json({ error: 'Bet not found' }, 404);
  return c.json(updated);
});

// ── DELETE /api/bets/:id ──
bets.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') || '';
  const deleted = await betService.deleteBet(id, user.userId);
  if (!deleted) return c.json({ error: 'Bet not found' }, 404);
  return c.json({ success: true });
});

// ── GET /api/bets/stats ──
bets.get('/stats', requireAuth, async (c) => {
  const user = c.get('user');
  const totals = await betService.getStats(user.userId);
  const { totalBets, wins, totalProfit, totalRoi } = totals;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

  // Fetch profit by month and by strategy
  const profitByMonth = await betService.getProfitByMonth(user.userId);
  const profitByStrategy = await betService.getProfitByStrategy(user.userId);

  return c.json({
    totalBets,
    winRate: Math.round(winRate * 100) / 100,
    totalProfit: Number(totalProfit),
    averageROI: Math.round(Number(totalRoi) * 100) / 100,
    profitByMonth,
    profitByStrategy,
  });
});

// ── PATCH /api/bets/:id (same as PUT) ──
bets.on('PATCH', '/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') || '';
  let body;
  try { body = updateBetSchema.parse(await c.req.json()); }
  catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await betService.updateBet(id, user.userId, body);
  if (!updated) return c.json({ error: 'Bet not found' }, 404);
  return c.json(updated);
});

export default bets;
