import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { createSupportTicket } from '../services/insights';

const adminInsights = new Hono();

/** GET /api/admin/insights — AI usage, parser failures, support tickets, age flags */
adminInsights.get('/admin/insights', requireAuth, requireAdmin, async (c) => {
  try {
    const [ai, parser, tickets, age] = await Promise.all([
      pool.query(
        `SELECT provider,
                COUNT(*)::int AS calls,
                COALESCE(SUM(prompt_tokens)::bigint,0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens)::bigint,0) AS completion_tokens,
                COALESCE(SUM(cost)::numeric,0) AS cost
         FROM ai_usage
         GROUP BY provider ORDER BY provider`,
      ),
      pool.query(
        `SELECT source, COUNT(*)::int AS count, MAX(created_at) AS last_failure
         FROM parser_failures
         WHERE created_at > now() - INTERVAL '24 hours'
         GROUP BY source ORDER BY count DESC`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS open FROM support_tickets WHERE status='open'`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS unverified_age
         FROM users WHERE role='user' AND (birth_date IS NULL)`,
      ),
    ]);

    const openTickets = Number(tickets.rows[0]?.open ?? 0);

    return c.json({
      aiUsage: ai.rows.map((r: any) => ({
        provider: r.provider,
        calls: Number(r.calls),
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        costUsd: Number(r.cost),
      })),
      parserFailures: parser.rows.map((r: any) => ({
        source: r.source,
        count: Number(r.count),
        lastFailure: r.last_failure ? new Date(r.last_failure).toISOString() : '',
      })),
      supportTickets: { open: openTickets },
      ageVerification: { unverifiedAge: Number(age.rows[0]?.unverified_age ?? 0) },
    });
  } catch (err: any) {
    console.error('[Admin/Insights] Error:', err.message);
    return c.json({ error: 'Failed to fetch insights: ' + err.message }, 500);
  }
});

/** GET /api/admin/support-tickets — list support tickets */
adminInsights.get('/admin/support-tickets', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'open';
    if (!['open', 'resolved', 'closed'].includes(status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    const result = await pool.query(
      `SELECT id::text AS id, user_id AS "userId", username, subject, message,
              status, created_at AS "createdAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
       FROM support_tickets
       WHERE status = $1
       ORDER BY created_at DESC LIMIT 100`,
      [status],
    );
    return c.json({ tickets: result.rows });
  } catch (err: any) {
    console.error('[Admin/Tickets] Error:', err.message);
    return c.json({ error: 'Failed to fetch tickets: ' + err.message }, 500);
  }
});

/** PATCH /api/admin/support-tickets/:id — resolve/close a ticket */
adminInsights.patch('/admin/support-tickets/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid ticket' }, 400);
  const body = await c.req.json().catch(() => null);
  const status = body?.status;
  if (!['resolved', 'closed'].includes(status)) {
    return c.json({ error: 'Status must be resolved or closed' }, 400);
  }
  const actor = c.get('user');
  const result = await pool.query(
    `UPDATE support_tickets
     SET status = $2, resolved_at = now(), resolved_by = $3
     WHERE id::text = $1 RETURNING id::text AS id`,
    [id, status, actor.username],
  );
  if (!result.rows.length) return c.json({ error: 'Ticket not found' }, 404);
  return c.json({ success: true });
});

/** POST /api/support — authenticated users create a support ticket */
adminInsights.post('/support', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200) {
    return c.json({ error: 'Тема — обовʼязкова (до 200 символів)' }, 400);
  }
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 5000) {
    return c.json({ error: 'Повідомлення — обовʼязкове (до 5000 символів)' }, 400);
  }
  try {
    const user = c.get('user');
    const id = await createSupportTicket({
      userId: user.userId,
      username: user.username,
      subject: body.subject.trim(),
      message: body.message.trim(),
    });
    return c.json({ id }, 201);
  } catch (err: any) {
    console.error('[Support] Error:', err.message);
    return c.json({ error: 'Failed to create ticket: ' + err.message }, 500);
  }
});

export default adminInsights;
