import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { createGoalSchema, updateGoalSchema } from '../middleware/validation';

const goals = new Hono();

// ── GET /api/goals ──
goals.get('/', requireAuth, async (c) => {
  const user = c.get('user');

  const rows = await db
    .select()
    .from(schema.goals)
    .where(eq(schema.goals.userId, user.userId));

  return c.json(rows);
});

// ── POST /api/goals ──
goals.post('/', requireAuth, async (c) => {
  const user = c.get('user');

  let body;
  try {
    body = createGoalSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  // Map frontend fields to backend schema
  const target = body.targetAmount ?? body.targetLadderAmount ?? body.targetROI ?? body.targetWinRate ?? body.target ?? 0;

  const [goal] = await db
    .insert(schema.goals)
    .values({
      userId: user.userId,
      type: body.type === 'winrate' ? 'winrate' : body.type,
      target: target.toString(),
      current: body.current?.toString() || '0',
      deadline: body.deadline || null,
      isCompleted: body.isCompleted || false,
    })
    .returning();

  return c.json(goal, 201);
});

// ── PUT /api/goals/:id ──
goals.put('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  let body;
  try {
    body = updateGoalSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  const [existing] = await db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.id, id), eq(schema.goals.userId, user.userId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Goal not found' }, 404);
  }

  const updateData: Record<string, any> = {};
  if (body.type !== undefined) updateData.type = body.type;
  if (body.target !== undefined) updateData.target = body.target.toString();
  if (body.current !== undefined) updateData.current = body.current.toString();
  if (body.deadline !== undefined) updateData.deadline = body.deadline;
  if (body.isCompleted !== undefined) updateData.isCompleted = body.isCompleted;

  const [updated] = await db
    .update(schema.goals)
    .set(updateData)
    .where(eq(schema.goals.id, id))
    .returning();

  return c.json(updated);
});

// ── DELETE /api/goals/:id ──
goals.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  let [found] = await db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.id, id), eq(schema.goals.userId, user.userId)))
    .limit(1);

  if (!found) {
    return c.json({ error: 'Goal not found' }, 404);
  }

  await db.delete(schema.goals).where(eq(schema.goals.id, found.id));
  return c.json({ success: true });
});

export default goals;
