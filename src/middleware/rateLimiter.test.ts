import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimiterMiddleware } from './rateLimiter';

describe('rateLimiterMiddleware', () => {
  function makeApp() {
    const app = new Hono();
    app.use('*', rateLimiterMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.post('/api/auth/login', (c) => c.json({ token: 'test' }));
    return app;
  }

  it('allows requests under the limit', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('sets rate limit headers', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.has('X-RateLimit-Remaining')).toBe(true);
    expect(res.headers.has('X-RateLimit-Reset')).toBe(true);
  });

  it('skips rate limiting for health endpoint', async () => {
    const app = makeApp();
    // Send many requests to health — should never be rate limited
    for (let i = 0; i < 150; i++) {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    }
  });

  it('skips rate limiting for login endpoint', async () => {
    const app = makeApp();
    for (let i = 0; i < 150; i++) {
      const res = await app.request('/api/auth/login', { method: 'POST' });
      expect(res.status).toBe(200);
    }
  });

  it('blocks requests exceeding the limit', async () => {
    const app = makeApp();
    // Send 101 requests (limit is 100) — some may be 429 if map wasn't cleared
    for (let i = 0; i < 100; i++) {
      await app.request('/test');
    }
    // Should definitely be blocked now
    const blocked = await app.request('/test');
    expect(blocked.status).toBe(429);
    const json = await blocked.json();
    expect(json.error).toBe('Too many requests. Try again later.');
  });

  it('uses x-forwarded-for header for IP', async () => {
    const app = makeApp();
    const res = await app.request('/test', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    });
    expect(res.status).toBe(200);
  });
});
