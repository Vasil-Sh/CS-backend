import { listChanges, recordChanges } from '../services/matchChanges';
import { forgetAliases } from '../services/matchFeed';
import { Hono } from 'hono';
import { deleteTeamLogo, listTeamLogos, saveTeamLogo } from '../services/teamLogos';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import {
  adminMatchesService,
  type LinkDecision,
  type MatchStatus,
} from '../services/adminMatchesService';
import { logoCatalog } from '../services/logoStore';

const matches = new Hono();

/** Write a lightweight audit entry for a mutating admin action. */
function audit(actor: { userId: number; username: string }, action: string, target: string, details: Record<string, unknown>): void {
  void pool
    .query(
      `INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status)
       VALUES($1,$2,$3,$4,$5,'success')`,
      [actor.userId, actor.username, action, target, JSON.stringify(details)],
    )
    .catch((err) => console.warn('[adminMatches] audit failed:', (err as Error).message));
}

// ══════════════════════════ Hidden teams ══════════════════════════

matches.get('/admin/hidden-teams', requireAuth, requireAdmin, async (c) => {
  return c.json({ teams: await adminMatchesService.listHiddenTeams() });
});

matches.post('/admin/hidden-teams', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => ({} as any));
  try {
    const t = await adminMatchesService.hideTeam({ game: String(b.game || ''), name: String(b.name || ''), createdBy: actor.username });
    audit(actor, 'POST', '/admin/hidden-teams', { game: t.game, name: t.name });
    return c.json(t, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося видалити команду' }, 400);
  }
});

matches.delete('/admin/hidden-teams/:id', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'Bad id' }, 400);
  const t = await adminMatchesService.unhideTeam(id);
  if (!t) return c.json({ error: 'Not found' }, 404);
  audit(actor, 'DELETE', `/admin/hidden-teams/${id}`, { game: t.game, name: t.name });
  return c.json({ ok: true });
});

// ══════════════════════════ Team aliases ══════════════════════════

/** Every team in the CS2 / Dota 2 logo packs — the admin «Команди» directory. */
matches.get('/admin/teams/catalog', requireAuth, requireAdmin, (c) => {
  c.header('Cache-Control', 'private, max-age=3600');
  return c.json({ teams: logoCatalog() });
});

matches.get('/admin/team-aliases', requireAuth, requireAdmin, async (c) => {
  const aliases = await adminMatchesService.listTeamAliases(c.req.query('game') || undefined);
  return c.json({ aliases });
});

matches.post('/admin/team-aliases', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    const alias = await adminMatchesService.createTeamAlias({
      game: String(b.game || ''),
      canonical: String(b.canonical || ''),
      alias: String(b.alias || ''),
      createdBy: actor.username,
    });
    forgetAliases(); // OddsPapi prices find the team under its new name on the next feed build
    audit(actor, 'POST', '/admin/team-aliases', { game: alias.game, canonical: alias.canonical, alias: alias.alias });
    return c.json(alias, 201);
  } catch (e: any) {
    if (e?.code === '23505') return c.json({ error: 'Такий псевдонім уже є' }, 409);
    return c.json({ error: e?.message || 'Не вдалося зберегти псевдонім' }, 400);
  }
});

matches.delete('/admin/team-aliases/:id', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const id = parseInt(c.req.param('id') || '', 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
  const ok = await adminMatchesService.deleteTeamAlias(id);
  forgetAliases();
  if (!ok) return c.json({ error: 'Псевдонім не знайдено' }, 404);
  audit(actor, 'DELETE', `/admin/team-aliases/${id}`, {});
  return c.json({ success: true });
});

// «Команди → Змінити логотип»: one image for all spellings of the team; it wins over packs and feeds
matches.get('/admin/team-logos', requireAuth, requireAdmin, (c) => c.json({ logos: listTeamLogos() }));

matches.post('/admin/team-logos', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    const names = Array.isArray(b.names) ? b.names.map(String) : [String(b.name || '')];
    const saved = await saveTeamLogo({ game: String(b.game || ''), names, dataUrl: String(b.dataUrl || ''), by: actor.username });
    audit(actor, 'POST', '/admin/team-logos', { game: saved.game, names: saved.names });
    return c.json(saved, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося зберегти логотип' }, 400);
  }
});

matches.delete('/admin/team-logos', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  // ?game=cs2&name=Team%20Spirit&name=Spirit
  const game = c.req.query('game') || '';
  const names = (c.req.queries('name') || []).map(String);
  const n = await deleteTeamLogo(game, names);
  if (!n) return c.json({ error: 'Логотип не знайдено' }, 404);
  audit(actor, 'DELETE', '/admin/team-logos', { game, names });
  return c.json({ success: true });
});

// «Команди → Дублікати → Різні команди»
matches.get('/admin/team-distinct', requireAuth, requireAdmin, async (c) => {
  return c.json({ pairs: await adminMatchesService.listDistinct() });
});

matches.post('/admin/team-distinct', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    const pair = await adminMatchesService.addDistinct({ game: String(b.game || ''), name: String(b.name || ''), variant: String(b.variant || ''), createdBy: actor.username });
    audit(actor, 'POST', '/admin/team-distinct', { game: pair.game, name: pair.name, variant: pair.variant });
    return c.json(pair, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося зберегти' }, 400);
  }
});

matches.delete('/admin/team-distinct/:id', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const id = parseInt(c.req.param('id') || '', 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
  const ok = await adminMatchesService.deleteDistinct(id);
  if (!ok) return c.json({ error: 'Не знайдено' }, 404);
  audit(actor, 'DELETE', `/admin/team-distinct/${id}`, {});
  return c.json({ success: true });
});

// ══════════════════════════ Manual matches ══════════════════════════

matches.get('/admin/manual-matches', requireAuth, requireAdmin, async (c) => {
  const list = await adminMatchesService.listManualMatches(c.req.query('game') || undefined);
  return c.json({ matches: list });
});

matches.post('/admin/manual-matches', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    const mm = await adminMatchesService.createManualMatch({
      game: String(b.game || ''),
      team1: String(b.team1 || ''),
      team2: String(b.team2 || ''),
      tournament: b.tournament ? String(b.tournament) : undefined,
      bo: b.bo ? String(b.bo) : undefined,
      startDate: String(b.startDate || ''),
      status: b.status as MatchStatus | undefined,
      score1: b.score1 != null ? Number(b.score1) : null,
      score2: b.score2 != null ? Number(b.score2) : null,
      createdBy: actor.username,
    });
    audit(actor, 'POST', '/admin/manual-matches', { game: mm.game, team1: mm.team1, team2: mm.team2, startDate: mm.startDate });
    return c.json(mm, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося додати матч' }, 400);
  }
});

matches.delete('/admin/manual-matches/:id', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const id = c.req.param('id') || '';
  if (!id) return c.json({ error: 'Invalid id' }, 400);
  const ok = await adminMatchesService.deleteManualMatch(id);
  if (!ok) return c.json({ error: 'Матч не знайдено' }, 404);
  audit(actor, 'DELETE', `/admin/manual-matches/${id}`, {});
  return c.json({ success: true });
});

// ══════════════════════════ Match overrides (ручні правки) ══════════════════════════

matches.get('/admin/match-overrides', requireAuth, requireAdmin, async (c) => {
  const overrides = await adminMatchesService.listOverrides(c.req.query('game') || undefined);
  return c.json({ overrides });
});

matches.get('/admin/match-links', requireAuth, requireAdmin, async (c) => {
  const links = await adminMatchesService.listLinks(c.req.query('game') || undefined);
  return c.json({ links });
});

matches.patch('/admin/matches/:game/:matchId', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const game = c.req.param('game') || '';
  const matchId = decodeURIComponent(c.req.param('matchId') || '');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    const override = await adminMatchesService.upsertOverride({
      game,
      matchId,
      status: b.status as MatchStatus | null | undefined,
      startDate: b.startDate ? String(b.startDate) : null,
      score1: b.score1 != null ? Number(b.score1) : null,
      score2: b.score2 != null ? Number(b.score2) : null,
      decidedBy: actor.username,
    });
    audit(actor, 'PATCH', `/admin/matches/${game}/${matchId}`, { status: override.status, score1: override.score1, score2: override.score2, startDate: override.startDate });
    // «Історія змін»: the admin's edit as one line per field it sets (old value unknown here — the sheet shows the new one)
    recordChanges([
      ...(override.startDate ? [{ field: 'start', newValue: new Date(override.startDate).toISOString() }] : []),
      ...(override.status ? [{ field: 'status', newValue: String(override.status) }] : []),
      ...(override.score1 != null || override.score2 != null ? [{ field: 'score', newValue: `${override.score1 ?? '—'}:${override.score2 ?? '—'}` }] : []),
    ].map((x) => ({ game, matchId, oldValue: null, source: `адмін @${actor.username}`, ...x })));
    return c.json(override);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося зберегти правку' }, 400);
  }
});

/** GET /api/admin/matches/:game/:matchId/changes — «Історія змін» in the match sheet. */
matches.get('/admin/matches/:game/:matchId/changes', requireAuth, requireAdmin, async (c) => {
  const matchId = decodeURIComponent(c.req.param('matchId') || '');
  try { return c.json({ changes: await listChanges(matchId) }); }
  catch { return c.json({ changes: [] }); }
});

matches.delete('/admin/matches/:game/:matchId', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const game = c.req.param('game') || '';
  const matchId = decodeURIComponent(c.req.param('matchId') || '');
  const ok = await adminMatchesService.deleteOverride(game, matchId);
  if (!ok) return c.json({ error: 'Правку не знайдено' }, 404);
  audit(actor, 'DELETE', `/admin/matches/${game}/${matchId}`, {});
  recordChanges([{ game, matchId, field: 'override', oldValue: 'ручна правка', newValue: 'дані парсера', source: `адмін @${actor.username}` }]);
  return c.json({ success: true });
});

// ══════════════════════════ Merge decisions ══════════════════════════

async function linkHandler(c: any, decision: LinkDecision) {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Invalid body' }, 400);
  try {
    let officialId = b.officialId != null ? String(b.officialId) : null;
    // The frontend ids are prefixed "cs2:…"/"dota2:…" — strip the game prefix.
    if (officialId && /^(cs2|dota2):/.test(officialId)) officialId = officialId.replace(/^(cs2|dota2):/, '');
    const link = await adminMatchesService.linkMatch({
      game: String(b.game || ''),
      team1: String(b.team1 || ''),
      team2: String(b.team2 || ''),
      date: String(b.date || ''),
      officialId,
      decision,
      decidedBy: actor.username,
    });
    audit(actor, decision === 'merged' ? 'MERGE' : 'UNLINK', `/admin/matches/${decision}`, {
      game: link.game, team1: link.team1, team2: link.team2, matchDate: link.matchDate, officialId: link.officialId,
    });
    return c.json(link);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Не вдалося зберегти рішення' }, 400);
  }
}

matches.post('/admin/matches/merge', requireAuth, requireAdmin, async (c) => linkHandler(c, 'merged'));
matches.post('/admin/matches/unlink', requireAuth, requireAdmin, async (c) => linkHandler(c, 'different'));

// ══════════════════════════ Parser events ══════════════════════════

matches.get('/admin/parsers/:name/events', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!/^[a-z0-9_]+$/i.test(name)) return c.json({ error: 'Invalid parser name' }, 400);
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const events = await adminMatchesService.listParserEvents(name, limit);
  return c.json({ events });
});

matches.get('/admin/parsers/:name/availability', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!/^[a-z0-9_]+$/i.test(name)) return c.json({ error: 'Invalid parser name' }, 400);
  const hours = parseInt(c.req.query('hours') || '48', 10);
  const availability = await adminMatchesService.parserAvailability(name, hours);
  return c.json({ availability });
});

export default matches;
