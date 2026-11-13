import type { Context, Next } from 'hono';
import { verifyToken, type JwtPayload } from '../utils/jwt';
import { isBlocked } from '../utils/jwtBlocklist';
import { issuedBefore, sessionsRevokedAt } from '../services/sessionRevocation';

/**
 * Attach user to context if valid Bearer token present or httpOnly cookie set.
 * Also checks JWT blocklist for revoked tokens.
 * Does NOT reject — routes that require auth call `requireAuth` after.
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Try Authorization header first
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = verifyToken(token);
      // Check blocklist before accepting
      if (await isBlocked(payload.jti)) {
        // Token revoked — silently continue (will hit requireAuth below)
      } else {
        const revokedAt = await sessionsRevokedAt(payload.userId);
        if (issuedBefore((payload as JwtPayload & { iat?: number }).iat, revokedAt)) c.set('sessionsRevokedAt' as never, revokedAt as never);
        else c.set('user', payload);
      }
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
        if (await isBlocked(payload.jti)) {
          // Revoked — treat as no user
        } else {
          const revokedAt = await sessionsRevokedAt(payload.userId);
          if (issuedBefore((payload as JwtPayload & { iat?: number }).iat, revokedAt)) c.set('sessionsRevokedAt' as never, revokedAt as never);
          else c.set('user', payload);
        }
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
    const revokedAt = c.get('sessionsRevokedAt' as never) as unknown as number | undefined;
    if (revokedAt) return c.json({ error: 'Session revoked', code: 'SESSIONS_REVOKED', revokedAt: new Date(revokedAt).toISOString() }, 401);
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
