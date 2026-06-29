import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { signToken, signRefreshToken, verifyRefreshToken, type JwtPayload } from '../utils/jwt';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '../middleware/validation';

const auth = new Hono();

// ── POST /api/auth/login ──
auth.post('/login', async (c) => {
  let body: LoginInput;
  try {
    body = loginSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid input: username and password required' }, 400);
  }

  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, body.username))
    .limit(1);

  if (!user) {
    return c.json({ success: false, error: 'Invalid credentials' }, 401);
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    return c.json({ success: false, error: 'Invalid credentials' }, 401);
  }

  // Check subscription expiry for non-admin users
  if (user.role !== 'admin' && user.endDate) {
    const now = new Date();
    const end = new Date(user.endDate);
    if (end < now) {
      return c.json({ success: false, error: 'Subscription expired' }, 403);
    }
  }

  const token = signToken({
    userId: user.id,
    username: user.username,
    role: user.role as 'admin' | 'user',
  });

  const refreshToken = signRefreshToken({
    userId: user.id,
    username: user.username,
    role: user.role as 'admin' | 'user',
  });

  return c.json({
    success: true,
    isAdmin: user.role === 'admin',
    token,
    refreshToken,
    user: {
      username: user.username,
      role: user.role,
      telegram: user.telegram,
    },
  });
});

// ── POST /api/auth/register (admin only) ──
auth.post('/register', requireAuth, requireAdmin, async (c) => {
  let body: RegisterInput;
  try {
    body = registerSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid input' }, 400);
  }

  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, body.username))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: 'Username already exists' }, 409);
  }

  // Generate a random password if not provided
  const plainPassword = body.password || generatePassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const [user] = await db
    .insert(schema.users)
    .values({
      username: body.username,
      passwordHash,
      role: body.role || 'user',
      telegram: body.telegram || '',
      priceMonth: String(body.priceMonth || '0'),
      endDate: toPgDate(body.endDate),
    })
    .returning();

  return c.json({ success: true, userId: user.id, username: user.username, password: plainPassword }, 201);
});

// ── GET /api/auth/me ──
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user');

  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, user.userId))
    .limit(1);

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    id: row.id,
    username: row.username,
    role: row.role,
    telegram: row.telegram,
    startDate: row.startDate,
    endDate: row.endDate,
  });
});

// ── GET /api/auth/users (admin only, list all) ──
auth.get('/users', requireAuth, requireAdmin, async (c) => {
  const all = await db.select().from(schema.users).orderBy(schema.users.username);
  return c.json(all.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    telegram: u.telegram,
    priceMonth: u.priceMonth,
    startDate: u.startDate,
    endDate: u.endDate,
    createdAt: u.createdAt,
  })));
});

// ── DELETE /api/auth/users/:id (admin only) ──
auth.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  await db.delete(schema.users).where(eq(schema.users.id, id));
  return c.json({ success: true });
});

// ── PUT /api/auth/users/:id (admin only) ──
auth.put('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const updateData: Record<string, unknown> = {};

  if (body.telegram !== undefined) updateData.telegram = String(body.telegram);
  if (body.username !== undefined) updateData.username = String(body.username);
  if (body.password) {
    updateData.passwordHash = await bcrypt.hash(String(body.password), 10);
  }
  if (body.role !== undefined) updateData.role = String(body.role);
  if (body.priceMonth !== undefined) updateData.priceMonth = String(body.priceMonth);
  if (body.startDate !== undefined) updateData.startDate = toPgDate(String(body.startDate));
  if (body.endDate !== undefined) updateData.endDate = toPgDate(String(body.endDate));

  const [updated] = await db
    .update(schema.users)
    .set(updateData)
    .where(eq(schema.users.id, id))
    .returning();

  if (!updated) return c.json({ error: 'User not found' }, 404);

  return c.json({
    id: updated.id,
    username: updated.username,
    role: updated.role,
    telegram: updated.telegram,
    priceMonth: updated.priceMonth,
    startDate: updated.startDate,
    endDate: updated.endDate,
  });
});

// ── POST /api/auth/refresh ──
auth.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json().catch(() => ({}));
  if (!refreshToken) {
    return c.json({ error: 'refreshToken required' }, 400);
  }

  try {
    const payload = verifyRefreshToken(refreshToken);

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, payload.userId))
      .limit(1);

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const token = signToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    const newRefresh = signRefreshToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });

    return c.json({ token, refreshToken: newRefresh });
  } catch {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
});

// ── POST /api/auth/register-telegram (public, with Telegram chat ID) ──
auth.post('/register-telegram', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password, chatId } = body;

  if (!username || !password || !chatId) {
    return c.json({ error: 'username, password, and chatId required' }, 400);
  }

  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: 'Username already exists' }, 409);
  }

  const hash = await bcrypt.hash(password, 10);
  await db.insert(schema.users).values({
    username,
    passwordHash: hash,
    role: 'user',
    telegram: String(chatId),
    priceMonth: '0',
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  });

  return c.json({ success: true }, 201);
});

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

function toPgDate(date: string | undefined): string {
  if (!date) return new Date().toISOString().split('T')[0];
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  // DD/MM/YYYY → YYYY-MM-DD
  const parts = date.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  return date;
}

export default auth;
