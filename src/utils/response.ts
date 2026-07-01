import type { Context } from 'hono';

/**
 * Consistent API response helpers.
 * All error/success responses use the same shape:
 *   Error:   { error: string, details?: any }
 *   Success: { data: T }  (wrapped)
 *   List:    { data: T[], meta: { page, limit, total } }
 */

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ data }, status);
}

export function created<T>(c: Context, data: T) {
  return c.json({ data }, 201);
}

export function noContent(c: Context) {
  return c.body(null, 204);
}

export function err(c: Context, message: string, status = 400, details?: unknown) {
  const body: Record<string, unknown> = { error: message };
  if (details) body.details = details;
  return c.json(body, status as any);
}

export function paginated<T>(
  c: Context,
  rows: T[],
  meta: { page: number; limit: number; total: number }
) {
  return c.json({
    data: rows,
    meta: {
      page: meta.page,
      limit: meta.limit,
      total: meta.total,
      totalPages: Math.ceil(meta.total / meta.limit),
    },
  });
}

/** Extract pagination params from query string (safe defaults) */
export function getPagination(c: Context) {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}
