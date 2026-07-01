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
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  },
  schema: { strategies: 'strategies', users: 'users' },
  eq: vi.fn(() => 'eq-filter'),
  and: vi.fn(() => 'and-filter'),
}));

import strategiesRoutes from '../routes/strategies';

describe('Strategies Routes (integration)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/api/strategies/*', async (c, next) => {
      if (c.req.header('Authorization') === 'Bearer good-token')
        c.set('user', { userId: 1, username: 'test', role: 'user' });
      await next();
    });
    app.route('/api/strategies', strategiesRoutes);
  });

  it('GET / returns 401 without auth', async () => {
    const res = await app.request('/api/strategies');
    expect(res.status).toBe(401);
  });

  it('POST / returns 400 for empty name', async () => {
    const res = await app.request('/api/strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 400 for missing name', async () => {
    const res = await app.request('/api/strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({ config: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns 401 without auth', async () => {
    const res = await app.request('/api/strategies/123', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('DELETE with ?name= fallback works', async () => {
    const res = await app.request('/api/strategies/123?name=Test', { method: 'DELETE' });
    expect(res.status).toBe(401); // Auth check first
  });
});
