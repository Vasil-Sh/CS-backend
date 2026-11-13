import { Hono } from 'hono';
import { pool } from '../db/client';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { loginSchema, registerSchema, updateUserSchema } from '../middleware/validation';
import { authService } from '../services/authService';
import { checkDelete, checkResetPassword, checkUpdate } from '../services/ownerRules';
import { adminUsersService } from '../services/adminUsersService';
import { adminStatsService } from '../services/adminStatsService';
import { verifyRefreshToken, signToken, signRefreshToken } from '../utils/jwt';
import { blocklistJti, isBlocked } from '../utils/jwtBlocklist';
import { AppError } from '../utils/AppError';
import { clientIp, recordLoginFailure, clearLoginFailures, loginBlockedMs, loginAttemptsLeft } from '../utils/loginRateLimit';
import { sessionsService } from '../services/sessionsService';
import jwt from 'jsonwebtoken';

const auth = new Hono();

/** Invalidate the cached admin overviews + stats after any user mutation. */
function invalidateAdminCaches(): void {
  adminUsersService.invalidateOverview();
  adminStatsService.invalidate();
}

auth.post('/login', async (c) => {
  try {
    let body;
    try { body = loginSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input: username and password required' }, 400); }
    const ip = clientIp(c.req.header());
    const blocked = loginBlockedMs(ip, body.username);
    if (blocked > 0) {
      return c.json({ success: false, error: `Забагато спроб. Спробуйте за ${Math.ceil(blocked / 60000)} хв`, attemptsLeft: 0, retryAfter: Math.ceil(blocked / 1000) }, 429);
    }
    const result = await authService.login(body.username, body.password);
    if (!result.success) {
      recordLoginFailure(ip, body.username);
      const attemptsLeft = loginAttemptsLeft(ip, body.username);
      if (attemptsLeft === 0) void auditAdminLockout(body.username, ip);
      return c.json({ success: false, error: result.error, attemptsLeft }, result.status as any);
    }
    clearLoginFailures(ip, body.username);
    if (result.token && result.refreshToken && result.user) {
      void sessionsService.record(result.refreshToken, result.user.id, ip, c.req.header('user-agent') || '');
    }
    const isProd = process.env.NODE_ENV === 'production';
    c.header('Set-Cookie', `auth_token=${result.token}; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`, { append: true });
    return c.json({ success: true, isAdmin: result.isAdmin, token: result.token, refreshToken: result.refreshToken, user: result.user });
  } catch (err: any) {
    console.error('[Auth/Login] Unexpected error:', err.message, err.stack);
    return c.json({ error: 'Login failed: ' + (err.message || 'unknown error') }, 500);
  }
});

// ── POST /api/auth/refresh ──
auth.post('/refresh', async (c) => {
  let body: { refreshToken?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid input' }, 400); }
  if (!body.refreshToken) return c.json({ error: 'Refresh token required' }, 400);
  try {
    const payload = verifyRefreshToken(body.refreshToken);
    if (await isBlocked(payload.jti)) return c.json({ error: 'Session revoked' }, 401);
    const user = await authService.getMe(payload.userId);
    if (!user) return c.json({ error: 'User not found' }, 401);
    const token = signToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    const refreshToken = signRefreshToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    void sessionsService.record(refreshToken, user.id, clientIp(c.req.header()), c.req.header('user-agent') || '');
    const isProd = process.env.NODE_ENV === 'production';
    c.header('Set-Cookie', `auth_token=${token}; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`, { append: true });
    return c.json({ token, refreshToken });
  } catch { return c.json({ error: 'Invalid or expired refresh token' }, 401); }
});

// ── POST /api/auth/logout ──
auth.post('/logout', async (c) => {
  try {
    // Try to extract token from header or cookie
    let token: string | undefined;
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      token = c.req.header('Cookie')?.match(/auth_token=([^;]+)/)?.[1];
    }
    if (!token) return c.json({ success: true }); // nothing to revoke

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || '') as import('../utils/jwt').JwtPayload;
      const now = Math.floor(Date.now() / 1000);
      const remainingSec = Math.max(0, payload.exp - now);
      await blocklistJti(payload.jti, remainingSec * 1000);
    } catch {
      // Token already expired — nothing to revoke
    }

    // Clear auth cookie
    c.header('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', { append: true });
    return c.json({ success: true });
  } catch (err: unknown) {
    const e = err as Error;
    throw new AppError('Logout failed: ' + e.message, 500, 'LOGOUT_ERROR');
  }
});

/** Decode the jti from a refresh token ('' if invalid). */
function refreshJti(token?: string): string {
  if (!token) return '';
  try {
    const d = jwt.decode(token) as { jti?: string } | null;
    return d?.jti ?? '';
  } catch {
    return '';
  }
}

// ── GET /api/auth/sessions — active sessions for the current user ──
auth.get('/sessions', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const current = refreshJti(c.req.header('Authorization')?.replace('Bearer ', '') || '');
  const sessions = await sessionsService.list(userId, current);
  return c.json({ sessions });
});

// ── DELETE /api/auth/sessions/:id — terminate one session ──
auth.delete('/sessions/:id', requireAuth, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid session' }, 400);
  const userId = c.get('user').userId;
  const { rows } = await pool.query(
    'SELECT refresh_jti AS jti FROM sessions WHERE id::text=$1 AND user_id=$2',
    [id, userId],
  );
  const row = rows[0] as any;
  if (!row) return c.json({ error: 'Session not found' }, 404);
  // Blocklist the refresh token (access token expires on its own shortly).
  const decoded = jwt.decode(row.jti as string) as { exp?: number } | null;
  const remainingSec = decoded?.exp ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)) : 0;
  if (remainingSec > 0) await blocklistJti(row.jti, remainingSec * 1000);
  await pool.query('DELETE FROM sessions WHERE id::text=$1', [id]);
  return c.json({ success: true });
});

// ── POST /api/auth/logout-all — sign out on all other devices ──
auth.post('/logout-all', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const body = await c.req.json().catch(() => null);
  const current = refreshJti(body?.refreshToken);
  const jtis = await sessionsService.jtisExcept(userId, current || null);
  for (const jti of jtis) {
    const decoded = jwt.decode(jti) as { exp?: number } | null;
    const remainingSec = decoded?.exp ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)) : 0;
    if (remainingSec > 0) await blocklistJti(jti, remainingSec * 1000);
  }
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND refresh_jti IS DISTINCT FROM $2', [userId, current || null]);
  return c.json({ success: true, revoked: jtis.length });
});

// ── POST /api/auth/change-password — change own password ──
auth.post('/change-password', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
    return c.json({ error: 'Invalid input' }, 400);
  }
  if (body.newPassword.length < 4 || body.newPassword.length > 255) {
    return c.json({ error: 'Новий пароль — від 4 до 255 символів' }, 400);
  }
  const user = await authService.getMe(c.get('user').userId);
  if (!user) return c.json({ error: 'User not found' }, 404);
  const ok = await authService.verifyPassword(body.currentPassword, user.passwordHash);
  if (!ok) return c.json({ error: 'Поточний пароль неправильний' }, 401);
  await authService.setPassword(user.id, body.newPassword);
  return c.json({ success: true });
});

auth.post('/register', requireAuth, requireAdmin, async (c) => {
  let body;
  try { body = registerSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input' }, 400); }
  const result = await authService.register(body, c.get('user'));
  if (!result) return c.json({ error: 'Username already exists' }, 409);
  invalidateAdminCaches();
  return c.json({ success: true, userId: result.userId, username: result.username, password: result.password }, 201);
});

auth.get('/me', requireAuth, async (c) => {
  const row = await authService.getMe(c.get('user').userId);
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json({ id: row.id, username: row.username, role: row.role, isOwner: row.isOwner, telegram: row.telegram, plan: row.plan, trialEndDate: row.trialEndDate, ageConfirmed: row.ageConfirmed, startDate: row.startDate, endDate: row.endDate });
});

auth.get('/users', requireAuth, requireAdmin, async (c) => {
  const all = await authService.listUsers();
  return c.json(all.map(u => ({ id: u.id, username: u.username, role: u.role, isOwner: u.isOwner, telegram: u.telegram, priceMonth: u.priceMonth, plan: u.plan, trialEndDate: u.trialEndDate, ageConfirmed: u.ageConfirmed, startDate: u.startDate, endDate: u.endDate, createdAt: u.createdAt })));
});

auth.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const [actor, target, owners] = await Promise.all([
    authService.getAccess(c.get('user').userId), authService.getAccess(id), authService.countOwners(),
  ]);
  if (!actor) return c.json({ error: 'Unauthorized' }, 401);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const denied = checkDelete(actor, target, owners);
  if (denied) return c.json({ error: denied.error }, denied.status);
  await authService.deleteUser(id);
  invalidateAdminCaches();
  return c.json({ success: true });
});

auth.put('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  let body;
  try { body = updateUserSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input' }, 400); }
  const [actor, target, owners] = await Promise.all([
    authService.getAccess(c.get('user').userId), authService.getAccess(id), authService.countOwners(),
  ]);
  if (!actor) return c.json({ error: 'Unauthorized' }, 401);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const access = checkUpdate(actor, target, { role: body.role, isOwner: body.isOwner, password: !!body.password }, owners);
  if ('error' in access) return c.json({ error: access.error }, access.status);
  const updated = await authService.updateUser(id, { ...body, role: access.role, isOwner: access.isOwner });
  if (!updated) return c.json({ error: 'User not found' }, 404);
  invalidateAdminCaches();
  return c.json({ id: updated.id, username: updated.username, role: updated.role, isOwner: updated.isOwner, telegram: updated.telegram, priceMonth: updated.priceMonth, startDate: updated.startDate, endDate: updated.endDate });
});

// ── POST /api/auth/users/:id/reset-password ──
auth.post('/users/:id/reset-password', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const [actor, target] = await Promise.all([authService.getAccess(c.get('user').userId), authService.getAccess(id)]);
  if (!actor) return c.json({ error: 'Unauthorized' }, 401);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const denied = checkResetPassword(actor, target);
  if (denied) return c.json({ error: denied.error }, denied.status);
  const result = await authService.resetPassword(id);
  if (!result) return c.json({ error: 'User not found' }, 404);
  return c.json({ username: result.username, password: result.password });
});

/** Admin account locked after too many failed logins — visible to the owner in the audit log. */
async function auditAdminLockout(username: string, ip: string): Promise<void> {
  try {
    const found = await pool.query(`SELECT id FROM users WHERE lower(username) = lower($1) AND role = 'admin' LIMIT 1`, [username.trim()]);
    const admin = found.rows[0];
    if (!admin) return; // regular app users are not audited here
    await pool.query(
      `INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status) VALUES($1,$2,'LOGIN_LOCKED','/auth/login',$3,'failed')`,
      [admin.id, username.trim(), JSON.stringify({ targetUsername: username.trim(), _targetUserId: String(admin.id), ip, lockedMinutes: 5 })],
    );
  } catch (err) {
    console.warn('[Auth/Login] lockout audit failed:', (err as Error).message);
  }
}

export default auth;
