import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { db, schema } from '../db/client';
import { eq } from 'drizzle-orm';

const telegramBetsRoutes = new Hono();

// GET /api/telegram-bets — list all tg bets for current user
telegramBetsRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const rows = await db.select().from(schema.telegramBets).where(eq(schema.telegramBets.userId, userId));
  return c.json(rows);
});

// POST /api/telegram-bets — save a telegram bet
telegramBetsRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  let body: { betData: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!body.betData) return c.json({ error: 'betData required' }, 400);

  const [created] = await db.insert(schema.telegramBets).values({
    userId,
    betData: body.betData,
  }).returning();
  return c.json(created, 201);
});

// DELETE /api/telegram-bets/:id — remove a tg bet
telegramBetsRoutes.delete('/:id', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const id = c.req.param('id') || '';
  if (!id) return c.json({ error: 'id required' }, 400);
  const [found] = await db.select().from(schema.telegramBets)
    .where(eq(schema.telegramBets.id, id))
    .limit(1);
  if (!found || found.userId !== userId) return c.json({ error: 'Not found' }, 404);
  await db.delete(schema.telegramBets).where(eq(schema.telegramBets.id, id));
  return c.json({ success: true });
});

export default telegramBetsRoutes;
