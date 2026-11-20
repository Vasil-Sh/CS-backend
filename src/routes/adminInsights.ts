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

// Ticket list, conversation, reply and status changes live in routes/adminSupport.ts.

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
    const kind = ['problem', 'idea', 'question'].includes(body.kind) ? body.kind : 'problem';
    // context the app attaches: device, app version, screen — short strings only
    const meta: Record<string, string> = {};
    if (body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) {
      for (const key of ['device', 'appVersion', 'screen']) {
        const v = (body.meta as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) meta[key] = v.trim().slice(0, 100);
      }
    }
    const id = await createSupportTicket({
      userId: user.userId,
      username: user.username,
      subject: body.subject.trim(),
      message: body.message.trim(),
      kind,
      meta,
    });
    return c.json({ id }, 201);
  } catch (err: any) {
    console.error('[Support] Error:', err.message);
    return c.json({ error: 'Failed to create ticket: ' + err.message }, 500);
  }
});

export default adminInsights;
