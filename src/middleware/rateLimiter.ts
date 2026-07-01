import type { Context, Next } from 'hono';

// In-memory rate limiter
const requestCounts = new Map<string, { count: number; resetAt: number }>();

const MAX_REQUESTS = 100;
const WINDOW_MS = 60 * 1000; // 1 minute

// Per-user rate limit: 300 requests/min for authenticated users
const USER_MAX_REQUESTS = 300;

/**
 * Rate limiting middleware: 100 req/min per IP, + 300 req/min per user.
 * Free tier (health, login) is exempt.
 */
export async function rateLimiterMiddleware(c: Context, next: Next) {
  // Skip rate limiting for public health + login
  const path = c.req.path;
  if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/refresh') {
    return next();
  }

  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const key = `rate:${ip}`;
  const now = Date.now();

  let entry = requestCounts.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    requestCounts.set(key, entry);
  }

  entry.count++;

  c.res.headers.set('X-RateLimit-Limit', String(MAX_REQUESTS));
  c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, MAX_REQUESTS - entry.count)));
  c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > MAX_REQUESTS) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  // Per-user rate limiting (only for authenticated users)
  const user = c.get('user') as { userId?: number } | undefined;
  if (user?.userId) {
    const userKey = `rate:user:${user.userId}`;
    let userEntry = requestCounts.get(userKey);
    if (!userEntry || now > userEntry.resetAt) {
      userEntry = { count: 0, resetAt: now + WINDOW_MS };
      requestCounts.set(userKey, userEntry);
    }
    userEntry.count++;

    if (userEntry.count > USER_MAX_REQUESTS) {
      return c.json({ error: 'Too many requests. Try again later.' }, 429);
    }
  }

  await next();
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now > entry.resetAt) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);
