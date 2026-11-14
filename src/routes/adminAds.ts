import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { recordAction } from '../services/auditLog';
import { settingsService } from '../services/settingsService';

const ads = new Hono();

// ═══════════════════════════════════════════
// Bookmakers (licensed partners)
// ═══════════════════════════════════════════

const BOOKMAKER_COLS = `id::text, name, license_number AS "licenseNumber", license_until::text AS "licenseUntil",
  moderation_text AS "moderationText", link, button_text AS "buttonText", click_price::float AS "clickPrice",
  show_odds_in_list AS "showOddsInList", show_match_details AS "showMatchDetails",
  active, created_at AS "createdAt", updated_at AS "updatedAt"`;
const isDate = (v: unknown) => v === null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)));
const actorOf = (c: any) => c.get('user');

ads.get('/admin/bookmakers', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(`SELECT ${BOOKMAKER_COLS} FROM bookmakers ORDER BY id`);
  return c.json({ bookmakers: result.rows });
});

function bookmakerInput(b: any, partial: boolean): { error?: string; cols: [string, unknown][] } {
  const cols: [string, unknown][] = [];
  const str = (k: string, col: string, max: number) => { if (b[k] === undefined) return; cols.push([col, String(b[k] ?? '').trim().slice(0, max)]); };
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) return { error: 'Назва — обовʼязкова (до 100 символів)', cols };
    cols.push(['name', b.name.trim()]);
  }
  str('licenseNumber', 'license_number', 100);
  str('moderationText', 'moderation_text', 2000);
  str('buttonText', 'button_text', 100);
  if (b.link !== undefined) {
    const link = String(b.link ?? '').trim();
    if (link && !/^https?:\/\/[^\s]+$/i.test(link)) return { error: 'Посилання має починатися з https://', cols };
    cols.push(['link', link.slice(0, 500)]);
  }
  if (b.licenseUntil !== undefined) { if (!isDate(b.licenseUntil)) return { error: 'Некоректна дата ліцензії', cols }; cols.push(['license_until', b.licenseUntil || null]); }
  if (b.clickPrice !== undefined) {
    const n = b.clickPrice === null || b.clickPrice === '' ? null : Number(b.clickPrice);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100000)) return { error: 'Некоректна ціна за клік', cols };
    cols.push(['click_price', n]);
  }
  for (const [k, col] of [['showOddsInList', 'show_odds_in_list'], ['showMatchDetails', 'show_match_details'], ['active', 'active']] as const) if (b[k] !== undefined) cols.push([col, Boolean(b[k])]);
  return { cols };
}

ads.post('/admin/bookmakers', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const { error, cols } = bookmakerInput(b, false);
  if (error) return c.json({ error }, 400);
  const result = await pool.query(
    `INSERT INTO bookmakers(${cols.map(([k]) => k).join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${BOOKMAKER_COLS}`,
    cols.map(([, v]) => v),
  );
  await recordAction(actorOf(c), 'POST', `/admin/bookmakers/${result.rows[0].id}`, { after: result.rows[0] }).catch(() => {});
  return c.json({ id: result.rows[0].id, bookmaker: result.rows[0] }, 201);
});

ads.put('/admin/bookmakers/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid bookmaker' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const { error, cols } = bookmakerInput(b, true);
  if (error) return c.json({ error }, 400);
  if (!cols.length) return c.json({ error: 'Немає полів для оновлення' }, 400);
  const before = await pool.query(`SELECT ${BOOKMAKER_COLS} FROM bookmakers WHERE id::text=$1`, [id]);
  if (!before.rows.length) return c.json({ error: 'Партнера не знайдено' }, 404);
  const result = await pool.query(
    `UPDATE bookmakers SET ${cols.map(([k], i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id::text=$${cols.length + 1} RETURNING ${BOOKMAKER_COLS}`,
    [...cols.map(([, v]) => v), id],
  );
  await recordAction(actorOf(c), 'PUT', `/admin/bookmakers/${id}`, { before: before.rows[0], after: result.rows[0] }).catch(() => {});
  return c.json({ success: true, bookmaker: result.rows[0] });
});

ads.delete('/admin/bookmakers/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid bookmaker' }, 400);
  const before = await pool.query(`SELECT ${BOOKMAKER_COLS} FROM bookmakers WHERE id::text=$1`, [id]);
  await pool.query('DELETE FROM bookmakers WHERE id::text=$1', [id]);
  if (before.rows.length) await recordAction(actorOf(c), 'DELETE', `/admin/bookmakers/${id}`, { before: before.rows[0] }).catch(() => {});
  return c.json({ success: true });
});

// ═══════════════════════════════════════════
// Paid Telegram-group promotions
// ═══════════════════════════════════════════

const PROMO_COLS = `id::text, name, handle, subscribers, description, placement, game,
  starts_on::text AS "startsOn", ends_on::text AS "endsOn", active, review_status AS "reviewStatus",
  reject_reason AS "rejectReason", price_note AS "priceNote", created_at AS "createdAt", updated_at AS "updatedAt"`;

function promoInput(b: any, partial: boolean): { error?: string; cols: [string, unknown][] } {
  const cols: [string, unknown][] = [];
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) return { error: 'Назва групи — обовʼязкова (до 100 символів)', cols };
    cols.push(['name', b.name.trim()]);
  }
  if (!partial || b.handle !== undefined) {
    const h = String(b.handle ?? '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{4,64}$/.test(h)) return { error: 'Вкажіть @username групи (латиниця, цифри, _)', cols };
    cols.push(['handle', h]);
  }
  if (b.subscribers !== undefined) {
    const n = b.subscribers === null || b.subscribers === '' ? null : Number(b.subscribers);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 100_000_000)) return { error: 'Некоректна кількість підписників', cols };
    cols.push(['subscribers', n]);
  }
  if (b.description !== undefined) cols.push(['description', String(b.description ?? '').trim().slice(0, 300)]);
  if (b.priceNote !== undefined) cols.push(['price_note', String(b.priceNote ?? '').trim().slice(0, 200)]);
  if (b.placement !== undefined) { if (b.placement !== 'telegram-top' && b.placement !== 'match-details') return { error: 'Невідоме місце показу', cols }; cols.push(['placement', b.placement]); }
  if (b.game !== undefined) { const g = String(b.game ?? ''); if (!['', 'CS2', 'Dota 2'].includes(g)) return { error: 'Невідома гра', cols }; cols.push(['game', g]); }
  for (const k of ['startsOn', 'endsOn'] as const) if (b[k] !== undefined) { if (!isDate(b[k])) return { error: 'Некоректна дата', cols }; cols.push([k === 'startsOn' ? 'starts_on' : 'ends_on', b[k] || null]); }
  if (b.startsOn && b.endsOn && b.startsOn > b.endsOn) return { error: 'Кінець не може бути раніше початку', cols };
  if (b.active !== undefined) cols.push(['active', Boolean(b.active)]);
  if (b.reviewStatus !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(b.reviewStatus)) return { error: 'Невідомий статус перевірки', cols };
    if (b.reviewStatus === 'rejected' && !String(b.rejectReason ?? '').trim()) return { error: 'Вкажіть причину відхилення', cols };
    cols.push(['review_status', b.reviewStatus]);
    cols.push(['reject_reason', b.reviewStatus === 'rejected' ? String(b.rejectReason).trim().slice(0, 500) : '']);
  }
  return { cols };
}

ads.get('/admin/telegram-promos', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(`SELECT ${PROMO_COLS} FROM telegram_promos ORDER BY (review_status='rejected'), starts_on DESC NULLS LAST, id DESC`);
  return c.json({ promos: result.rows });
});

ads.post('/admin/telegram-promos', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const { error, cols } = promoInput(b, false);
  if (error) return c.json({ error }, 400);
  const result = await pool.query(
    `INSERT INTO telegram_promos(${cols.map(([k]) => k).join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${PROMO_COLS}`,
    cols.map(([, v]) => v),
  );
  await recordAction(actorOf(c), 'POST', `/admin/telegram-promos/${result.rows[0].id}`, { after: result.rows[0] }).catch(() => {});
  return c.json({ id: result.rows[0].id, promo: result.rows[0] }, 201);
});

ads.put('/admin/telegram-promos/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid promo' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const before = await pool.query(`SELECT ${PROMO_COLS} FROM telegram_promos WHERE id::text=$1`, [id]);
  if (!before.rows.length) return c.json({ error: 'Розміщення не знайдено' }, 404);
  const merged = { startsOn: before.rows[0].startsOn, endsOn: before.rows[0].endsOn, ...b };
  if (merged.startsOn && merged.endsOn && merged.startsOn > merged.endsOn) return c.json({ error: 'Кінець не може бути раніше початку' }, 400);
  const { error, cols } = promoInput(b, true);
  if (error) return c.json({ error }, 400);
  if (!cols.length) return c.json({ error: 'Немає полів для оновлення' }, 400);
  const result = await pool.query(
    `UPDATE telegram_promos SET ${cols.map(([k], i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id::text=$${cols.length + 1} RETURNING ${PROMO_COLS}`,
    [...cols.map(([, v]) => v), id],
  );
  await recordAction(actorOf(c), 'PUT', `/admin/telegram-promos/${id}`, { before: before.rows[0], after: result.rows[0] }).catch(() => {});
  return c.json({ success: true, promo: result.rows[0] });
});

ads.delete('/admin/telegram-promos/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid promo' }, 400);
  const before = await pool.query(`SELECT ${PROMO_COLS} FROM telegram_promos WHERE id::text=$1`, [id]);
  await pool.query('DELETE FROM telegram_promos WHERE id::text=$1', [id]);
  if (before.rows.length) await recordAction(actorOf(c), 'DELETE', `/admin/telegram-promos/${id}`, { before: before.rows[0] }).catch(() => {});
  return c.json({ success: true });
});

// ═══════════════════════════════════════════
// Public placements for the app (no auth)
// ═══════════════════════════════════════════

/** GET /api/ads/placements — what the app may show right now (Kyiv date). */
ads.get('/ads/placements', async (c) => {
  const s = await settingsService.get();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [bm, tg] = await Promise.all([
    pool.query(
      `SELECT id::text, name, link, button_text AS "buttonText", license_number AS "licenseNumber", show_odds_in_list AS "list", show_match_details AS "details"
       FROM bookmakers WHERE active AND license_number<>'' AND link<>'' AND (license_until IS NULL OR license_until >= $1::date) ORDER BY id`, [today]),
    pool.query(
      `SELECT id::text, name, handle, subscribers, description, placement, game FROM telegram_promos
       WHERE active AND review_status='approved' AND (starts_on IS NULL OR starts_on <= $1::date) AND (ends_on IS NULL OR ends_on >= $1::date)
       ORDER BY starts_on NULLS LAST, id`, [today]),
  ]);
  const pick = ({ list, details, ...r }: any) => r;
  return c.json({
    label: 'Реклама · 21+',
    bookmakers: {
      list: s.adsOddsInList ? bm.rows.filter((r: any) => r.list).map(pick) : [],
      details: s.adsMatchDetails ? bm.rows.filter((r: any) => r.details).map(pick) : [],
    },
    telegram: tg.rows.map((r: any) => ({ ...r, url: `https://t.me/${r.handle}` })),
  });
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
  const userKey = typeof b?.userKey === 'string' ? b.userKey.slice(0, 64) : '';
  if (!placement) return c.json({ error: 'placement required' }, 400);
  // Fire-and-forget: ad events must never block the app.
  void pool.query(
    'INSERT INTO ad_events(placement, entity_id, kind, user_key) VALUES($1,$2,$3,$4)',
    [placement, entityId, kind, userKey],
  ).catch((e) => console.warn('[ad-events]', (e as Error).message));
  return c.json({ ok: true });
});

/**
 * GET /api/admin/ad-stats?days=7|14|30 or ?from=YYYY-MM-DD&to=YYYY-MM-DD (Kyiv dates, inclusive).
 * Totals with the previous period of the same length, clicks/impressions per day, and per placement + entity.
 * `stats` (per placement, 30 days) is kept for older admin builds.
 */
ads.get('/admin/ad-stats', requireAuth, requireAdmin, async (c) => {
  const q = c.req.query();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let from: string, to: string;
  if (q.from && q.to && isDate(q.from) && isDate(q.to) && q.from <= q.to) { from = q.from; to = q.to; }
  else {
    const days = [7, 14, 30, 90].includes(Number(q.days)) ? Number(q.days) : 14;
    to = today;
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - days + 1); from = d.toISOString().slice(0, 10);
  }
  const len = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5) + 1;
  if (len > 366) return c.json({ error: 'Період — до 366 днів' }, 400);
  const pf = new Date(`${from}T12:00:00Z`); pf.setUTCDate(pf.getUTCDate() - len); const prevFrom = pf.toISOString().slice(0, 10);
  const day = `(created_at AT TIME ZONE 'Europe/Kyiv')::date`;
  const [tot, prev, daily, rows, legacy] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE kind='impression')::int AS impressions, COUNT(*) FILTER (WHERE kind='click')::int AS clicks,
                COUNT(DISTINCT NULLIF(user_key,''))::int AS "uniqueUsers" FROM ad_events WHERE ${day} BETWEEN $1::date AND $2::date`, [from, to]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE kind='impression')::int AS impressions, COUNT(*) FILTER (WHERE kind='click')::int AS clicks
                FROM ad_events WHERE ${day} BETWEEN $1::date AND ($2::date - 1)`, [prevFrom, from]),
    pool.query(`SELECT g.d::date::text AS day, COALESCE(SUM((e.kind='impression')::int),0)::int AS impressions, COALESCE(SUM((e.kind='click')::int),0)::int AS clicks
                FROM generate_series($1::date, $2::date, interval '1 day') g(d)
                LEFT JOIN ad_events e ON (e.created_at AT TIME ZONE 'Europe/Kyiv')::date = g.d::date
                GROUP BY g.d ORDER BY g.d`, [from, to]),
    pool.query(`SELECT placement, entity_id AS "entityId", COUNT(*) FILTER (WHERE kind='impression')::int AS impressions, COUNT(*) FILTER (WHERE kind='click')::int AS clicks
                FROM ad_events WHERE ${day} BETWEEN $1::date AND $2::date GROUP BY placement, entity_id ORDER BY impressions DESC, clicks DESC`, [from, to]),
    pool.query(`SELECT placement, COUNT(*) FILTER (WHERE kind='impression')::int AS impressions, COUNT(*) FILTER (WHERE kind='click')::int AS clicks
                FROM ad_events WHERE created_at > now() - INTERVAL '30 days' GROUP BY placement ORDER BY impressions DESC`),
  ]);
  return c.json({ from, to, totals: tot.rows[0], previous: { from: prevFrom, ...prev.rows[0] }, daily: daily.rows, rows: rows.rows, stats: legacy.rows });
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
