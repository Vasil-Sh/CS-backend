import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  },
  schema: {
    bets: 'bets',
    users: 'users',
  },
  eq: vi.fn(() => 'eq-filter'),
  and: vi.fn(() => 'and-filter'),
  desc: vi.fn(() => 'desc-order'),
  sql: vi.fn(() => 'sql-literal'),
}));

// No JWT mock needed — we inject user directly into context
import betsRoutes from '../routes/bets';

describe('Bets Routes (integration)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();

    // Simulate what authMiddleware does: inject user into context
    app.use('/api/bets/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (auth === 'Bearer good-token') {
        c.set('user', { userId: 1, username: 'test', role: 'user' });
      }
      await next();
    });

    app.route('/api/bets', betsRoutes);
  });

  describe('GET /api/bets', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bets');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bets', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match: 'Test', odds: 2, amount: 100 }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid bet data', async () => {
      const res = await app.request('/api/bets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
        },
        body: JSON.stringify({}), // Missing required fields
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/bets/:id', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bets/123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: 'Win' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/bets/:id', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bets/123', { method: 'DELETE' });
      expect(res.status).toBe(401);
    });
  });
});
