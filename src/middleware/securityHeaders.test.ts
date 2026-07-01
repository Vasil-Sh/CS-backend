import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from './securityHeaders';

describe('securityHeaders', () => {
  function makeApp() {
    const app = new Hono();
    app.use('*', securityHeaders);
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('sets X-Content-Type-Options to nosniff', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sets Strict-Transport-Security header', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('denies framing on non-docs routes', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('allows same-origin framing on /api/docs route', async () => {
    const app = makeApp();
    const res = await app.request('/api/docs');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('sets permissive CSP on /api/docs', async () => {
    const app = makeApp();
    const res = await app.request('/api/docs');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain('unsafe-inline');
    expect(csp).toContain('unpkg.com');
  });

  it('sets strict CSP on API routes', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sets Permissions-Policy', async () => {
    const app = makeApp();
    const res = await app.request('/test');
    const pp = res.headers.get('Permissions-Policy') || '';
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
  });
});
