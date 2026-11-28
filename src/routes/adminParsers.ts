import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { listCircuits, pauseInfo, pauseParser, resetCircuit, resumeParser } from '../services/circuitBreaker';
import { forceOddsPapi, oddsRefreshCost, oddspapiDiag, oddspapiEnabled } from '../services/oddspapiFeed';
import { citoAdded, fallbackCount, oddsMatched, oddsMisses, pandascoreAdded } from '../services/matchFeed';
import { pandascoreDiag, pandascoreEnabled, refreshPandaScore } from '../services/pandascoreFeed';
import { citoDiag, citoEnabled, refreshCito } from '../services/citoFeed';
import { polymarketDiag, polymarketEnabled, refreshPolymarket } from '../services/polymarketFeed';
import { forceLiquipedia, liquipediaAskedAt, liquipediaPagesInfo, setPagesMode } from '../services/liquipediaFeed';
import { listServerErrors, recordServerError, resolveServerError } from '../services/serverErrors';
import { weekReport } from '../services/feedStats';
import { touchActivity } from '../services/activityTracker';
import { isNight, nightWindow } from '../services/nightMode';
import { resolveScoreIssue, scoreIssues } from '../services/scoreCheck';

/** Parsers shown on the admin screen: Liquipedia + OddsPapi + OpenDota (tips.gg and HLTV removed 23.11.2026). */
export const knownParsers = () => ['liquipedia', ...(pandascoreEnabled() ? ['pandascore'] : []), ...(citoEnabled() ? ['cito'] : []), ...(oddspapiEnabled() ? ['oddspapi'] : []), ...(polymarketEnabled() ? ['polymarket'] : []), 'opendota'];

const parsers = new Hono();

/** GET /api/admin/parsers — last state of each parser (circuit + recent failures). */
parsers.get('/admin/parsers', requireAuth, requireAdmin, async (c) => {
  touchActivity(); // the admin looking at the parsers is a visitor: the feed refresh wakes up
  const circuits = listCircuits();
  const failures = await pool.query(
    `SELECT source, COUNT(*)::int AS count, MAX(created_at) AS last_failure
     FROM parser_failures WHERE created_at > now() - INTERVAL '24 hours'
     GROUP BY source ORDER BY count DESC`,
  );
  const failureMap = new Map<string, { count: number; lastFailure: string }>();
  failures.rows.forEach((r: any) =>
    failureMap.set(r.source, {
      count: Number(r.count),
      lastFailure: r.last_failure ? new Date(r.last_failure).toISOString() : '',
    }),
  );

  // Last success — a failure followed by a success is history, not «працює зі збоями»
  const ok = await pool.query(
    `SELECT source, MAX(created_at) AS last_success FROM parser_events
     WHERE event = 'success' AND created_at > now() - INTERVAL '24 hours' GROUP BY source`,
  ).catch(() => ({ rows: [] as any[] }));
  const okMap = new Map<string, string>(ok.rows.map((r: any) => [r.source, r.last_success ? new Date(r.last_success).toISOString() : '']));

  // Last 7 Kyiv days: successful vs failed runs per day — «Стабільність за 7 днів»
  const wk = await pool.query(
    `SELECT source, to_char((created_at AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE event = 'success')::int AS ok, COUNT(*) FILTER (WHERE event = 'failure')::int AS fail
     FROM parser_events WHERE created_at > now() - INTERVAL '7 days' GROUP BY 1, 2`,
  ).catch(() => ({ rows: [] as any[] }));
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }));
  // why a day went red: failure texts per day, most frequent first (digits folded so «збій 3 поспіль» groups)
  const why = await pool.query(
    `SELECT source, to_char((created_at AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS day,
            regexp_replace(COALESCE(NULLIF(message, ''), 'без опису'), '(#|збій )\\d+', '\\1N', 'g') AS msg, COUNT(*)::int AS n,
            to_char(MIN(created_at) AT TIME ZONE 'Europe/Kyiv', 'HH24:MI') AS first, to_char(MAX(created_at) AT TIME ZONE 'Europe/Kyiv', 'HH24:MI') AS last
     FROM parser_events WHERE event = 'failure' AND created_at > now() - INTERVAL '7 days' GROUP BY 1, 2, 3 ORDER BY n DESC`,
  ).catch(() => ({ rows: [] as any[] }));
  const weekOf = (name: string) => days.map((day) => {
    const r = wk.rows.find((x: any) => x.source === name && x.day === day);
    const reasons = why.rows.filter((x: any) => x.source === name && x.day === day).slice(0, 5)
      .map((x: any) => ({ message: String(x.msg), n: Number(x.n), first: String(x.first), last: String(x.last) }));
    return { day, ok: Number(r?.ok || 0), fail: Number(r?.fail || 0), reasons };
  });

  // Merge known parser sources even if they never failed.
  const known = knownParsers();
  const [psDiag, ctDiag, pmDiag] = await Promise.all([pandascoreEnabled() ? pandascoreDiag() : null, citoEnabled() ? citoDiag() : null, polymarketEnabled() ? polymarketDiag() : null]);
  const merged = known.map((name) => {
    const circuit = circuits.find((x) => x.name === name);
    const fail = failureMap.get(name);
    const stop = pauseInfo(name);
    return {
      name,
      paused: !!stop,
      pausedBy: stop?.by ?? '',
      pausedAt: stop ? new Date(stop.at).toISOString() : '',
      pausedUntil: stop?.until ? new Date(stop.until).toISOString() : '',
      open: circuit?.open ?? false,
      failures: circuit?.failures ?? 0,
      failures24h: fail?.count ?? 0,
      lastFailure: fail?.lastFailure ?? (circuit?.lastFailure ? new Date(circuit.lastFailure).toISOString() : ''),
      lastSuccess: okMap.get(name) ?? '',
      week: weekOf(name),
      ...(name === 'liquipedia' ? { pages: liquipediaPagesInfo() } : {}),
      ...(name === 'liquipedia' && liquipediaAskedAt() ? { askedAt: new Date(liquipediaAskedAt()).toISOString() } : {}),
      // Cito: second CS2 schedule — how many matches it added and how much of the month's 500 is left
      ...(name === 'pandascore' ? { pandascore: { ...psDiag!, added: pandascoreAdded() } } : {}),
      ...(name === 'cito' ? { cito: { ...ctDiag!, added: citoAdded() } } : {}),
      // Polymarket: prices next to the bookmakers' — matches it lists, with prices, and how many reached ours
      ...(name === 'polymarket' && pmDiag ? { polymarket: pmDiag } : {}),
      // OddsPapi only adds prices: show what it holds and how much of it reached our matches
      ...(name === 'oddspapi' ? { odds: (() => { const d = oddspapiDiag(), m = oddsMatched(); return { ...d, matched: m.cs2 + m.dota2, refreshCost: oddsRefreshCost(), fallback: fallbackCount(), unmatched: oddsMisses().slice(0, 40), fixturesAt: d.fixturesAt ? new Date(d.fixturesAt).toISOString() : '', oddsAt: d.oddsAt ? new Date(d.oddsAt).toISOString() : '', nextOddsAt: d.nextOddsAt ? new Date(d.nextOddsAt).toISOString() : '' }; })() } : {}),
    };
  });
  return c.json({ parsers: merged, night: { ...nightWindow(), active: isNight() }, scoreIssues: await scoreIssues().catch(() => []) });
});

/** A screen of the admin panel that crashed in the browser: kept with the server errors (source «client»). */
parsers.post('/admin/client-errors', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => ({})) as { message?: unknown; stack?: unknown; path?: unknown };
  const message = String(b.message ?? '').trim().slice(0, 500);
  if (!message) return c.json({ error: 'message required' }, 400);
  recordServerError('client', `Екран адмінки: ${message}`, String(b.stack ?? '').slice(0, 4000), String(b.path ?? '').slice(0, 300));
  return c.json({ ok: true });
});

/** Server errors kept for the admin («Налаштування → Помилки сервера»). */
parsers.get('/admin/server-errors', requireAuth, requireAdmin, async (c) => {
  return c.json({ errors: await listServerErrors(parseInt(c.req.query('limit') || '100', 10) || 100) });
});
parsers.delete('/admin/server-errors/:id', requireAuth, requireAdmin, async (c) => {
  const raw = c.req.param('id') || '';
  const id = raw === 'all' ? 'all' : parseInt(raw, 10);
  if (id !== 'all' && (!Number.isInteger(id) || id <= 0)) return c.json({ error: 'Invalid id' }, 400);
  const n = await resolveServerError(id);
  audit(c.get('user'), 'DELETE', `/admin/server-errors/${raw}`, { removed: n });
  return c.json({ success: true, removed: n });
});

/** PUT /api/admin/parsers/liquipedia/pages-mode — «Сторінки турнірів»: auto / on (always add) / off (do not read). */
parsers.put('/admin/parsers/liquipedia/pages-mode', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') return c.json({ error: 'mode: auto | on | off' }, 400);
  await setPagesMode(mode);
  audit(c.get('user'), 'PUT', '/admin/parsers/liquipedia/pages-mode', { mode });
  return c.json({ success: true, mode });
});

/** DELETE /api/admin/score-issues/:kind/:id — the admin settled it (picked the right score / checked a closed match). */
parsers.delete('/admin/score-issues/:kind/:id', requireAuth, requireAdmin, async (c) => {
  const kind = c.req.param('kind'), id = c.req.param('id') || '';
  if ((kind !== 'conflict' && kind !== 'closed') || !id || id.length > 300) return c.json({ error: 'Invalid issue' }, 400);
  const item = await resolveScoreIssue(kind, id);
  // the audit reads «розв’язав розбіжність рахунку · HEROIC — M80», not the raw id
  audit(c.get('user'), 'DELETE', `/admin/score-issues/${kind}/${id}`, { kind, id, ...(item ? { team1: item.team1, team2: item.team2 } : {}) });
  return c.json({ success: !!item });
});

/** POST /api/admin/parsers/:name/rerun — reset the breaker so the next fetch retries. */
parsers.post('/admin/parsers/:name/rerun', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!/^[a-z0-9_]+$/i.test(name)) return c.json({ error: 'Invalid parser name' }, 400);
  resetCircuit(name);
  return c.json({ success: true });
});

const KNOWN = new Set(['oddspapi', 'opendota', 'liquipedia', 'cito', 'pandascore', 'polymarket']);
function audit(actor: { userId: number; username: string }, action: string, target: string, details: Record<string, unknown>): void {
  void pool
    .query(`INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status) VALUES($1,$2,$3,$4,$5,'success')`,
      [actor.userId, actor.username, action, target, JSON.stringify(details)])
    .catch((err) => console.warn('[adminParsers] audit failed:', (err as Error).message));
}

/** GET /api/admin/matches-week — «Матчі за 7 днів» on the dashboard. */
parsers.get('/admin/matches-week', requireAuth, requireAdmin, async (c) => {
  try { return c.json(await weekReport()); }
  catch (e) { return c.json({ error: (e as Error).message }, 500); }
});

/** POST /api/admin/parsers/:name/refresh — «Оновити зараз»: fetch from the source now, not at the next planned time.
 *  OddsPapi answers how many of the month's requests it spent. */
parsers.post('/admin/parsers/:name/refresh', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!KNOWN.has(name)) return c.json({ error: 'Невідомий парсер' }, 400);
  if (pauseInfo(name)) return c.json({ error: 'Парсер зупинено — спершу запустіть його' }, 409);
  const actor = c.get('user');
  resetCircuit(name);
  let cost = 0;
  if (name === 'liquipedia') forceLiquipedia();
  if (name === 'pandascore') {
    if (!pandascoreEnabled()) return c.json({ error: 'PandaScore вимкнено: немає ключа' }, 409);
    void refreshPandaScore(true).catch(() => {});
  }
  if (name === 'cito') {
    if (!citoEnabled()) return c.json({ error: 'Cito вимкнено: немає ключа' }, 409);
    cost = 2;
    void refreshCito(true).catch(() => {});
  }
  if (name === 'polymarket') {
    if (!polymarketEnabled()) return c.json({ error: 'Polymarket вимкнено' }, 409);
    void refreshPolymarket(true).catch(() => {});
  }
  if (name === 'oddspapi') {
    if (!oddspapiEnabled()) return c.json({ error: 'OddsPapi вимкнено: немає ключа' }, 409);
    cost = oddsRefreshCost();
    void forceOddsPapi().catch(() => {});
  }
  audit(actor, 'POST', `/admin/parsers/${name}/refresh`, { name, cost });
  return c.json({ success: true, cost });
});

/** POST /api/admin/parsers/:name/stop — stop the parser until it is started again (survives restarts). */
parsers.post('/admin/parsers/:name/stop', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!KNOWN.has(name)) return c.json({ error: 'Невідомий парсер' }, 400);
  const actor = c.get('user');
  // body { minutes?: number } — 60 = an hour, «до ранку» is sent as minutes until 08:00 Kyiv; none = until started by hand
  const body = await c.req.json().catch(() => ({}));
  const min = Number(body?.minutes);
  const until = Number.isFinite(min) && min > 0 ? Date.now() + Math.min(min, 7 * 24 * 60) * 60_000 : null;
  await pauseParser(name, actor.username, until);
  audit(actor, 'POST', `/admin/parsers/${name}/stop`, { name, until: until ? new Date(until).toISOString() : null });
  return c.json({ success: true });
});

/** POST /api/admin/parsers/:name/start — start a stopped parser; the next fetch runs as usual. */
parsers.post('/admin/parsers/:name/start', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!KNOWN.has(name)) return c.json({ error: 'Невідомий парсер' }, 400);
  const actor = c.get('user');
  await resumeParser(name, actor.username);
  resetCircuit(name);
  audit(actor, 'POST', `/admin/parsers/${name}/start`, { name });
  return c.json({ success: true });
});

export default parsers;
