import adminPayments from './adminPayments';
import { validDate } from '../services/bannerRules';
import { pool } from '../db/client';
import { checkSchema } from '../services/schemaCheck';
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { adminUsersService } from '../services/adminUsersService';
import { csvCell } from '../utils/csv';

const adminUsers = new Hono();
adminUsers.route("/",adminPayments);

/** GET /api/admin/users — list of all users with aggregated betting stats */
adminUsers.get('/admin/users', requireAuth, requireAdmin, async (c) => {
  try {
    const users = await adminUsersService.getUsersOverview();
    return c.json({ users });
  } catch (err: any) {
    console.error('[Admin/Users] Error:', err.message);
    return c.json({ error: 'Failed to fetch users: ' + err.message }, 500);
  }
});

/** GET /api/admin/users/:id/bets — individual bets for a single user */
adminUsers.get('/admin/users/:id/bets', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  try {
    const bets = await adminUsersService.getUserBets(id);
    return c.json({ bets });
  } catch (err: any) {
    console.error('[Admin/UserBets] Error:', err.message);
    return c.json({ error: 'Failed to fetch bets: ' + err.message }, 500);
  }
});

adminUsers.get('/admin/users/:id/card', requireAuth, requireAdmin, async c => {
 const id=c.req.param('id') || ''; if(!/^\d+$/.test(id))return c.json({error:'Invalid user'},400);
 const user=await pool.query('SELECT id,username,telegram,role,is_owner AS "isOwner",start_date::text AS "startDate",end_date::text AS "endDate",price_month::text AS "priceMonth",created_at AS "createdAt" FROM users WHERE id::text=$1',[id]);
 if(!user.rows.length)return c.json({error:'Користувача не знайдено'},404);
 const [note,stats]=await Promise.all([
 pool.query('SELECT content,version,updated_by AS "updatedBy",updated_at AS "updatedAt" FROM admin_user_notes WHERE user_id::text=$1',[id]),
 pool.query(`SELECT currency,COUNT(*)::int AS bets,COUNT(*) FILTER(WHERE result='Win')::int AS wins,COUNT(*) FILTER(WHERE result='Loss')::int AS losses,COUNT(*) FILTER(WHERE result='Pending')::int AS pending,COALESCE(SUM(amount),0)::text AS staked,COALESCE(SUM(profit) FILTER(WHERE result IN ('Win','Loss')),0)::text AS profit FROM bets WHERE user_id::text=$1 GROUP BY currency ORDER BY currency`,[id])]);
 return c.json({user:user.rows[0],note:note.rows[0] || {content:'',version:0,updatedBy:null,updatedAt:null},stats:stats.rows});
});
adminUsers.put('/admin/users/:id/note', requireAuth, requireAdmin, async c => {
 const id=c.req.param('id') || ''; if(!/^\d+$/.test(id))return c.json({error:'Invalid user'},400);
 const body=await c.req.json().catch(()=>null);
 if(!body || typeof body.content !== 'string' || body.content.length > 5000 || !Number.isInteger(body.version) || body.version<0)return c.json({error:'Нотатка — до 5000 символів'},400);
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const user=await client.query('SELECT username FROM users WHERE id::text=$1 FOR KEY SHARE',[id]);
  if(!user.rows.length){await client.query('ROLLBACK');return c.json({error:'Користувача не знайдено'},404)}
  const actor=c.get('user');
  const result=await client.query(`INSERT INTO admin_user_notes(user_id,content,updated_by) SELECT $1::int,$2,$3 WHERE $4::int=0 OR EXISTS(SELECT 1 FROM admin_user_notes WHERE user_id=$1::int)
   ON CONFLICT(user_id) DO UPDATE SET content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=now(),version=admin_user_notes.version+1 WHERE admin_user_notes.version=$4
   RETURNING content,version,updated_by AS "updatedBy",updated_at AS "updatedAt"`,[id,body.content,actor.username,body.version]);
  if(!result.rows.length){await client.query('ROLLBACK');return c.json({error:'Нотатку змінив інший адміністратор. Скопіюйте свій текст і оновіть картку.'},409)}
  await client.query(`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'PUT',$3,$4,'success')`,[actor.userId,actor.username,`/admin/users/${id}/note`,JSON.stringify({targetUsername:user.rows[0].username,_targetUserId:id,note:'Оновлено внутрішню нотатку'})]);
  await client.query('COMMIT'); return c.json(result.rows[0]);
 } catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
});

// ── Журнал дій ──
// Categories: what part of the admin a record belongs to (by its target).
const AUDIT_CAT: Record<string, string> = {
  payments: `(a.target LIKE '/admin/payments/%' OR a.target ~ '^/admin/users/[0-9]+/payments$')`,
  users: `((a.target LIKE '/auth/register' OR a.target LIKE '/auth/users/%' OR a.target LIKE '/admin/users/%') AND a.target !~ '^/admin/users/[0-9]+/payments$')`,
  banners: `(a.target LIKE '/banners%')`,
  ads: `(a.target LIKE '/admin/bookmakers%' OR a.target LIKE '/admin/telegram-promos%' OR a.target LIKE '/admin/telegram-groups%')`,
  settings: `(a.target = '/admin/settings' OR a.target LIKE '/admin/audit%')`,
  security: `(a.target IN ('/auth/login','/auth/logout-all','/auth/change-password'))`,
};
const AUDIT_CATS = ['all', ...Object.keys(AUDIT_CAT)];
const TARGET_USER = `COALESCE(a.details->>'targetUsername', a.details->>'username', u.username)`;

type AuditFilter = { category: string; status: string; search: string; from: string | null; to: string | null; userId: string | null; history: boolean; actor: string };
function auditFilter(c: any): AuditFilter | { error: string } {
  const f: AuditFilter = {
    category: c.req.query('category') || 'all', status: c.req.query('status') || 'all',
    search: (c.req.query('q') || '').trim().replace(/^№\s*/, '').slice(0, 100),
    from: c.req.query('from') || null, to: c.req.query('to') || null, userId: c.req.query('userId') || null,
    history: c.req.query('history') === 'subscription', actor: (c.req.query('actor') || '').trim().replace(/^@/, '').slice(0, 100),
  };
  if (!validDate(f.from) || !validDate(f.to) || (f.from && f.to && f.from > f.to) || (f.userId && !/^\d+$/.test(f.userId))) return { error: 'Невірні дати або користувач' };
  if (!AUDIT_CATS.includes(f.category) || !['all', 'success', 'failed', 'pending'].includes(f.status)) return { error: 'Invalid audit filter' };
  return f;
}
/** WHERE clause + params; `skip` leaves one filter out (for per-category counts). */
function auditWhere(f: AuditFilter, skip?: 'category') {
  const p: unknown[] = []; const w: string[] = [];
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  if (skip !== 'category' && f.category !== 'all') w.push(AUDIT_CAT[f.category]);
  if (f.status !== 'all') w.push(`a.status = ${add(f.status)}`);
  if (f.search) { const q = add(f.search.toLowerCase()); w.push(`(strpos(lower(a.actor_name), ${q}) > 0 OR strpos(lower(COALESCE(${TARGET_USER}, '')), ${q}) > 0 OR strpos(lower(a.target), ${q}) > 0 OR strpos(lower(a.details::text), ${q}) > 0)`); }
  if (f.from) w.push(`a.created_at >= (${add(f.from)}::date::timestamp AT TIME ZONE 'Europe/Kyiv')`);
  if (f.to) w.push(`a.created_at < ((${add(f.to)}::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')`);
  if (f.userId) { const u = add(f.userId); w.push(`(substring(a.target from '^/auth/users/([0-9]+)') = ${u} OR a.details->>'_targetUserId' = ${u})`); }
  if (f.actor) w.push(`lower(a.actor_name) = lower(${add(f.actor)})`);
  if (f.history) w.push(`(a.status='success' AND (a.target LIKE '/auth/%' OR a.target LIKE '/admin/users/%/payments') AND ((CASE WHEN a.details ? '_changes' THEN (a.details->'_changes') ?| ARRAY['startDate','endDate','priceMonth'] ELSE a.details ?| ARRAY['startDate','endDate','priceMonth'] END) OR a.target='/auth/register'))`);
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}
const AUDIT_FROM = `FROM admin_audit_log a LEFT JOIN users actor ON actor.id = a.actor_id LEFT JOIN users u ON u.id::text = substring(a.target from '^/auth/users/([0-9]+)')`;
const catCase = `CASE ${Object.entries(AUDIT_CAT).map(([k, v]) => `WHEN ${v} THEN '${k}'`).join(' ')} ELSE 'other' END`;

adminUsers.get('/admin/audit', requireAuth, requireAdmin, async (c) => {
  const f = auditFilter(c);
  if ('error' in f) return c.json({ error: f.error }, 400);
  const limit = [25, 30, 50].includes(Number(c.req.query('limit'))) ? Number(c.req.query('limit')) : 25;
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page')) || 1)));
  const wh = auditWhere(f);
  const off = wh.params.length + 1;
  const result = await pool.query(
    `SELECT a.*, actor.telegram AS actor_telegram, ${TARGET_USER} AS target_username, ${catCase} AS category, COUNT(*) OVER() AS _total
     ${AUDIT_FROM} ${wh.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit + 1} OFFSET $${off}`,
    [...wh.params, (page - 1) * limit],
  );
  const total = result.rows.length ? Number(result.rows[0]._total) : 0;
  const body: Record<string, unknown> = { entries: result.rows.slice(0, limit).map(({ _total, ...r }: any) => r), hasMore: result.rows.length > limit, total, limit };
  if (c.req.query('summary') === '1') {
    const cw = auditWhere(f, 'category');
    const [counts, sum, actors] = await Promise.all([
      pool.query(`SELECT ${catCase} AS category, COUNT(*)::int AS n ${AUDIT_FROM} ${cw.sql} GROUP BY 1`, cw.params),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE a.created_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'))::int AS today,
          COUNT(*) FILTER (WHERE a.created_at > now() - interval '7 days')::int AS week,
          COUNT(*) FILTER (WHERE a.created_at > now() - interval '7 days' AND a.status = 'failed')::int AS failed7,
          COUNT(*) FILTER (WHERE a.created_at > now() - interval '7 days' AND ${AUDIT_CAT.security})::int AS security7
        FROM admin_audit_log a`),
      pool.query(`SELECT a.actor_name AS name, MAX(actor.telegram) AS telegram, COUNT(*) FILTER (WHERE a.created_at > now() - interval '7 days')::int AS week, COUNT(*)::int AS total
        ${AUDIT_FROM} WHERE a.created_at > now() - interval '90 days' GROUP BY a.actor_name ORDER BY week DESC, total DESC LIMIT 30`),
    ]);
    const lastOf = async (cond: string) => (await pool.query(`SELECT a.id, a.action, a.target, a.details, a.actor_name, a.created_at, ${TARGET_USER} AS target_username ${AUDIT_FROM} WHERE a.created_at > now() - interval '7 days' AND ${cond} ORDER BY a.created_at DESC LIMIT 1`)).rows[0] || null;
    const [lastFailed, lastSecurity] = await Promise.all([lastOf(`a.status = 'failed'`), lastOf(AUDIT_CAT.security)]);
    body.counts = Object.fromEntries(counts.rows.map((r: any) => [r.category, r.n]));
    body.summary = { ...sum.rows[0], lastFailed, lastSecurity, topActor: actors.rows[0] && actors.rows[0].week ? { name: actors.rows[0].name, week: actors.rows[0].week } : null };
    body.actors = actors.rows;
  }
  return c.json(body);
});

/** GET /admin/audit/export — full CSV export honoring the same filters. */
adminUsers.get('/admin/audit/export', requireAuth, requireAdmin, async (c) => {
  const f = auditFilter(c);
  if ('error' in f) return c.json({ error: f.error }, 400);
  const wh = auditWhere(f);
  const result = await pool.query(`SELECT a.actor_name, a.action, a.target, ${TARGET_USER} AS target_username, ${catCase} AS category, a.status, a.created_at, a.details
    ${AUDIT_FROM} ${wh.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT 50000`, wh.params);
  const escape = csvCell; // quotes + neutralizes =,+,-,@ formulas
  const header = ['Дата', 'Автор', 'Розділ', 'Дія', 'Обʼєкт', 'Користувач', 'Результат', 'Зміни'].map(escape).join(',');
  const changes = (d: any) => { const ch = d?._changes; return ch && typeof ch === 'object' ? Object.entries(ch).map(([k, v]: any) => `${k}: ${v?.before ?? '—'} → ${v?.after ?? '—'}`).join('; ') : ''; };
  const rows = result.rows.map((r: any) => [r.created_at ? new Date(r.created_at).toISOString() : '', r.actor_name || '', r.category, r.action || '', r.target || '', r.target_username || '', r.status || '', changes(r.details)].map(escape).join(','));
  return new Response('﻿' + [header, ...rows].join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"' } });
});

async function isOwner(userId: number) {
  const r = await pool.query('SELECT is_owner FROM users WHERE id=$1', [userId]).catch(() => ({ rows: [] as any[] }));
  return !!r.rows[0]?.is_owner;
}

/** GET /admin/schema-check — what the live database lacks compared with the code schema (owner only, read-only). */
adminUsers.get('/admin/schema-check', requireAuth, requireAdmin, async (c) => {
  if (!(await isOwner(c.get('user').userId))) return c.json({ error: 'Лише для овнера' }, 403);
  const gaps = await checkSchema();
  return c.json({ ok: gaps.length === 0, missing: gaps });
});

/** GET /admin/audit/cleanup?days=N — how many records would be removed (owner only). */
adminUsers.get('/admin/audit/cleanup', requireAuth, requireAdmin, async (c) => {
  if (!(await isOwner(c.get('user').userId))) return c.json({ error: 'Очищати журнал може лише овнер' }, 403);
  const days = Math.max(1, Math.min(3650, Number(c.req.query('days')) || 180));
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE created_at < now() - ($1::int * interval '1 day')`, [days]);
  return c.json({ days, count: r.rows[0].n });
});

/** DELETE /admin/audit/cleanup — purge audit entries older than N days (owner only). */
adminUsers.delete('/admin/audit/cleanup', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  if (!(await isOwner(actor.userId))) return c.json({ error: 'Очищати журнал може лише овнер' }, 403);
  const days = Math.max(1, Math.min(3650, Number(c.req.query('days')) || 180));
  const result = await pool.query(`DELETE FROM admin_audit_log WHERE created_at < now() - ($1::int * interval '1 day')`, [days]);
  // Record the purge itself (best-effort — it's a cleanup of the very table being pruned).
  try {
    await pool.query(
      'INSERT INTO admin_audit_log (actor_id,actor_name,action,target,details,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [actor.userId, actor.username, 'DELETE', '/admin/audit/cleanup', JSON.stringify({ days, removed: result.rowCount ?? 0 }), 'success'],
    );
  } catch { /* non-fatal */ }
  return c.json({ removed: result.rowCount ?? 0 });
});
export default adminUsers;
