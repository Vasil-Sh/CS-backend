import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { telegramGroupSchema, telegramGroupUpdateSchema } from '../middleware/validation';
import { telegramGroupService } from '../services/telegramGroupService';

const tgGroups = new Hono();

tgGroups.get('/', requireAuth, async (c) => {
  const page = parseInt(c.req.query('page') || '0', 10);
  const all = await telegramGroupService.list(c.get('user').userId);
  if (!page || page < 1) return c.json(all);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
  const rows = all.slice((page - 1) * limit, page * limit);
  return c.json({ data: rows, meta: { page, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
});

tgGroups.post('/', requireAuth, async (c) => {
  let body;
  try { body = telegramGroupSchema.parse(await c.req.json()); }
  catch { return c.json({ error: 'Invalid input: name (1-200 chars) and optional link required' }, 400); }
  const group = await telegramGroupService.create(c.get('user').userId, body.name, body.link, body.hasChannel, body.comment, body.game);
  return c.json(group, 201);
});

tgGroups.delete('/:id', requireAuth, async (c) => {
  const deleted = await telegramGroupService.remove(c.req.param('id') || '', c.get('user').userId);
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

tgGroups.put('/:id', requireAuth, async (c) => {
  let body;
  try { body = telegramGroupUpdateSchema.parse(await c.req.json()); }
  catch { return c.json({ error: 'Invalid input' }, 400); }
  const group = await telegramGroupService.update(c.req.param('id') || '', c.get('user').userId, body);
  if (!group) return c.json({ error: 'Not found' }, 404);
  return c.json(group);
});

export default tgGroups;
