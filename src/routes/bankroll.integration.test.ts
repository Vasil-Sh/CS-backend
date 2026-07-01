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
  schema: {
    bankroll: 'bankroll',
    bets: 'bets',
    users: 'users',
  },
  eq: vi.fn(() => 'eq-filter'),
}));

import bankrollRoutes from '../routes/bankroll';

describe('Bankroll Routes (integration)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();

    // Simulate authMiddleware: inject user into context
    app.use('/api/bankroll/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (auth === 'Bearer good-token') {
        c.set('user', { userId: 1, username: 'test', role: 'user' });
      }
      await next();
    });

    app.route('/api/bankroll', bankrollRoutes);
  });

  describe('GET /api/bankroll', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bankroll');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bankroll', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bankroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialBank: 1000 }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 for negative initialBank', async () => {
      const res = await app.request('/api/bankroll', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
        },
        body: JSON.stringify({ initialBank: -100 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/bankroll/adjust', () => {
    it('returns 401 without auth token', async () => {
      const res = await app.request('/api/bankroll/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 500 }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing amount', async () => {
      const res = await app.request('/api/bankroll/adjust', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});
