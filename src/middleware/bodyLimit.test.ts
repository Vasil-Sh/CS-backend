import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from './bodyLimit';

describe('bodyLimit middleware', () => {
  it('allows requests under the limit', async () => {
    const app = new Hono();
    app.use('*', bodyLimit(1000));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Length': '500' },
      body: JSON.stringify({ data: 'small' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests over the limit', async () => {
    const app = new Hono();
    app.use('*', bodyLimit(100));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Length': '500' },
      body: JSON.stringify({ data: 'x'.repeat(500) }),
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe('Payload too large');
    expect(json.maxBytes).toBe(100);
    expect(json.received).toBe(500);
  });

  it('allows requests with no Content-Length header', async () => {
    const app = new Hono();
    app.use('*', bodyLimit(1000));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      body: JSON.stringify({ data: 'test' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects exact limit + 1', async () => {
    const app = new Hono();
    app.use('*', bodyLimit(10));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Length': '11' },
      body: '12345678901',
    });
    expect(res.status).toBe(413);
  });

  it('allows exact limit', async () => {
    const app = new Hono();
    app.use('*', bodyLimit(10));
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Length': '10' },
      body: '1234567890',
    });
    expect(res.status).toBe(200);
  });
});
