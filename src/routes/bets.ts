import { Hono } from 'hono';
import { eq, desc, and, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { createBetSchema, updateBetSchema } from '../middleware/validation';
import { cache } from '../utils/cache';
import { ok, created, err, paginated, getPagination } from '../utils/response';

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

// ── GET /api/bets?page=1&limit=50 ──
bets.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const { page, limit, offset } = getPagination(c);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId));

  const rows = await db
    .select()
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId))
    .orderBy(desc(schema.bets.date), desc(schema.bets.createdAt))
    .limit(limit)
    .offset(offset);

  return paginated(c, rows, { page, limit, total: count });
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

// ── Shared: verify ownership and return existing bet ──
async function getOwnedBet(id: string, userId: number) {
  const [row] = await db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.id, id), eq(schema.bets.userId, userId)))
    .limit(1);
  return row || null;
}
/** Extract and validate route param :id */
function routeId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param('id');
  if (!id) throw new Error('Missing :id param');
  return id;
}
// ── Shared: build update data from body using field mapping ──
// Numeric fields: convert to string for Postgres NUMERIC columns
const NUMERIC_FIELDS = new Set([
  'profit', 'odds', 'amount', 'roi', 'stake', 'originalAmount',
  'exchangeRate', 'originalProfit', 'winProbability',
]);
// Pass-through fields (string/boolean/array — no conversion needed)
const PASSTHROUGH_FIELDS = new Set([
  'result', 'notes', 'strategy', 'risk', 'match', 'team1', 'team2',
  'betType', 'date', 'format', 'game', 'currency', 'goalId',
  'selection', 'matchUrl', 'riskyTeams', 'tournament',
  'logoTeam1', 'logoTeam2', 'expressLogos',
]);

function buildBetUpdateData(body: Record<string, any>): Record<string, any> {
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (NUMERIC_FIELDS.has(key)) {
      data[key] = value?.toString();
    } else if (PASSTHROUGH_FIELDS.has(key)) {
      data[key] = value;
    }
  }
  return data;
}

// ── PUT /api/bets/:id ──
bets.put('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  invalidateCache(user.userId);
  const id = routeId(c);

  let body;
  try {
    body = updateBetSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  if (!(await getOwnedBet(id, user.userId))) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  const updateData = buildBetUpdateData(body);
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
  invalidateCache(user.userId);
  const id = routeId(c);

  if (!(await getOwnedBet(id, user.userId))) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  await db.delete(schema.bets).where(eq(schema.bets.id, id));
  return c.json({ success: true });
});

// ── GET /api/bets/stats (SQL aggregation, no OOM risk) ──
bets.get('/stats', requireAuth, async (c) => {
  const user = c.get('user');
  const uid = user.userId;

  // Single query for totals (uses indexes only, O(1) memory)
  const [totals] = await db
    .select({
      totalBets: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${schema.bets.result} = 'Win')::int`,
      totalProfit: sql<number>`coalesce(sum(
        case when ${schema.bets.result} != 'Pending' then ${schema.bets.profit} else 0 end
      ), 0)::float`,
      totalRoi: sql<number>`coalesce(avg(
        case when ${schema.bets.result} != 'Pending' then ${schema.bets.roi} else null end
      ), 0)::float`,
    })
    .from(schema.bets)
    .where(eq(schema.bets.userId, uid));

  // Profit by month (SQL GROUP BY)
  const profitByMonth = await db
    .select({
      month: sql<string>`to_char(${schema.bets.date}::date, 'YYYY-MM')`,
      profit: sql<number>`coalesce(sum(${schema.bets.profit}), 0)::float`,
    })
    .from(schema.bets)
    .where(and(eq(schema.bets.userId, uid), ne(schema.bets.result, 'Pending')))
    .groupBy(sql`to_char(${schema.bets.date}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${schema.bets.date}::date, 'YYYY-MM')`);

  // Profit by strategy (SQL GROUP BY)
  const profitByStrategy = await db
    .select({
      strategy: sql<string>`coalesce(nullif(${schema.bets.strategy}, ''), 'Без стратегії')`,
      profit: sql<number>`coalesce(sum(${schema.bets.profit}), 0)::float`,
    })
    .from(schema.bets)
    .where(and(eq(schema.bets.userId, uid), ne(schema.bets.result, 'Pending')))
    .groupBy(sql`coalesce(nullif(${schema.bets.strategy}, ''), 'Без стратегії')`);

  const { totalBets, wins, totalProfit, totalRoi } = totals;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

  return c.json({
    totalBets,
    winRate: Math.round(winRate * 100) / 100,
    totalProfit: Number(totalProfit),
    averageROI: Math.round(Number(totalRoi) * 100) / 100,
    profitByMonth,
    profitByStrategy,
  });
});

// ═══════════════════════════════════════════
// PATCH /api/bets/:id (same helpers as PUT)
// ═══════════════════════════════════════════
bets.on('PATCH', '/:id', requireAuth, async (c) => {
  const user = c.get('user');
  invalidateCache(user.userId);
  const id = routeId(c);

  let body;
  try {
    body = updateBetSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  if (!(await getOwnedBet(id, user.userId))) {
    return c.json({ error: 'Bet not found' }, 404);
  }

  const [updated] = await db
    .update(schema.bets)
    .set(buildBetUpdateData(body))
    .where(eq(schema.bets.id, id))
    .returning();

  return c.json(updated);
});

export default bets;
