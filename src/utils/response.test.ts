import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { ok, created, noContent, err, paginated, getPagination } from './response';

function mockContext(jsonData?: any, query?: Record<string, string>) {
  const app = new Hono();
  let captured: any = null;
  let capturedStatus = 0;

  app.get('/test', (c) => {
    // Mock query params
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        // We'll use getPagination directly
      }
    }
    if (jsonData) return c.json(jsonData, 200);
    return c.body(null, 204);
  });

  return { app };
}

describe('getPagination', () => {
  function makeC(query: Record<string, string>) {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      // Override req.query for test
      const origQuery = c.req.query.bind(c.req);
      (c.req as any).query = (k: string) => query[k] || origQuery(k);
      result = getPagination(c);
      return c.json({});
    });
    return { getResult: () => result, app };
  }

  it('returns default page=1, limit=50', async () => {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      result = getPagination(c);
      return c.json({});
    });
    await app.request('/test');
    expect(result).toEqual({ page: 1, limit: 50, offset: 0 });
  });

  it('parses page and limit from query', async () => {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      result = getPagination(c);
      return c.json({});
    });
    await app.request('/test?page=3&limit=20');
    expect(result).toEqual({ page: 3, limit: 20, offset: 40 });
  });

  it('clamps page to minimum 1', async () => {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      result = getPagination(c);
      return c.json({});
    });
    await app.request('/test?page=-5&limit=10');
    expect(result.page).toBe(1);
  });

  it('clamps limit to maximum 100', async () => {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      result = getPagination(c);
      return c.json({});
    });
    await app.request('/test?page=1&limit=500');
    expect(result.limit).toBe(100);
  });

  it('clamps limit=0 to default 50 (0 is falsy, triggers default)', async () => {
    const app = new Hono();
    let result: any;
    app.get('/test', (c) => {
      result = getPagination(c);
      return c.json({});
    });
    await app.request('/test?page=1&limit=0');
    // limit=0 → parseInt('0')=0 → 0||50=50 → max(1,50)=50
    expect(result.limit).toBe(50);
  });
});

describe('paginated', () => {
  it('returns correct structure', async () => {
    const app = new Hono();
    let status = 0;
    let body: any;

    app.get('/test', (c) => {
      const resp = paginated(c, [{ id: 1 }, { id: 2 }], { page: 1, limit: 10, total: 25 });
      status = (resp as any).status || 200;
      return resp;
    });

    const res = await app.request('/test');
    const json = await res.json();
    expect(json).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, limit: 10, total: 25, totalPages: 3 },
    });
  });

  it('calculates totalPages correctly', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return paginated(c, [], { page: 1, limit: 10, total: 0 });
    });
    const res = await app.request('/test');
    const json = await res.json();
    expect(json.meta.totalPages).toBe(0);
  });
});

describe('err', () => {
  it('returns error with message and status', async () => {
    const app = new Hono();
    app.get('/test', (c) => err(c, 'Not found', 404));
    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: 'Not found' });
  });

  it('includes details when provided', async () => {
    const app = new Hono();
    app.get('/test', (c) => err(c, 'Invalid', 400, { field: 'name' }));
    const res = await app.request('/test');
    const json = await res.json();
    expect(json).toEqual({ error: 'Invalid', details: { field: 'name' } });
  });

  it('defaults to 400 status', async () => {
    const app = new Hono();
    app.get('/test', (c) => err(c, 'Bad request'));
    const res = await app.request('/test');
    expect(res.status).toBe(400);
  });
});

describe('ok / created / noContent', () => {
  it('ok wraps data with status 200', async () => {
    const app = new Hono();
    app.get('/test', (c) => ok(c, { name: 'test' }));
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: { name: 'test' } });
  });

  it('created wraps data with status 201', async () => {
    const app = new Hono();
    app.post('/test', (c) => created(c, { id: 1 }));
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { id: 1 } });
  });

  it('noContent returns 204 with no body', async () => {
    const app = new Hono();
    app.delete('/test', (c) => noContent(c));
    const res = await app.request('/test', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});
