import type { Context, Next } from 'hono';
import { verifyToken, type JwtPayload } from '../utils/jwt';

/**
 * Attach user to context if valid Bearer token present or httpOnly cookie set.
 * Does NOT reject — routes that require auth call `requireAuth` after.
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Try Authorization header first
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = verifyToken(token);
      c.set('user', payload);
    } catch {
      // Invalid/expired token — silently continue
    }
  }

  // 2. Try httpOnly cookie as fallback
  if (!c.get('user')) {
    const cookieToken = c.req.header('Cookie')?.match(/auth_token=([^;]+)/)?.[1];
    if (cookieToken) {
      try {
        const payload = verifyToken(cookieToken);
        c.set('user', payload);
      } catch {
        // Invalid/expired cookie — silently continue
      }
    }
  }

  await next();
}

/**
 * Middleware that rejects if no valid user on context.
 * Must run AFTER authMiddleware.
 */
export async function requireAuth(c: Context, next: Next) {
  const user = c.get('user') as JwtPayload | undefined;
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}

/**
 * Rejects if user is not admin.
 */
export async function requireAdmin(c: Context, next: Next) {
  const user = c.get('user') as JwtPayload | undefined;
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden: admin only' }, 403);
  }
  await next();
}

// Attach types to Hono Context
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}
