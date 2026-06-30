import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';

const tgGroups = new Hono();

// ── GET /api/telegram-groups ──
tgGroups.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const rows = await db.select().from(schema.telegramGroups)
    .where(eq(schema.telegramGroups.userId, user.userId))
    .orderBy(schema.telegramGroups.name);
  return c.json(rows);
});

// ── POST /api/telegram-groups ──
tgGroups.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  const body = z.object({
    name: z.string().min(1).max(200),
    link: z.string().max(500).default(''),
  }).parse(await c.req.json());

  const [group] = await db.insert(schema.telegramGroups)
    .values({ userId: user.userId, name: body.name, link: body.link })
    .returning();
  return c.json(group, 201);
});

// ── DELETE /api/telegram-groups/:id ──
tgGroups.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [found] = await db.select().from(schema.telegramGroups)
    .where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, user.userId)))
    .limit(1);
  if (!found) return c.json({ error: 'Not found' }, 404);
  await db.delete(schema.telegramGroups).where(eq(schema.telegramGroups.id, id));
  return c.json({ success: true });
});

export default tgGroups;
