import { Hono } from 'hono';
import { eq, desc, and, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { createBetSchema, updateBetSchema } from '../middleware/validation';
import { cache } from '../utils/cache';

const bets = new Hono();

/** Invalidate all cached bet data for a user */
function invalidateCache(userId: number) {
  cache.del(`bets:${userId}`);
  cache.del(`stats:${userId}`);
}

/** Normalize goalId: empty/'all'/whitespace → null */
function cleanGoalId(id?: string): string | null {
  if (!id || id === 'all' || !id.trim()) return null;
  return id;
}

// ── GET /api/bets ──
bets.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const cacheKey = `bets:${user.userId}`;

  const cached = cache.get<any[]>(cacheKey);
  if (cached) return c.json(cached);

  const rows = await db
    .select()
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId))
    .orderBy(desc(schema.bets.date), desc(schema.bets.createdAt));

  cache.set(cacheKey, rows, 15_000); // 15 second TTL
  return c.json(rows);
});

// ── POST /api/bets ──
bets.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  invalidateCache(user.userId);

  let body;
  try {
    body = createBetSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  const [bet] = await db
    .insert(schema.bets)
    .values({
      userId: user.userId,
      match: body.match,
      team1: body.team1 || '',
      team2: body.team2 || '',
      betType: body.betType,
      odds: body.odds.toString(),
      amount: body.amount.toString(),
      stake: body.stake?.toString(),
      date: body.date || new Date().toISOString().split('T')[0],
      result: body.result,
      profit: body.profit?.toString() || '0',
      strategy: body.strategy || '',
      format: body.format || '',
      game: body.game || 'CS2',
      currency: body.currency || 'USD',
      originalAmount: body.originalAmount?.toString(),
      exchangeRate: body.exchangeRate?.toString(),
      originalProfit: body.originalProfit?.toString(),
      roi: body.roi?.toString(),
      goalId: cleanGoalId(body.goalId),
      selection: body.selection || '',
      matchUrl: body.matchUrl || '',
      winProbability: body.winProbability?.toString() || undefined,
      risk: body.risk || '',
      notes: body.notes || '',
      riskyTeams: body.riskyTeams || [],
      tournament: body.tournament || '',
      logoTeam1: body.logoTeam1,
      logoTeam2: body.logoTeam2,
      expressLogos: body.expressLogos || [],
    })
    .returning();

  return c.json(bet, 201);
});

// ── PUT /api/bets/:id ──
bets.put('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  invalidateCache(user.userId);
  const id = c.req.param('id');

  let body;
  try {
    body = updateBetSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  // Verify ownership
  const [existing] = await db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.id, id), eq(schema.bets.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  const updateData: Record<string, any> = {};
  if (body.result !== undefined) updateData.result = body.result;
  if (body.profit !== undefined) updateData.profit = body.profit.toString();
  if (body.notes !== undefined) updateData.notes = body.notes;
  if (body.strategy !== undefined) updateData.strategy = body.strategy;
  if (body.odds !== undefined) updateData.odds = body.odds.toString();
  if (body.amount !== undefined) updateData.amount = body.amount.toString();
  if (body.roi !== undefined) updateData.roi = body.roi.toString();
  if (body.risk !== undefined) updateData.risk = body.risk;
  if (body.match !== undefined) updateData.match = body.match;
  if (body.team1 !== undefined) updateData.team1 = body.team1;
  if (body.team2 !== undefined) updateData.team2 = body.team2;
  if (body.betType !== undefined) updateData.betType = body.betType;
  if (body.date !== undefined) updateData.date = body.date;
  if (body.stake !== undefined) updateData.stake = body.stake?.toString();
  if (body.format !== undefined) updateData.format = body.format;
  if (body.game !== undefined) updateData.game = body.game;
  if (body.currency !== undefined) updateData.currency = body.currency;
  if (body.originalAmount !== undefined) updateData.originalAmount = body.originalAmount.toString();
  if (body.exchangeRate !== undefined) updateData.exchangeRate = body.exchangeRate?.toString();
  if (body.originalProfit !== undefined) updateData.originalProfit = body.originalProfit.toString();
  if (body.goalId !== undefined) updateData.goalId = body.goalId;
  if (body.selection !== undefined) updateData.selection = body.selection;
  if (body.matchUrl !== undefined) updateData.matchUrl = body.matchUrl;
  if (body.winProbability !== undefined) updateData.winProbability = body.winProbability.toString();
  if (body.riskyTeams !== undefined) updateData.riskyTeams = body.riskyTeams;
  if (body.tournament !== undefined) updateData.tournament = body.tournament;
  if (body.logoTeam1 !== undefined) updateData.logoTeam1 = body.logoTeam1;
  if (body.logoTeam2 !== undefined) updateData.logoTeam2 = body.logoTeam2;
  if (body.expressLogos !== undefined) updateData.expressLogos = body.expressLogos;

  const [updated] = await db
    .update(schema.bets)
    .set(updateData)
    .where(eq(schema.bets.id, id))
    .returning();

  return c.json(updated);
});

// ── DELETE /api/bets/:id ──
bets.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [existing] = await db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.id, id), eq(schema.bets.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  await db.delete(schema.bets).where(eq(schema.bets.id, id));
  return c.json({ success: true });
});

// ── GET /api/bets/stats ──
bets.get('/stats', requireAuth, async (c) => {
  const user = c.get('user');

  const all = await db
    .select()
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId));

  const totalBets = all.length;
  const wins = all.filter((b) => b.result === 'Win').length;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

  const totalProfit = all
    .filter((b) => b.result !== 'Pending')
    .reduce((sum, b) => sum + parseFloat(b.profit || '0'), 0);

  const totalRoi =
    all
      .filter((b) => b.result !== 'Pending')
      .reduce((sum, b) => sum + parseFloat(b.roi || '0'), 0) /
    (totalBets || 1);

  // Profit by month
  const monthMap = new Map<string, number>();
  all
    .filter((b) => b.result !== 'Pending')
    .forEach((b) => {
      const month = (b.date as string).substring(0, 7);
      monthMap.set(month, (monthMap.get(month) || 0) + parseFloat(b.profit || '0'));
    });
  const profitByMonth = Array.from(monthMap.entries())
    .map(([month, profit]) => ({ month, profit }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Profit by strategy
  const strategyMap = new Map<string, number>();
  all
    .filter((b) => b.result !== 'Pending')
    .forEach((b) => {
      const s = b.strategy || 'Без стратегії';
      strategyMap.set(s, (strategyMap.get(s) || 0) + parseFloat(b.profit || '0'));
    });
  const profitByStrategy = Array.from(strategyMap.entries()).map(
    ([strategy, profit]) => ({ strategy, profit })
  );

  return c.json({
    totalBets,
    winRate: Math.round(winRate * 100) / 100,
    totalProfit,
    averageROI: Math.round(totalRoi * 100) / 100,
    profitByMonth,
    profitByStrategy,
  });
});

// ── PATCH /api/bets/:id (partial update — same logic as PUT) ──
bets.on('PATCH', '/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  let body;
  try {
    body = updateBetSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  const [existing] = await db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.id, id), eq(schema.bets.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  const updateData: Record<string, any> = {};
  if (body.result !== undefined) updateData.result = body.result;
  if (body.profit !== undefined) updateData.profit = body.profit.toString();
  if (body.notes !== undefined) updateData.notes = body.notes;
  if (body.strategy !== undefined) updateData.strategy = body.strategy;
  if (body.odds !== undefined) updateData.odds = body.odds.toString();
  if (body.amount !== undefined) updateData.amount = body.amount.toString();
  if (body.roi !== undefined) updateData.roi = body.roi.toString();
  if (body.risk !== undefined) updateData.risk = body.risk;
  if (body.match !== undefined) updateData.match = body.match;
  if (body.team1 !== undefined) updateData.team1 = body.team1;
  if (body.team2 !== undefined) updateData.team2 = body.team2;
  if (body.betType !== undefined) updateData.betType = body.betType;
  if (body.date !== undefined) updateData.date = body.date;
  if (body.stake !== undefined) updateData.stake = body.stake?.toString();
  if (body.format !== undefined) updateData.format = body.format;
  if (body.game !== undefined) updateData.game = body.game;
  if (body.currency !== undefined) updateData.currency = body.currency;
  if (body.originalAmount !== undefined) updateData.originalAmount = body.originalAmount.toString();
  if (body.exchangeRate !== undefined) updateData.exchangeRate = body.exchangeRate?.toString();
  if (body.originalProfit !== undefined) updateData.originalProfit = body.originalProfit.toString();
  if (body.goalId !== undefined) updateData.goalId = body.goalId;
  if (body.selection !== undefined) updateData.selection = body.selection;
  if (body.matchUrl !== undefined) updateData.matchUrl = body.matchUrl;
  if (body.winProbability !== undefined) updateData.winProbability = body.winProbability.toString();
  if (body.riskyTeams !== undefined) updateData.riskyTeams = body.riskyTeams;
  if (body.tournament !== undefined) updateData.tournament = body.tournament;
  if (body.logoTeam1 !== undefined) updateData.logoTeam1 = body.logoTeam1;
  if (body.logoTeam2 !== undefined) updateData.logoTeam2 = body.logoTeam2;
  if (body.expressLogos !== undefined) updateData.expressLogos = body.expressLogos;

  const [updated] = await db
    .update(schema.bets)
    .set(updateData)
    .where(eq(schema.bets.id, id))
    .returning();

  return c.json(updated);
});

// ── PATCH /api/bets/:id (partial update) ──
bets.on('PATCH', '/:id', requireAuth, async (c) => {
  // Same logic as PUT — update only provided fields
  const user = c.get('user');
  const id = c.req.param('id');
  let body: any;
  try { body = updateBetSchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }

  const [existing] = await db.select().from(schema.bets).where(and(eq(schema.bets.id, id), eq(schema.bets.userId, user.userId))).limit(1);
  if (!existing) return c.json({ error: 'Bet not found' }, 404);

  const d: Record<string, any> = {};
  if (body.result !== undefined) d.result = body.result;
  if (body.profit !== undefined) d.profit = body.profit.toString();
  if (body.notes !== undefined) d.notes = body.notes;
  if (body.roi !== undefined) d.roi = body.roi.toString();

  const [updated] = await db.update(schema.bets).set(d).where(eq(schema.bets.id, id)).returning();
  return c.json(updated);
});

// ── GET /api/bets/stats ──
bets.get('/stats', requireAuth, async (c) => {
  const user = c.get('user');
  const cacheKey = `stats:${user.userId}`;

  const cached = cache.get<any>(cacheKey);
  if (cached) return c.json(cached);

  const all = await db
    .select()
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId));

  const totalBets = all.length;
  const wins = all.filter((b) => b.result === 'Win').length;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

  const totalProfit = all
    .filter((b) => b.result !== 'Pending')
    .reduce((sum, b) => sum + parseFloat(b.profit || '0'), 0);

  const totalRoi =
    all
      .filter((b) => b.result !== 'Pending')
      .reduce((sum, b) => sum + parseFloat(b.roi || '0'), 0) /
    (totalBets || 1);

  const monthMap = new Map<string, number>();
  all
    .filter((b) => b.result !== 'Pending')
    .forEach((b) => {
      const month = (b.date as string).substring(0, 7);
      monthMap.set(month, (monthMap.get(month) || 0) + parseFloat(b.profit || '0'));
    });
  const profitByMonth = Array.from(monthMap.entries())
    .map(([month, profit]) => ({ month, profit }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const strategyMap = new Map<string, number>();
  all
    .filter((b) => b.result !== 'Pending')
    .forEach((b) => {
      const s = b.strategy || 'Без стратегії';
      strategyMap.set(s, (strategyMap.get(s) || 0) + parseFloat(b.profit || '0'));
    });
  const profitByStrategy = Array.from(strategyMap.entries()).map(
    ([strategy, profit]) => ({ strategy, profit })
  );

  const result = {
    totalBets,
    winRate: Math.round(winRate * 100) / 100,
    totalProfit,
    averageROI: Math.round(totalRoi * 100) / 100,
    profitByMonth,
    profitByStrategy,
  };

  cache.set(cacheKey, result, 30_000); // 30 second TTL for stats
  return c.json(result);
});

export default bets;
