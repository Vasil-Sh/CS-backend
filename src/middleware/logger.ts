import type { Context, Next } from 'hono';

/**
 * Logs every request: method, path, status, duration.
 */
export async function loggerMiddleware(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  const color = status < 400 ? '\x1b[32m' : status < 500 ? '\x1b[33m' : '\x1b[31m';
  console.log(`${color}${method}\x1b[0m ${path} \x1b[90m${status}\x1b[0m \x1b[90m${duration}ms\x1b[0m`);
}
