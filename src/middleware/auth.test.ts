import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, requireAuth, requireAdmin } from './auth';

// Mock JWT
vi.mock('../utils/jwt', () => ({
  verifyToken: vi.fn((token: string) => {
    if (token === 'valid-user-token') {
      return { userId: 1, username: 'test', role: 'user' };
    }
    if (token === 'valid-admin-token') {
      return { userId: 2, username: 'admin', role: 'admin' };
    }
    throw new Error('Invalid token');
  }),
}));

import { verifyToken } from '../utils/jwt';

describe('authMiddleware', () => {
  it('sets user from Bearer token in Authorization header', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json(user || null);
    });

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-user-token' },
    });
    const json = await res.json();
    expect(json).toEqual({ userId: 1, username: 'test', role: 'user' });
  });

  it('sets user from httpOnly cookie', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json(user || null);
    });

    const res = await app.request('/test', {
      headers: { Cookie: 'auth_token=valid-user-token; other=value' },
    });
    const json = await res.json();
    expect(json).toEqual({ userId: 1, username: 'test', role: 'user' });
  });

  it('returns null user when no auth is provided', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json(user || null);
    });

    const res = await app.request('/test');
    const json = await res.json();
    expect(json).toBeNull();
  });

  it('returns null user for invalid token', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json(user || null);
    });

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    const json = await res.json();
    expect(json).toBeNull();
  });
});

describe('requireAuth', () => {
  it('allows authenticated requests', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.use('/test/*', requireAuth);
    app.get('/test/protected', (c) => c.json({ ok: true }));

    const res = await app.request('/test/protected', {
      headers: { Authorization: 'Bearer valid-user-token' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.use('/test/*', requireAuth);
    app.get('/test/protected', (c) => c.json({ ok: true }));

    const res = await app.request('/test/protected');
    expect(res.status).toBe(401);
  });
});

describe('requireAdmin', () => {
  it('allows admin users', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.use('/admin/*', requireAdmin);
    app.get('/admin/dashboard', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/dashboard', {
      headers: { Authorization: 'Bearer valid-admin-token' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 403 for non-admin users', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.use('/admin/*', requireAdmin);
    app.get('/admin/dashboard', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/dashboard', {
      headers: { Authorization: 'Bearer valid-user-token' },
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated users', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.use('/admin/*', requireAdmin);
    app.get('/admin/dashboard', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/dashboard');
    expect(res.status).toBe(401);
  });
});
