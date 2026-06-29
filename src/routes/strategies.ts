import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { createStrategySchema, updateStrategySchema } from '../middleware/validation';

const strategies = new Hono();

// ── GET /api/strategies ──
strategies.get('/', requireAuth, async (c) => {
  const user = c.get('user');

  const rows = await db
    .select()
    .from(schema.strategies)
    .where(eq(schema.strategies.userId, user.userId));

  return c.json(rows);
});

// ── POST /api/strategies ──
strategies.post('/', requireAuth, async (c) => {
  const user = c.get('user');

  let body;
  try {
    body = createStrategySchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  // If setting as primary, unset other primaries
  if (body.isPrimary) {
    await db
      .update(schema.strategies)
      .set({ isPrimary: false })
      .where(eq(schema.strategies.userId, user.userId));
  }

  const [strategy] = await db
    .insert(schema.strategies)
    .values({
      userId: user.userId,
      name: body.name,
      isPrimary: body.isPrimary,
      config: body.config,
    })
    .returning();

  return c.json(strategy, 201);
});

// ── PUT /api/strategies/:id ──
strategies.put('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  let body;
  try {
    body = updateStrategySchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  const [existing] = await db
    .select()
    .from(schema.strategies)
    .where(and(eq(schema.strategies.id, id), eq(schema.strategies.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Strategy not found' }, 404);
  }

  // If setting as primary, unset other primaries
  if (body.isPrimary) {
    await db
      .update(schema.strategies)
      .set({ isPrimary: false })
      .where(eq(schema.strategies.userId, user.userId));
  }

  const updateData: Record<string, any> = {};
  if (body.name !== undefined) updateData.name = body.name;
  if (body.isPrimary !== undefined) updateData.isPrimary = body.isPrimary;
  if (body.config !== undefined) updateData.config = body.config;

  const [updated] = await db
    .update(schema.strategies)
    .set(updateData)
    .where(eq(schema.strategies.id, id))
    .returning();

  return c.json(updated);
});

// ── DELETE /api/strategies/:id ──
strategies.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [existing] = await db
    .select()
    .from(schema.strategies)
    .where(and(eq(schema.strategies.id, id), eq(schema.strategies.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Strategy not found' }, 404);
  }

  await db.delete(schema.strategies).where(eq(schema.strategies.id, id));
  return c.json({ success: true });
});

export default strategies;
