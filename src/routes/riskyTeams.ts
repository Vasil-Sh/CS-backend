import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { z } from 'zod';

const riskyTeams = new Hono();

// ── GET /api/risky-teams ──
riskyTeams.get('/', async (c) => {
  const rows = await db.select().from(schema.riskyTeams).orderBy(schema.riskyTeams.name);
  return c.json(rows.map((r) => ({ id: r.id, name: r.name, game: r.game, status: r.status, notes: r.notes })));
});

// ── POST /api/risky-teams (admin only) ──
riskyTeams.post('/', requireAuth, requireAdmin, async (c) => {
  const body = z.object({
    name: z.string().min(1).max(200),
    game: z.string().max(20).optional().default(''),
    status: z.string().max(50).optional().default(''),
    notes: z.string().optional().default(''),
  }).parse(await c.req.json());

  const [existing] = await db
    .select()
    .from(schema.riskyTeams)
    .where(eq(schema.riskyTeams.name, body.name))
    .limit(1);

  if (existing) {
    return c.json({ error: 'Team already in list' }, 409);
  }

  const [team] = await db
    .insert(schema.riskyTeams)
    .values({ name: body.name, game: body.game, status: body.status, notes: body.notes })
    .returning();

  return c.json(team, 201);
});

// ── DELETE /api/risky-teams/:id (admin only) ──
riskyTeams.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  await db.delete(schema.riskyTeams).where(eq(schema.riskyTeams.id, id));
  return c.json({ success: true });
});

export default riskyTeams;
