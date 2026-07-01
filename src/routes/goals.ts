import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createGoalSchema, updateGoalSchema } from '../middleware/validation';
import { goalService } from '../services/goalService';

const goals = new Hono();

goals.get('/', requireAuth, async (c) => {
  const page = parseInt(c.req.query('page') || '0', 10);
  const all = await goalService.list(c.get('user').userId);
  if (!page || page < 1) return c.json(all); // backward compat: plain array
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
  const rows = all.slice((page - 1) * limit, page * limit);
  return c.json({ data: rows, meta: { page, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
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
