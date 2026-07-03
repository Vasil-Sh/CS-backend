import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { db, schema } from '../db/client';
import { eq, and } from 'drizzle-orm';

const matchRatings = new Hono();

// GET /api/match-ratings — list all ratings for current user
matchRatings.get('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const rows = await db.select().from(schema.matchRatings).where(eq(schema.matchRatings.userId, userId));
  return c.json(rows);
});

// POST /api/match-ratings — upsert a rating (like/dislike)
matchRatings.post('/', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  let body: { matchId: string; rating: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!body.matchId || !body.rating) return c.json({ error: 'matchId and rating required' }, 400);
  if (!['like', 'dislike'].includes(body.rating)) return c.json({ error: 'rating must be like or dislike' }, 400);

  const [existing] = await db.select().from(schema.matchRatings)
    .where(and(eq(schema.matchRatings.userId, userId), eq(schema.matchRatings.matchId, body.matchId)))
    .limit(1);

  if (existing) {
    const [updated] = await db.update(schema.matchRatings)
      .set({ rating: body.rating, updatedAt: new Date() })
      .where(eq(schema.matchRatings.id, existing.id))
      .returning();
    return c.json(updated);
  }

  const [created] = await db.insert(schema.matchRatings).values({
    userId,
    matchId: body.matchId,
    rating: body.rating,
  }).returning();
  return c.json(created, 201);
});

// DELETE /api/match-ratings/:matchId — remove a rating
matchRatings.delete('/:matchId', requireAuth, async (c) => {
  const userId = c.get('user').userId;
  const matchId = c.req.param('matchId') || '';
  if (!matchId) return c.json({ error: 'matchId required' }, 400);
  const [found] = await db.select().from(schema.matchRatings)
    .where(and(eq(schema.matchRatings.userId, userId), eq(schema.matchRatings.matchId, matchId)))
    .limit(1);
  if (!found) return c.json({ error: 'Rating not found' }, 404);
  await db.delete(schema.matchRatings).where(eq(schema.matchRatings.id, found.id));
  return c.json({ success: true });
});

export default matchRatings;
