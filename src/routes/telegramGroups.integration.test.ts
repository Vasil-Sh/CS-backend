import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  },
  schema: { telegramGroups: 'telegram_groups', users: 'users' },
  eq: vi.fn(() => 'eq-filter'),
  and: vi.fn(() => 'and-filter'),
}));

import tgRoutes from '../routes/telegramGroups';

describe('Telegram Groups Routes (integration)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/api/telegram-groups/*', async (c, next) => {
      if (c.req.header('Authorization') === 'Bearer good-token')
        c.set('user', { userId: 1, username: 'test', role: 'user' });
      await next();
    });
    app.route('/api/telegram-groups', tgRoutes);
  });

  it('GET / returns 401 without auth', async () => {
    const res = await app.request('/api/telegram-groups');
    expect(res.status).toBe(401);
  });

  it('POST / returns 400 for missing name', async () => {
    const res = await app.request('/api/telegram-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({ link: 'https://t.me/test' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 400 for empty name', async () => {
    const res = await app.request('/api/telegram-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns 401 without auth', async () => {
    const res = await app.request('/api/telegram-groups/123', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
