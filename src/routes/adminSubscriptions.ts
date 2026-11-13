import { Hono } from 'hono';
import { pool } from '../db/client';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { addDays, grantProDates, kyivToday } from '../services/subscriptionActions';
import { adminUsersService } from '../services/adminUsersService';

/** Admin actions on one user's subscription: grant Pro for N days, cancel the subscription. */
const subs = new Hono();

const audit = (client: { query: (q: string, p: unknown[]) => Promise<unknown> }, actor: { userId: number; username: string }, target: string, details: Record<string, unknown>) =>
  client.query(`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'POST',$3,$4,'success')`, [actor.userId, actor.username, target, JSON.stringify(details)]);

/** POST /admin/users/:id/grant-pro — body { days: 1–365, reason } */
subs.post('/admin/users/:id/grant-pro', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  const body = await c.req.json().catch(() => null);
  const days = Number(body?.days);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid user' }, 400);
  if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: 'Вкажіть від 1 до 365 днів' }, 400);
  if (!reason || reason.length > 500) return c.json({ error: 'Вкажіть причину (до 500 символів)' }, 400);
  const actor = c.get('user');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT username, role, plan, end_date::text AS "endDate", pro_until::text AS "proUntil", pro_base_plan AS "basePlan" FROM users WHERE id::text=$1 FOR UPDATE`, [id]);
    const u = r.rows[0];
    if (!u) { await client.query('ROLLBACK'); return c.json({ error: 'Користувача не знайдено' }, 404); }
    if (u.role === 'admin') { await client.query('ROLLBACK'); return c.json({ error: 'Адміністраторам план не потрібен' }, 409); }
    const today = kyivToday();
    const from = u.proUntil && u.proUntil >= today ? u.proUntil : today; // a running grant is extended
    const { proUntil, newEndDate } = grantProDates(from, days, u.endDate);
    const basePlan = u.proUntil ? u.basePlan : u.plan; // remember the plan to return to
    await client.query(`UPDATE users SET plan='pro', pro_until=$2, pro_base_plan=$3, end_date=$4, updated_at=now() WHERE id::text=$1`, [id, proUntil, basePlan, newEndDate]);
    await audit(client, actor, `/admin/users/${id}/grant-pro`, { targetUsername: u.username, _targetUserId: id, days, reason, proUntil, basePlan, endDate: { before: u.endDate, after: newEndDate } });
    await client.query('COMMIT');
    adminUsersService.invalidateOverview();
    return c.json({ success: true, proUntil, basePlan, endDate: newEndDate });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
});

/** POST /admin/users/:id/subscription/cancel — body { mode: 'end'|'now', reason? } */
subs.post('/admin/users/:id/subscription/cancel', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  const body = await c.req.json().catch(() => null);
  const mode = body?.mode;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid user' }, 400);
  if (mode !== 'end' && mode !== 'now') return c.json({ error: 'mode: end або now' }, 400);
  const actor = c.get('user');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT username, role, end_date::text AS "endDate" FROM users WHERE id::text=$1 FOR UPDATE`, [id]);
    const u = r.rows[0];
    if (!u) { await client.query('ROLLBACK'); return c.json({ error: 'Користувача не знайдено' }, 404); }
    if (u.role === 'admin') { await client.query('ROLLBACK'); return c.json({ error: 'У адміністратора немає підписки' }, 409); }
    // «Зараз» closes access today: the last paid day becomes yesterday.
    const newEnd = mode === 'now' ? addDays(kyivToday(), -1) : u.endDate;
    await client.query(
      `UPDATE users SET subscription_cancelled_at=now(), subscription_cancel_mode=$2, subscription_cancel_reason=$3, end_date=$4, pro_until=NULL,
              plan = COALESCE(pro_base_plan, plan), pro_base_plan=NULL, updated_at=now() WHERE id::text=$1`,
      [id, mode, reason, newEnd],
    );
    await audit(client, actor, `/admin/users/${id}/subscription/cancel`, { targetUsername: u.username, _targetUserId: id, mode, reason, endDate: { before: u.endDate, after: newEnd } });
    await client.query('COMMIT');
    adminUsersService.invalidateOverview();
    return c.json({ success: true, mode, endDate: newEnd });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
});

export default subs;
