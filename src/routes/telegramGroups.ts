import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { telegramGroupService } from '../services/telegramGroupService';

const tgGroups = new Hono();

tgGroups.get('/', requireAuth, async (c) => {
  const rows = await telegramGroupService.list(c.get('user').userId);
  return c.json(rows);
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
