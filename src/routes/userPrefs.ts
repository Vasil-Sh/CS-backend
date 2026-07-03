import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { db, schema } from '../db/client';
import { eq } from 'drizzle-orm';

const userPrefs = new Hono();

// GET /api/user/prefs — get preferences + max_stake_percent for current user
userPrefs.get('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const [user] = await db.select({
    maxStakePercent: schema.users.maxStakePercent,
    preferences: schema.users.preferences,
  }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json({
    maxStakePercent: user.maxStakePercent ?? 7,
    preferences: user.preferences ?? {},
  });
});

// PUT /api/user/prefs — update preferences and/or max_stake_percent
userPrefs.put('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  let body: { maxStakePercent?: number; preferences?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.maxStakePercent !== undefined) {
    if (body.maxStakePercent < 1 || body.maxStakePercent > 100) return c.json({ error: 'maxStakePercent must be 1-100' }, 400);
    updates.maxStakePercent = body.maxStakePercent;
  }
  if (body.preferences !== undefined) {
    const [user] = await db.select({ preferences: schema.users.preferences })
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const merged = { ...(user?.preferences ?? {}), ...body.preferences };
    updates.preferences = merged;
  }

  if (Object.keys(updates).length <= 1) return c.json({ error: 'Nothing to update' }, 400);

  const [updated] = await db.update(schema.users).set(updates as any)
    .where(eq(schema.users.id, userId))
    .returning({ maxStakePercent: schema.users.maxStakePercent, preferences: schema.users.preferences });
  return c.json({
    maxStakePercent: updated.maxStakePercent ?? 7,
    preferences: updated.preferences ?? {},
  });
});

export default userPrefs;
