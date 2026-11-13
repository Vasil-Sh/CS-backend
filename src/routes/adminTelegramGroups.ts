import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { recordAudit } from '../services/auditLog';

/** Moderation of Telegram groups that users added (moderation_status: pending/approved/rejected). */
const groups = new Hono();
const STATUSES = ['pending', 'approved', 'rejected'] as const;
const PAGE = 20;

const columns = `g.id::text AS id, g.name, g.link, g.game, g.has_channel AS "hasChannel", g.comment,
  g.user_id AS "userId", u.username AS "addedBy", u.plan AS "addedByPlan",
  g.moderation_status AS "moderationStatus", g.reviewed_by AS "reviewedBy", g.reviewed_at AS "reviewedAt",
  g.reject_reason AS "rejectReason", g.created_at AS "createdAt"`;

/** GET /admin/telegram-groups?status=pending|approved|rejected|all&q=&page= */
groups.get('/admin/telegram-groups', requireAuth, requireAdmin, async (c) => {
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !(STATUSES as readonly string[]).includes(status)) return c.json({ error: 'Invalid status' }, 400);
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page')) || 1)));
  const result = await pool.query(
    `SELECT ${columns}
     FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id
     WHERE ($1 = 'all' OR g.moderation_status = $1)
       AND ($2 = '' OR strpos(lower(g.name), lower($2)) > 0 OR strpos(lower(COALESCE(g.link,'')), lower($2)) > 0 OR strpos(lower(COALESCE(u.username,'')), lower($2)) > 0)
     ORDER BY (g.moderation_status = 'pending') DESC, g.created_at DESC, g.id
     LIMIT ${PAGE + 1} OFFSET $3`,
    [status, q, (page - 1) * PAGE],
  );
  const counts = await pool.query(
    `SELECT moderation_status AS status, COUNT(*)::int AS count FROM telegram_groups GROUP BY 1`,
  );
  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  counts.rows.forEach((r: { status: string; count: number }) => { byStatus[r.status] = Number(r.count); });
  return c.json({
    groups: result.rows.slice(0, PAGE),
    hasMore: result.rows.length > PAGE,
    counts: { ...byStatus, all: byStatus.pending + byStatus.approved + byStatus.rejected },
  });
});

async function decide(c: any, status: 'approved' | 'rejected', reason: string | null) {
  const id = c.req.param('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid group' }, 400);
  const actor = c.get('user');
  const before = await pool.query(
    `SELECT g.moderation_status AS status, g.name, g.user_id AS "userId", u.username
     FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id WHERE g.id::text = $1`,
    [id],
  );
  const row = before.rows[0];
  if (!row) return c.json({ error: 'Групу не знайдено' }, 404);
  await pool.query(
    `UPDATE telegram_groups SET moderation_status = $2, reviewed_by = $3, reviewed_at = now(),
       reject_reason = $4, updated_at = now() WHERE id::text = $1`,
    [id, status, actor.username, reason],
  );
  await recordAudit(actor, 'POST', `/admin/telegram-groups/${id}/${status === 'approved' ? 'approve' : 'reject'}`, {
    fields: {
      targetUsername: row.username || '',
      _targetUserId: String(row.userId || ''),
      groupId: id,
      groupName: row.name,
      moderationStatus: { before: row.status, after: status },
      ...(reason ? { rejectReason: reason } : {}),
    },
  });
  return c.json({ success: true, moderationStatus: status });
}

/** POST /admin/telegram-groups/:id/approve */
groups.post('/admin/telegram-groups/:id/approve', requireAuth, requireAdmin, (c) => decide(c, 'approved', null));

/** POST /admin/telegram-groups/:id/reject — body { reason } (1–500 chars) */
groups.post('/admin/telegram-groups/:id/reject', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500) return c.json({ error: 'Вкажіть причину відхилення (до 500 символів)' }, 400);
  return decide(c, 'rejected', reason);
});

export default groups;
