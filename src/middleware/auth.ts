import type { Context, Next } from 'hono';
import { verifyToken, type JwtPayload } from '../utils/jwt';
import { isBlocked } from '../utils/jwtBlocklist';
import { getUserState } from '../utils/userState';
import { sessionProblem } from '../services/sessionRules';

/**
 * Attach user to context if valid Bearer token present or httpOnly cookie set.
 * Also checks JWT blocklist for revoked tokens.
 * Does NOT reject — routes that require auth call `requireAuth` after.
 */
/** Accept a verified token only if the account still allows it (see sessionRules). */
async function acceptToken(c: Context, payload: JwtPayload): Promise<void> {
  if (await isBlocked(payload.jti)) return; // revoked by logout
  const state = await getUserState(payload.userId);
  if (state === undefined) { c.set('user', payload); return; } // DB unreachable — trust the signed token
  if (sessionProblem(payload.tv, state)) return;
  // Role comes from the DB, so demoting an admin takes effect immediately.
  c.set('user', state!.role === payload.role ? payload : { ...payload, role: state!.role as JwtPayload['role'] });
}

/**
 * Attach user to context if valid Bearer token present or httpOnly cookie set.
 * Checks the JWT blocklist and the account's current state.
 * Does NOT reject — routes that require auth call `requireAuth` after.
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Try Authorization header first
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    try {
      await acceptToken(c, verifyToken(auth.slice(7)));
    } catch {
      // Invalid/expired token — silently continue
    }
  }

  // 2. Try httpOnly cookie as fallback
  if (!c.get('user')) {
    const cookieToken = c.req.header('Cookie')?.match(/auth_token=([^;]+)/)?.[1];
    if (cookieToken) {
      try {
        await acceptToken(c, verifyToken(cookieToken));
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
