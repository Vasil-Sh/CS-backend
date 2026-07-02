import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { testClient } from 'hono/testing';
import betRoutes from './bets';

// Create a minimal Hono app for route testing
function createTestApp() {
  const app = new Hono();

  // Mock auth middleware
  app.use('*', async (c, next) => {
    c.set('user', { userId: 1, username: 'testuser', role: 'user' });
    await next();
  });

  app.route('/bets', betRoutes);
  return app;
}

const app = createTestApp();
const client = testClient(app);

describe('Bets API', () => {
  describe('GET /bets', () => {
    it('returns paginated response structure', async () => {
      const res = await client.bets.$get({ query: { page: '1', limit: '10' } });
      expect(res.status).toBe(200);
      const json = await res.json();
      // When DB is empty, data is empty but structure is correct
      expect(json).toHaveProperty('data');
      expect(json).toHaveProperty('meta');
      expect(json.meta).toHaveProperty('page');
      expect(json.meta).toHaveProperty('limit');
      expect(json.meta).toHaveProperty('total');
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  describe('GET /bets/stats', () => {
    it('returns stats structure', async () => {
      const res = await client.bets.stats.$get();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty('totalBets');
      expect(json).toHaveProperty('winRate');
      expect(json).toHaveProperty('totalProfit');
      expect(json).toHaveProperty('averageROI');
      expect(typeof json.totalBets).toBe('number');
    });
  });

  describe('POST /bets', () => {
    it('rejects invalid body with 400', async () => {
      const res = await client.bets.$post({
        json: { invalid: true } as any,
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing required fields', async () => {
      const res = await client.bets.$post({
        json: { match: 'Test Match' } as any,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /bets/:id', () => {
    it('returns 404 for non-existent bet', async () => {
      const res = await client.bets[':id'].$put({
        param: { id: '00000000-0000-0000-0000-000000000000' },
        json: {
          match: 'Updated Match',
          odds: 1.5,
          amount: 100,
          result: 'Win' as const,
        },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /bets/:id', () => {
    it('returns 404 for non-existent bet', async () => {
      const res = await client.bets[':id'].$delete({
        param: { id: '00000000-0000-0000-0000-000000000000' },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /bets/:id', () => {
    it('accepts partial update (validates via updateBetSchema)', async () => {
      const res = await client.bets[':id'].$patch({
        param: { id: '00000000-0000-0000-0000-000000000000' },
        json: { result: 'Win' as const },
      });
      // 404 because bet doesn't exist, but NOT 400 (schema passed)
      expect(res.status).toBe(404);
    });

    it('rejects invalid result value', async () => {
      const res = await client.bets[':id'].$patch({
        param: { id: '00000000-0000-0000-0000-000000000000' },
        json: { result: 'InvalidStatus' } as any,
      });
      expect(res.status).toBe(400);
    });
  });
});
