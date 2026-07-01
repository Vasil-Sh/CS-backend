import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { loginSchema, registerSchema, updateUserSchema } from '../middleware/validation';
import { authService } from '../services/authService';
import { verifyRefreshToken, signToken, signRefreshToken } from '../utils/jwt';

const auth = new Hono();

auth.post('/login', async (c) => {
  let body;
  try { body = loginSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input: username and password required' }, 400); }
  const result = await authService.login(body.username, body.password);
  if (!result.success) return c.json({ success: false, error: result.error }, result.status);
  const isProd = process.env.NODE_ENV === 'production';
  c.header('Set-Cookie', `auth_token=${result.token}; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`, { append: true });
  return c.json({ success: true, isAdmin: result.isAdmin, token: result.token, refreshToken: result.refreshToken, user: result.user });
});

// ── POST /api/auth/refresh ──
auth.post('/refresh', async (c) => {
  let body: { refreshToken?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid input' }, 400); }
  if (!body.refreshToken) return c.json({ error: 'Refresh token required' }, 400);
  try {
    const payload = verifyRefreshToken(body.refreshToken);
    const user = await authService.getMe(payload.userId);
    if (!user) return c.json({ error: 'User not found' }, 401);
    const token = signToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    const refreshToken = signRefreshToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    const isProd = process.env.NODE_ENV === 'production';
    c.header('Set-Cookie', `auth_token=${token}; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`, { append: true });
    return c.json({ token, refreshToken });
  } catch { return c.json({ error: 'Invalid or expired refresh token' }, 401); }
});

auth.post('/register', requireAuth, requireAdmin, async (c) => {
  let body;
  try { body = registerSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input' }, 400); }
  const user = await authService.register(body);
  if (!user) return c.json({ error: 'Username already exists' }, 409);
  return c.json({ success: true, ...user }, 201);
});

auth.get('/me', requireAuth, async (c) => {
  const row = await authService.getMe(c.get('user').userId);
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json({ id: row.id, username: row.username, role: row.role, telegram: row.telegram, startDate: row.startDate, endDate: row.endDate });
});

auth.get('/users', requireAuth, requireAdmin, async (c) => {
  const all = await authService.listUsers();
  return c.json(all.map(u => ({ id: u.id, username: u.username, role: u.role, telegram: u.telegram, priceMonth: u.priceMonth, startDate: u.startDate, endDate: u.endDate, createdAt: u.createdAt })));
});

auth.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  await authService.deleteUser(id);
  return c.json({ success: true });
});

auth.put('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  let body;
  try { body = updateUserSchema.parse(await c.req.json()); } catch { return c.json({ error: 'Invalid input' }, 400); }
  const updated = await authService.updateUser(id, body);
  if (!updated) return c.json({ error: 'User not found' }, 404);
  return c.json({ id: updated.id, username: updated.username, role: updated.role, telegram: updated.telegram, priceMonth: updated.priceMonth, startDate: updated.startDate, endDate: updated.endDate });
});

export default auth;
