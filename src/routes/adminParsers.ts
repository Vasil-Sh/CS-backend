import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { listCircuits, resetCircuit } from '../services/circuitBreaker';

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

  // Merge known parser sources even if they never failed.
  const known = ['tipsgg_fetch_cs2_matches', 'tipsgg_fetch_dota2_matches', 'hltv_scraper'];
  const merged = known.map((name) => {
    const circuit = circuits.find((x) => x.name === name);
    const fail = failureMap.get(name);
    return {
      name,
      open: circuit?.open ?? false,
      failures: circuit?.failures ?? 0,
      failures24h: fail?.count ?? 0,
      lastFailure: fail?.lastFailure ?? (circuit?.lastFailure ? new Date(circuit.lastFailure).toISOString() : ''),
    };
  });
  return c.json({ parsers: merged });
});

/** POST /api/admin/parsers/:name/rerun — reset the breaker so the next fetch retries. */
parsers.post('/admin/parsers/:name/rerun', requireAuth, requireAdmin, async (c) => {
  const name = c.req.param('name') || '';
  if (!/^[a-z0-9_]+$/i.test(name)) return c.json({ error: 'Invalid parser name' }, 400);
  resetCircuit(name);
  return c.json({ success: true });
});

export default parsers;
