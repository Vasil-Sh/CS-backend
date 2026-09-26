import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { riskyTeamSchema } from '../middleware/validation';
import { riskyTeamService } from '../services/riskyTeamService';
import { generateLogoFallback } from '../services/createMatchesRouter';

const riskyTeams = new Hono();

const logoPrefix = (game?: string): 'cs2' | 'dota2' =>
  (game || '').toLowerCase().includes('dota') || game === 'Дота' ? 'dota2' : 'cs2';

riskyTeams.get('/', requireAuth, async (c) => {
  const rows = await riskyTeamService.list(c.get('user').userId);
  return c.json(rows.map(r => ({ id: r.id, userId: r.userId, name: r.name, game: r.game, status: r.status, notes: r.notes, logo: generateLogoFallback(r.name, logoPrefix(r.game)) })));
});

riskyTeams.get('/logo', requireAuth, async (c) => {
  const name = (c.req.query('name') || '').trim();
  const game = c.req.query('game') === 'dota2' ? 'dota2' : 'cs2';
  if (!name) return c.json({ url: null });
  return c.json({ url: generateLogoFallback(name, game) });
});

// Batch logo resolution — one request for many teams (avoids rate limiting)
riskyTeams.post('/logos', requireAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid body' }, 400); }
  const items = Array.isArray(body) ? body : [];
  const result = items.map((it) => {
    const name = typeof (it as { name?: unknown })?.name === 'string' ? String((it as { name: string }).name).trim() : '';
    const game = (it as { game?: unknown })?.game === 'dota2' ? 'dota2' : 'cs2';
    return { name, game, url: name ? generateLogoFallback(name, game) : null };
  });
  return c.json(result);
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
