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
  schema: { goals: 'goals', users: 'users' },
  eq: vi.fn(() => 'eq-filter'),
  and: vi.fn(() => 'and-filter'),
}));

import goalsRoutes from '../routes/goals';

describe('Goals Routes (integration)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/api/goals/*', async (c, next) => {
      if (c.req.header('Authorization') === 'Bearer good-token')
        c.set('user', { userId: 1, username: 'test', role: 'user' });
      await next();
    });
    app.route('/api/goals', goalsRoutes);
  });

  it('GET / returns 401 without auth', async () => {
    const res = await app.request('/api/goals');
    expect(res.status).toBe(401);
  });

  it('POST / returns 400 for invalid body', async () => {
    const res = await app.request('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 400 for invalid type', async () => {
    const res = await app.request('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify({ type: 'invalid_type', target: 100 }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /:id returns 401 without auth', async () => {
    const res = await app.request('/api/goals/123', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 200 }),
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /:id returns 401 without auth', async () => {
    const res = await app.request('/api/goals/123', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
