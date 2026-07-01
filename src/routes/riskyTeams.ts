import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { riskyTeamSchema } from '../middleware/validation';
import { riskyTeamService } from '../services/riskyTeamService';

const riskyTeams = new Hono();

riskyTeams.get('/', requireAuth, async (c) => {
  const rows = await riskyTeamService.list(c.get('user').userId);
  return c.json(rows.map(r => ({ id: r.id, userId: r.userId, name: r.name, game: r.game, status: r.status, notes: r.notes })));
});

riskyTeams.post('/', requireAuth, requireAdmin, async (c) => {
  let body;
  try { body = riskyTeamSchema.parse(await c.req.json()); }
  catch { return c.json({ error: 'Invalid input: name required (1-200 chars), optional game/status/notes' }, 400); }
  const team = await riskyTeamService.create(c.get('user').userId, body);
  if (!team) return c.json({ error: 'Team already in list' }, 409);
  return c.json(team, 201);
});

riskyTeams.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  await riskyTeamService.remove(id);
  return c.json({ success: true });
});

export default riskyTeams;
