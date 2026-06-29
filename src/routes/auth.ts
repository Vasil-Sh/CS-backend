import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { signToken } from '../utils/jwt';
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

  return c.json({
    success: true,
    isAdmin: user.role === 'admin',
    token,
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

  const passwordHash = await bcrypt.hash(body.password, 10);

  const [user] = await db
    .insert(schema.users)
    .values({
      username: body.username,
      passwordHash,
      role: body.role || 'user',
      telegram: body.telegram || '',
      priceMonth: body.priceMonth?.toString() || '0',
      endDate: body.endDate || new Date().toISOString().split('T')[0],
    })
    .returning();

  return c.json({ success: true, userId: user.id }, 201);
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

export default auth;
