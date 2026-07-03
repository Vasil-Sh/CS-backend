import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { db, schema } from '../db/client';
import { eq, gte, and } from 'drizzle-orm';

const tiltBlocks = new Hono();

// GET /api/tilt-blocks — get active tilt blocks for current user
tiltBlocks.get('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const now = new Date();
  const rows = await db.select().from(schema.tiltBlocks)
    .where(and(
      eq(schema.tiltBlocks.userId, userId),
      gte(schema.tiltBlocks.until, now),
    ));
  return c.json(rows);
});

// POST /api/tilt-blocks — set a tilt block
tiltBlocks.post('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  let body: { until: string; reason?: string; strategyName?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!body.until) return c.json({ error: 'until timestamp required' }, 400);

  const [created] = await db.insert(schema.tiltBlocks).values({
    userId,
    until: new Date(body.until),
    reason: body.reason || '',
    strategyName: body.strategyName || '',
  }).returning();
  return c.json(created, 201);
});

// DELETE /api/tilt-blocks/:id — clear a tilt block early
tiltBlocks.delete('/:id', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const id = c.req.param('id') || '';
  const [found] = await db.select().from(schema.tiltBlocks)
    .where(eq(schema.tiltBlocks.id, id)).limit(1);
  if (!found || found.userId !== userId) return c.json({ error: 'Not found' }, 404);
  await db.delete(schema.tiltBlocks).where(eq(schema.tiltBlocks.id, id));
  return c.json({ success: true });
});

export default tiltBlocks;
