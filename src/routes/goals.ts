import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createGoalSchema, updateGoalSchema } from '../middleware/validation';
import { goalService } from '../services/goalService';

const goals = new Hono();

goals.get('/', requireAuth, async (c) => {
  const rows = await goalService.list(c.get('user').userId);
  return c.json(rows);
});

goals.post('/', requireAuth, async (c) => {
  let body;
  try { body = createGoalSchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const goal = await goalService.create(c.get('user').userId, body);
  return c.json(goal, 201);
});

goals.put('/:id', requireAuth, async (c) => {
  let body;
  try { body = updateGoalSchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await goalService.update(c.req.param('id') || '', c.get('user').userId, body);
  if (!updated) return c.json({ error: 'Goal not found' }, 404);
  return c.json(updated);
});

goals.delete('/:id', requireAuth, async (c) => {
  const deleted = await goalService.remove(c.req.param('id') || '', c.get('user').userId);
  if (!deleted) return c.json({ error: 'Goal not found' }, 404);
  return c.json({ success: true });
});

export default goals;
