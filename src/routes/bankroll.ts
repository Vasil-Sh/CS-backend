import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { setBankrollSchema, adjustBankrollSchema } from '../middleware/validation';

const bankroll = new Hono();

// ── GET /api/bankroll ──
bankroll.get('/', requireAuth, async (c) => {
  const user = c.get('user');

  const [row] = await db
    .select()
    .from(schema.bankroll)
    .where(eq(schema.bankroll.userId, user.userId))
    .limit(1);

  if (!row) {
    return c.json({
      initialBank: 0,
      manualAdjustments: 0,
      currentBank: 0,
      totalProfit: 0,
      roi: 0,
    });
  }

  // Calculate total profit from bets
  const bets = await db
    .select()
    .from(schema.bets)
    .where(eq(schema.bets.userId, user.userId));

  const totalProfit = bets
    .filter((b) => b.result !== 'Pending')
    .reduce((sum, b) => sum + parseFloat(b.profit || '0'), 0);

  const initialBank = parseFloat(row.initialBank || '0');
  const manualAdjustments = parseFloat(row.manualAdjustments || '0');
  const currentBank = initialBank + totalProfit + manualAdjustments;
  const roi = initialBank > 0 ? (totalProfit / initialBank) * 100 : 0;

  return c.json({
    initialBank,
    manualAdjustments,
    currentBank,
    totalProfit,
    roi: Math.round(roi * 100) / 100,
  });
});

// ── POST /api/bankroll (set initial bank) ──
bankroll.post('/', requireAuth, async (c) => {
  const user = c.get('user');

  let body;
  try {
    body = setBankrollSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  // Upsert: if exists, update; else insert
  const [existing] = await db
    .select()
    .from(schema.bankroll)
    .where(eq(schema.bankroll.userId, user.userId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.bankroll)
      .set({ initialBank: body.initialBank.toString() })
      .where(eq(schema.bankroll.userId, user.userId))
      .returning();
    return c.json(updated);
  }

  const [created] = await db
    .insert(schema.bankroll)
    .values({
      userId: user.userId,
      initialBank: body.initialBank.toString(),
      manualAdjustments: '0',
    })
    .returning();

  return c.json(created, 201);
});

// ── POST /api/bankroll/adjust ──
bankroll.post('/adjust', requireAuth, async (c) => {
  const user = c.get('user');

  let body;
  try {
    body = adjustBankrollSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  const [existing] = await db
    .select()
    .from(schema.bankroll)
    .where(eq(schema.bankroll.userId, user.userId))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Bankroll not initialized' }, 400);
  }

  const newAdjustments =
    parseFloat(existing.manualAdjustments || '0') + body.amount;

  const [updated] = await db
    .update(schema.bankroll)
    .set({ manualAdjustments: newAdjustments.toString() })
    .where(eq(schema.bankroll.userId, user.userId))
    .returning();

  return c.json(updated);
});

export default bankroll;
