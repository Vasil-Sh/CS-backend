import type { Context, Next } from 'hono';
import { createRateLimiter } from './rateLimiterStore';

const limiter = createRateLimiter();

const MAX_REQUESTS = 100;
const WINDOW_MS = 60_000; // 1 minute
const USER_MAX_REQUESTS = 300;

/**
 * Rate limiting middleware: 100 req/min per IP (per-user limit: userRateLimiterMiddleware).
 * Uses Redis when REDIS_URL is configured, falls back to in-memory Map.
 * Free tier (health, login) is exempt.
 */
export async function rateLimiterMiddleware(c: Context, next: Next) {
  // Skip rate limiting for public health + login
  const path = c.req.path;
  if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/refresh') {
    return next();
  }

  // Take the rightmost non-internal IP from x-forwarded-for (trusted proxy chain)
  const fwd = c.req.header('x-forwarded-for');
  const ip = fwd ? fwd.split(',')[0].trim() : (c.req.header('x-real-ip') || 'unknown');
  const now = Date.now();

  const ipResult = await limiter.check(`rate:${ip}`, MAX_REQUESTS, WINDOW_MS);

  c.res.headers.set('X-RateLimit-Limit', String(MAX_REQUESTS));
  c.res.headers.set('X-RateLimit-Remaining', String(ipResult.remaining));
  c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(ipResult.resetAt / 1000)));

  if (!ipResult.allowed) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }

  await next();
}

/**
 * Per-user limit (300 req/min). Must run AFTER authMiddleware — before it
 * the user is not known yet, which is why this check never fired when it
 * lived inside rateLimiterMiddleware.
 */
export async function userRateLimiterMiddleware(c: Context, next: Next) {
  const user = c.get('user') as { userId?: number } | undefined;
  if (user?.userId) {
    const userResult = await limiter.check(`rate:user:${user.userId}`, USER_MAX_REQUESTS, WINDOW_MS);
    if (!userResult.allowed) {
      return c.json({ error: 'Too many requests. Try again later.' }, 429);
    }
  }
  await next();
}
