import adminPayments from './adminPayments';
import { validDate } from '../services/bannerRules';
import { pool } from '../db/client';
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { adminUsersService } from '../services/adminUsersService';

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
 const user=await pool.query('SELECT id,username,telegram,role,start_date::text AS "startDate",end_date::text AS "endDate",price_month::text AS "priceMonth",created_at AS "createdAt" FROM users WHERE id::text=$1',[id]);
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

adminUsers.get('/admin/audit', requireAuth, requireAdmin, async (c) => {
 const page = Math.max(1, Math.min(100000, Number(c.req.query('page')) || 1));
 const offset = (Math.floor(page) - 1) * 30;
 const category = c.req.query('category') || 'all';
 const status = c.req.query('status') || 'all';
 const search = (c.req.query('q') || '').trim().slice(0,100);
 const from = c.req.query('from') || null, to = c.req.query('to') || null;
 const userId = c.req.query('userId') || null;
 const history = c.req.query('history') === 'subscription';
 if(!validDate(from) || !validDate(to) || (from && to && from > to) || (userId && !/^\d+$/.test(userId))) return c.json({error:'Невірні дати або користувач'},400);
 if (!['all','users','banners'].includes(category) || !['all','success','failed','pending'].includes(status)) return c.json({error:'Invalid audit filter'},400);
 const result = await pool.query(`SELECT a.*, actor.telegram AS actor_telegram, COALESCE(a.details->>'targetUsername', a.details->>'username', u.username) AS target_username
 FROM admin_audit_log a
 LEFT JOIN users actor ON actor.id = a.actor_id
 LEFT JOIN users u ON u.id::text = substring(a.target from '^/auth/users/([0-9]+)')
 WHERE ($2 = 'all' OR ($2 = 'users' AND (a.target LIKE '/auth/%' OR a.target LIKE '/admin/users/%' OR a.target LIKE '/admin/payments/%')) OR ($2 = 'banners' AND a.target LIKE '/banners%'))
 AND ($3 = 'all' OR a.status = $3)
 AND ($4 = '' OR strpos(lower(a.actor_name), lower($4)) > 0 OR strpos(lower(COALESCE(a.details->>'targetUsername', a.details->>'username', u.username, '')), lower($4)) > 0)
 AND ($5::date IS NULL OR a.created_at >= ($5::date::timestamp AT TIME ZONE 'Europe/Kyiv'))
 AND ($6::date IS NULL OR a.created_at < (($6::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'))
 AND ($7::text IS NULL OR substring(a.target from '^/auth/users/([0-9]+)') = $7 OR a.details->>'_targetUserId' = $7)
 AND (NOT $8::boolean OR (a.status='success' AND (a.target LIKE '/auth/%' OR a.target LIKE '/admin/users/%/payments') AND ((CASE WHEN a.details ? '_changes' THEN (a.details->'_changes') ?| ARRAY['startDate','endDate','priceMonth'] ELSE a.details ?| ARRAY['startDate','endDate','priceMonth'] END) OR a.target='/auth/register')))
 ORDER BY a.created_at DESC, a.id DESC LIMIT 31 OFFSET $1`, [offset, category, status, search, from, to, userId, history]);
 return c.json({ entries: result.rows.slice(0,30), hasMore: result.rows.length > 30 });
});

/** GET /admin/audit/export — full CSV export honoring the same filters. */
adminUsers.get('/admin/audit/export', requireAuth, requireAdmin, async (c) => {
 const category = c.req.query('category') || 'all';
 const status = c.req.query('status') || 'all';
 const search = (c.req.query('q') || '').trim().slice(0,100);
 const from = c.req.query('from') || null, to = c.req.query('to') || null;
 const userId = c.req.query('userId') || null;
 if(!validDate(from) || !validDate(to) || (from && to && from > to) || (userId && !/^\d+$/.test(userId))) return c.json({error:'Невірні дати або користувач'},400);
 if (!['all','users','banners'].includes(category) || !['all','success','failed','pending'].includes(status)) return c.json({error:'Invalid audit filter'},400);
 const result = await pool.query(`SELECT a.actor_name, actor.telegram AS actor_telegram, a.action, a.target, COALESCE(a.details->>'targetUsername', a.details->>'username', u.username) AS target_username, a.status, a.created_at
 FROM admin_audit_log a
 LEFT JOIN users actor ON actor.id = a.actor_id
 LEFT JOIN users u ON u.id::text = substring(a.target from '^/auth/users/([0-9]+)')
 WHERE ($1 = 'all' OR ($1 = 'users' AND (a.target LIKE '/auth/%' OR a.target LIKE '/admin/users/%' OR a.target LIKE '/admin/payments/%')) OR ($1 = 'banners' AND a.target LIKE '/banners%'))
 AND ($2 = 'all' OR a.status = $2)
 AND ($3 = '' OR strpos(lower(a.actor_name), lower($3)) > 0 OR strpos(lower(COALESCE(a.details->>'targetUsername', a.details->>'username', u.username, '')), lower($3)) > 0)
 AND ($4::date IS NULL OR a.created_at >= ($4::date::timestamp AT TIME ZONE 'Europe/Kyiv'))
 AND ($5::date IS NULL OR a.created_at < (($5::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv'))
 AND ($6::text IS NULL OR substring(a.target from '^/auth/users/([0-9]+)') = $6 OR a.details->>'_targetUserId' = $6)
 ORDER BY a.created_at DESC, a.id DESC LIMIT 50000`, [category, status, search, from, to, userId]);

 const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
 const header = ['Дата','Автор','Дія','Обʼєкт','Користувач','Результат'].map(escape).join(',');
 const rows = result.rows.map((r: any) => [
   r.created_at ? new Date(r.created_at).toISOString() : '',
   r.actor_name || '',
   r.action || '',
   r.target || '',
   r.target_username || '',
   r.status || '',
 ].map(escape).join(','));
 const csv = '\uFEFF' + [header, ...rows].join('\r\n');
 return new Response(csv, {
   headers: {
     'Content-Type': 'text/csv; charset=utf-8',
     'Content-Disposition': 'attachment; filename="audit-log.csv"',
   },
 });
});

/** DELETE /admin/audit/cleanup — purge audit entries older than N days. */
adminUsers.delete('/admin/audit/cleanup', requireAuth, requireAdmin, async (c) => {
 const days = Math.max(1, Math.min(3650, Number(c.req.query('days')) || 180));
 const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
 const actor = c.get('user');
 const result = await pool.query('DELETE FROM admin_audit_log WHERE created_at < $1', [cutoff]);
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
