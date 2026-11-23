import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { listCircuits, pauseInfo, pauseParser, resetCircuit, resumeParser } from '../services/circuitBreaker';
import { oddspapiEnabled } from '../services/oddspapiFeed';
import { usingNewFeed } from '../services/matchFeed';
import { listServerErrors, resolveServerError } from '../services/serverErrors';

/** Parsers shown on the admin screen: Liquipedia + OddsPapi + OpenDota replace tips.gg in the new feed. */
export const knownParsers = () => (usingNewFeed()
  ? ['liquipedia', ...(oddspapiEnabled() ? ['oddspapi'] : []), 'opendota', 'hltv_scraper']
  : ['tipsgg_fetch_cs2_matches', 'tipsgg_fetch_dota2_matches', 'hltv_scraper']);

const parsers = new Hono();

/** GET /api/admin/parsers — last state of each parser (circuit + recent failures). */
parsers.get('/admin/parsers', requireAuth, requireAdmin, async (c) => {
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

  // Merge known parser sources even if they never failed.
  const known = knownParsers();
  const merged = known.map((name) => {
    const circuit = circuits.find((x) => x.name === name);
    const fail = failureMap.get(name);
    const stop = pauseInfo(name);
    return {
      name,
      paused: !!stop,
      pausedBy: stop?.by ?? '',
      pausedAt: stop ? new Date(stop.at).toISOString() : '',
      open: circuit?.open ?? false,
      failures: circuit?.failures ?? 0,
      failures24h: fail?.count ?? 0,
      lastFailure: fail?.lastFailure ?? (circuit?.lastFailure ? new Date(circuit.lastFailure).toISOString() : ''),
      lastSuccess: okMap.get(name) ?? '',
    };
  });
  return c.json({ parsers: merged });
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

/** POST /api/admin/parsers/:name/rerun — reset the breaker so the next fetch retries. */
parsers.post('/admin/parsers/:name/rerun', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!/^[a-z0-9_]+$/i.test(name)) return c.json({ error: 'Invalid parser name' }, 400);
  resetCircuit(name);
  return c.json({ success: true });
});

const KNOWN = new Set(['tipsgg_fetch_cs2_matches', 'tipsgg_fetch_dota2_matches', 'hltv_scraper', 'oddspapi', 'opendota', 'liquipedia']);
function audit(actor: { userId: number; username: string }, action: string, target: string, details: Record<string, unknown>): void {
  void pool
    .query(`INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status) VALUES($1,$2,$3,$4,$5,'success')`,
      [actor.userId, actor.username, action, target, JSON.stringify(details)])
    .catch((err) => console.warn('[adminParsers] audit failed:', (err as Error).message));
}

/** POST /api/admin/parsers/:name/stop — stop the parser until it is started again (survives restarts). */
parsers.post('/admin/parsers/:name/stop', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!KNOWN.has(name)) return c.json({ error: 'Невідомий парсер' }, 400);
  const actor = c.get('user');
  await pauseParser(name, actor.username);
  audit(actor, 'POST', `/admin/parsers/${name}/stop`, { name });
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
