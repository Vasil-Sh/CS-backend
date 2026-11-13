import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';

const ads = new Hono();

// ═══════════════════════════════════════════
// Bookmakers (licensed partners)
// ═══════════════════════════════════════════

ads.get('/admin/bookmakers', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(
    `SELECT id::text, name, license_number AS "licenseNumber", moderation_text AS "moderationText",
            show_odds_in_list AS "showOddsInList", show_match_details AS "showMatchDetails",
            active, created_at AS "createdAt"
     FROM bookmakers ORDER BY id`,
  );
  return c.json({ bookmakers: result.rows });
});

ads.post('/admin/bookmakers', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) return c.json({ error: 'Назва — обовʼязкова (до 100 символів)' }, 400);
  const result = await pool.query(
    `INSERT INTO bookmakers(name, license_number, moderation_text, show_odds_in_list, show_match_details)
     VALUES($1,$2,$3,$4,$5) RETURNING id::text`,
    [b.name.trim(), b.licenseNumber || '', b.moderationText || '', Boolean(b.showOddsInList), Boolean(b.showMatchDetails)],
  );
  return c.json({ id: result.rows[0].id }, 201);
});

ads.put('/admin/bookmakers/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid bookmaker' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const sets: string[] = [];
  const params: any[] = [];
  const field = (name: string, col: string, transform?: (v: any) => any) => {
    if (b[name] === undefined) return;
    params.push(transform ? transform(b[name]) : b[name]);
    sets.push(`${col}=$${params.length}`);
  };
  field('name', 'name', (v: any) => String(v).slice(0, 100));
  field('licenseNumber', 'license_number');
  field('moderationText', 'moderation_text');
  field('showOddsInList', 'show_odds_in_list', Boolean);
  field('showMatchDetails', 'show_match_details', Boolean);
  field('active', 'active', Boolean);
  if (!sets.length) return c.json({ error: 'Немає полів для оновлення' }, 400);
  params.push(id);
  await pool.query(`UPDATE bookmakers SET ${sets.join(', ')}, updated_at=now() WHERE id::text=$${params.length}`, params);
  return c.json({ success: true });
});

ads.delete('/admin/bookmakers/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid bookmaker' }, 400);
  await pool.query('DELETE FROM bookmakers WHERE id::text=$1', [id]);
  return c.json({ success: true });
});

// ═══════════════════════════════════════════
// Ad events (impressions/clicks) — called by the app
// ═══════════════════════════════════════════

ads.post('/ad-events', async (c) => {
  const b = await c.req.json().catch(() => null);
  const kind = b?.kind;
  if (kind !== 'impression' && kind !== 'click') return c.json({ error: 'Invalid kind' }, 400);
  const placement = typeof b?.placement === 'string' ? b.placement.slice(0, 50) : '';
  const entityId = typeof b?.entityId === 'string' ? b.entityId.slice(0, 100) : '';
  if (!placement) return c.json({ error: 'placement required' }, 400);
  // Fire-and-forget: ad events must never block the app.
  void pool.query(
    'INSERT INTO ad_events(placement, entity_id, kind) VALUES($1,$2,$3)',
    [placement, entityId, kind],
  ).catch((e) => console.warn('[ad-events]', (e as Error).message));
  return c.json({ ok: true });
});

/** GET /api/admin/ad-stats — impressions/clicks per placement. */
ads.get('/admin/ad-stats', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(
    `SELECT placement,
            COUNT(*) FILTER (WHERE kind='impression')::int AS impressions,
            COUNT(*) FILTER (WHERE kind='click')::int AS clicks
     FROM ad_events WHERE created_at > now() - INTERVAL '30 days'
     GROUP BY placement ORDER BY impressions DESC`,
  );
  return c.json({ stats: result.rows });
});

// ═══════════════════════════════════════════
// Support templates
// ═══════════════════════════════════════════

ads.get('/admin/support-templates', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(
    `SELECT id::text, title, body, created_at AS "createdAt" FROM support_templates ORDER BY title`,
  );
  return c.json({ templates: result.rows });
});

ads.post('/admin/support-templates', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) return c.json({ error: 'Назва шаблону — обовʼязкова' }, 400);
  if (typeof b.body !== 'string' || !b.body.trim()) return c.json({ error: 'Текст шаблону — обовʼязковий' }, 400);
  const result = await pool.query(
    'INSERT INTO support_templates(title, body) VALUES($1,$2) RETURNING id::text',
    [b.title.trim(), b.body.trim()],
  );
  return c.json({ id: result.rows[0].id }, 201);
});

ads.delete('/admin/support-templates/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid template' }, 400);
  await pool.query('DELETE FROM support_templates WHERE id::text=$1', [id]);
  return c.json({ success: true });
});

export default ads;
