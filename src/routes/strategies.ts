import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createStrategySchema, updateStrategySchema } from '../middleware/validation';
import { strategyService } from '../services/strategyService';

const strategies = new Hono();

strategies.get('/', requireAuth, async (c) => {
  const rows = await strategyService.list(c.get('user').userId);
  return c.json(rows);
});

strategies.post('/', requireAuth, async (c) => {
  let body;
  try { body = createStrategySchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const s = await strategyService.create(c.get('user').userId, body);
  return c.json(s, 201);
});

strategies.put('/:id', requireAuth, async (c) => {
  let body;
  try { body = updateStrategySchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await strategyService.update(c.req.param('id') || '', c.get('user').userId, body);
  if (!updated) return c.json({ error: 'Strategy not found' }, 404);
  return c.json(updated);
});

strategies.delete('/:id', requireAuth, async (c) => {
  const deleted = await strategyService.remove(c.req.param('id') || '', c.get('user').userId, c.req.query('name'));
  if (!deleted) return c.json({ error: 'Strategy not found' }, 404);
  return c.json({ success: true });
});

export default strategies;
