import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { telegramGroupService } from '../services/telegramGroupService';

const tgGroups = new Hono();

tgGroups.get('/', requireAuth, async (c) => {
  const page = parseInt(c.req.query('page') || '0', 10);
  const all = await telegramGroupService.list(c.get('user').userId);
  if (!page || page < 1) return c.json(all); // backward compat: plain array
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
  const rows = all.slice((page - 1) * limit, page * limit);
  return c.json({ data: rows, meta: { page, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } });
});

tgGroups.post('/', requireAuth, async (c) => {
  let body;
  try { body = z.object({ name: z.string().min(1).max(200), link: z.string().max(500).default('') }).parse(await c.req.json()); }
  catch { return c.json({ error: 'Invalid input: name (1-200 chars) and optional link required' }, 400); }
  const group = await telegramGroupService.create(c.get('user').userId, body.name, body.link);
  return c.json(group, 201);
});

tgGroups.delete('/:id', requireAuth, async (c) => {
  const deleted = await telegramGroupService.remove(c.req.param('id') || '', c.get('user').userId);
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

export default tgGroups;
