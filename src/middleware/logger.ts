import type { Context, Next } from 'hono';

/**
 * Structured request logger with error details.
 * Logs every request: method, path, status, duration.
 * On 5xx errors, also logs the error message.
 */
export async function loggerMiddleware(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '-';

  try {
    await next();
  } catch (err: unknown) {
    const e = err as Error;
    const duration = Date.now() - start;
    console.error(JSON.stringify({
      level: 'error',
      method,
      path,
      status: 500,
      durationMs: duration,
      ip,
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 3).join(' | '),
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }

  const duration = Date.now() - start;
  const status = c.res.status;

  if (status >= 500) {
    console.error(JSON.stringify({
      level: 'error',
      method,
      path,
      status,
      durationMs: duration,
      ip,
      timestamp: new Date().toISOString(),
    }));
  } else {
    const color = status < 400 ? '\x1b[32m' : status < 500 ? '\x1b[33m' : '\x1b[31m';
    console.log(`${color}${method}\x1b[0m ${path} \x1b[90m${status}\x1b[0m \x1b[90m${duration}ms\x1b[0m`);
  }
}
