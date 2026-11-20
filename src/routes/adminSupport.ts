import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { recordAudit } from '../services/auditLog';
import { telegramBotService } from '../services/telegramBot';

/**
 * Support: tickets from the in-app form «Проблема чи побажання», a conversation per ticket,
 * statuses open (new) → in_progress → waiting (we answered, waiting for the user) → resolved / closed.
 */
const support = new Hono();

export const STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
export const KINDS = ['problem', 'idea', 'question'] as const;
const FILTERS = ['open', 'new', 'mine', 'resolved', 'all'] as const;
type Filter = (typeof FILTERS)[number];

const ticketCols = `t.id::text AS id, t.user_id AS "userId", COALESCE(NULLIF(t.username,''), u.username, '') AS username,
  u.plan AS plan, t.subject, t.message, t.kind, t.status, t.assignee, t.meta,
  t.created_at AS "createdAt", t.updated_at AS "updatedAt", t.first_reply_at AS "firstReplyAt",
  t.resolved_at AS "resolvedAt", t.resolved_by AS "resolvedBy"`;

/** WHERE fragment for a list filter; $1 is the admin's username. */
export function filterSql(filter: Filter): string {
  switch (filter) {
    case 'new': return `t.status = 'open'`;
    case 'mine': return `t.assignee = $1 AND t.status NOT IN ('resolved','closed')`;
    case 'resolved': return `t.status IN ('resolved','closed')`;
    case 'all': return 'TRUE';
    default: return `t.status NOT IN ('resolved','closed')`;
  }
}

/** Escape text for Telegram's HTML parse mode. */
export function tgEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** GET /admin/support-tickets?filter=open|new|mine|resolved|all&kind=&q= — list, counts and the four summary numbers. */
support.get('/admin/support-tickets', requireAuth, requireAdmin, async (c) => {
  const me = c.get('user').username;
  // older callers pass ?status=open|resolved|closed
  const legacy = c.req.query('status');
  const filter = (FILTERS as readonly string[]).includes(c.req.query('filter') || '') ? (c.req.query('filter') as Filter)
    : legacy === 'resolved' || legacy === 'closed' ? 'resolved' : legacy === 'open' ? 'new' : 'open';
  const kind = c.req.query('kind') || '';
  if (kind && !(KINDS as readonly string[]).includes(kind)) return c.json({ error: 'Invalid kind' }, 400);
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const list = await pool.query(
    `SELECT ${ticketCols},
       (SELECT json_build_object('body', m.body, 'fromAdmin', m.from_admin, 'author', m.author, 'createdAt', m.created_at)
          FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage",
       (SELECT COUNT(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS replies
     FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
     WHERE ${filterSql(filter)}
       AND ($2 = '' OR t.kind = $2)
       AND ($3 = '' OR strpos(lower(t.subject), lower($3)) > 0 OR strpos(lower(t.message), lower($3)) > 0
            OR strpos(lower(COALESCE(NULLIF(t.username,''), u.username, '')), lower(ltrim($3, '@'))) > 0)
     ORDER BY (t.status = 'open') DESC, t.updated_at DESC, t.id DESC
     LIMIT 200`,
    [me, kind, q],
  );
  const counts = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
       COUNT(*) FILTER (WHERE status = 'open')::int AS new,
       COUNT(*) FILTER (WHERE assignee = $1 AND status NOT IN ('resolved','closed'))::int AS mine,
       COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
       MIN(created_at) FILTER (WHERE status = 'open') AS "oldestNew",
       COUNT(*) FILTER (WHERE status IN ('in_progress','waiting'))::int AS "inWork",
       COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND resolved_at > now() - interval '7 days')::int AS "resolvedWeek",
       COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND resolved_at > now() - interval '7 days' AND kind = 'problem')::int AS "resolvedProblems",
       COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND resolved_at > now() - interval '7 days' AND kind = 'idea')::int AS "resolvedIdeas",
       AVG(EXTRACT(EPOCH FROM (first_reply_at - created_at)) / 60)
         FILTER (WHERE first_reply_at IS NOT NULL AND created_at > now() - interval '7 days') AS "avgFirstReplyMin"
     FROM support_tickets`,
    [me],
  );
  const by = await pool.query(
    `SELECT assignee, COUNT(*)::int AS n FROM support_tickets
     WHERE status IN ('in_progress','waiting') AND assignee IS NOT NULL GROUP BY assignee ORDER BY n DESC`,
  );
  const k = counts.rows[0] || {};
  return c.json({
    tickets: list.rows,
    counts: { open: k.open ?? 0, new: k.new ?? 0, mine: k.mine ?? 0, resolved: k.resolved ?? 0 },
    stats: {
      new: k.new ?? 0,
      oldestNewAt: k.oldestNew ?? null,
      inWork: k.inWork ?? 0,
      inWorkBy: by.rows.map((r: { assignee: string; n: number }) => ({ assignee: r.assignee, count: r.n })),
      avgFirstReplyMin: k.avgFirstReplyMin == null ? null : Math.round(Number(k.avgFirstReplyMin)),
      resolvedWeek: k.resolvedWeek ?? 0,
      resolvedProblems: k.resolvedProblems ?? 0,
      resolvedIdeas: k.resolvedIdeas ?? 0,
    },
  });
});

/** GET /admin/support-tickets/:id — ticket, conversation and a little context about the user. */
support.get('/admin/support-tickets/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid ticket' }, 400);
  const t = await pool.query(`SELECT ${ticketCols} FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id::text = $1`, [id]);
  const ticket = t.rows[0];
  if (!ticket) return c.json({ error: 'Звернення не знайдено' }, 404);
  const msgs = await pool.query(
    `SELECT id::text AS id, author, from_admin AS "fromAdmin", body, created_at AS "createdAt"
     FROM support_messages WHERE ticket_id::text = $1 ORDER BY created_at, id`,
    [id],
  );
  let aiToday: number | null = null;
  if (ticket.userId) {
    const ai = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'`,
      [ticket.userId],
    ).catch(() => ({ rows: [{ n: null }] }));
    aiToday = ai.rows[0]?.n ?? null;
  }
  return c.json({ ticket, messages: msgs.rows, context: { aiToday } });
});

async function loadTicket(id: string) {
  const r = await pool.query(
    `SELECT t.id, t.status, t.assignee, t.subject, t.user_id AS "userId", COALESCE(NULLIF(t.username,''), u.username, '') AS username, u.telegram_chat_id AS "chatId"
     FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id::text = $1`,
    [id],
  );
  return r.rows[0] as { id: number; status: string; assignee: string | null; subject: string; userId: number | null; username: string; chatId: number | null } | undefined;
}

/** PATCH /admin/support-tickets/:id — body { status?, assignee? } (assignee null = nobody). */
support.patch('/admin/support-tickets/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid ticket' }, 400);
  const body = await c.req.json().catch(() => null);
  const status = body?.status;
  const hasAssignee = body && Object.prototype.hasOwnProperty.call(body, 'assignee');
  const assignee = hasAssignee ? (typeof body.assignee === 'string' && body.assignee.trim() ? body.assignee.trim().replace(/^@/, '').slice(0, 100) : null) : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) return c.json({ error: 'Invalid status' }, 400);
  if (status === undefined && !hasAssignee) return c.json({ error: 'Nothing to change' }, 400);
  const before = await loadTicket(id);
  if (!before) return c.json({ error: 'Звернення не знайдено' }, 404);
  const actor = c.get('user');
  const closing = status === 'resolved' || status === 'closed';
  await pool.query(
    `UPDATE support_tickets SET
       status = COALESCE($2, status),
       assignee = CASE WHEN $3 THEN $4 ELSE assignee END,
       resolved_at = CASE WHEN $5 THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE resolved_at END,
       resolved_by = CASE WHEN $5 THEN $6 WHEN $2 IS NOT NULL THEN NULL ELSE resolved_by END,
       updated_at = now()
     WHERE id::text = $1`,
    [id, status ?? null, !!hasAssignee, assignee ?? null, closing, actor.username],
  );
  await recordAudit(actor, 'PATCH', `/admin/support-tickets/${id}`, {
    fields: {
      targetUsername: before.username,
      _targetUserId: String(before.userId || ''),
      ticketId: id,
      subject: before.subject.slice(0, 200),
      ...(status !== undefined ? { status: { before: before.status, after: status } } : {}),
      ...(hasAssignee ? { assignee: { before: before.assignee, after: assignee } } : {}),
    },
  });
  if (closing && before.chatId) {
    void telegramBotService.sendMessage(before.chatId, `✅ Звернення «${tgEscape(before.subject)}» закрито. Якщо щось ще — просто напишіть у підтримку в застосунку.`);
  }
  return c.json({ success: true });
});

/** POST /admin/support-tickets/:id/reply — body { body, status? }. Goes to the app conversation and to Telegram. */
support.post('/admin/support-tickets/:id/reply', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid ticket' }, 400);
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 5000) return c.json({ error: 'Напишіть відповідь (до 5000 символів)' }, 400);
  const nextStatus = body?.status === undefined ? 'waiting' : body.status;
  if (!(STATUSES as readonly string[]).includes(nextStatus)) return c.json({ error: 'Invalid status' }, 400);
  const t = await loadTicket(id);
  if (!t) return c.json({ error: 'Звернення не знайдено' }, 404);
  const actor = c.get('user');
  const closing = nextStatus === 'resolved' || nextStatus === 'closed';
  const ins = await pool.query(
    `INSERT INTO support_messages(ticket_id, author, from_admin, body) VALUES($1,$2,true,$3)
     RETURNING id::text AS id, author, from_admin AS "fromAdmin", body, created_at AS "createdAt"`,
    [t.id, actor.username, text],
  );
  await pool.query(
    `UPDATE support_tickets SET status = $2, assignee = COALESCE(assignee, $3),
       first_reply_at = COALESCE(first_reply_at, now()), updated_at = now(),
       resolved_at = CASE WHEN $4 THEN now() ELSE NULL END, resolved_by = CASE WHEN $4 THEN $3 ELSE NULL END
     WHERE id = $1`,
    [t.id, nextStatus, actor.username, closing],
  );
  await recordAudit(actor, 'POST', `/admin/support-tickets/${id}/reply`, {
    fields: { targetUsername: t.username, _targetUserId: String(t.userId || ''), ticketId: id, subject: t.subject.slice(0, 200), status: { before: t.status, after: nextStatus } },
  });
  let telegram = false;
  if (t.chatId) {
    telegram = true;
    void telegramBotService.sendMessage(t.chatId, `💬 <b>Підтримка MatchIQ</b> · «${tgEscape(t.subject)}»\n\n${tgEscape(text)}`);
  }
  return c.json({ message: ins.rows[0], status: nextStatus, assignee: t.assignee || actor.username, telegram }, 201);
});

/** GET /support/tickets — the signed-in user's own tickets with the conversation. */
support.get('/support/tickets', requireAuth, async (c) => {
  const user = c.get('user');
  const t = await pool.query(
    `SELECT id::text AS id, subject, message, kind, status, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM support_tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
    [user.userId],
  );
  const ids = t.rows.map((r: { id: string }) => r.id);
  const m = ids.length ? await pool.query(
    `SELECT ticket_id::text AS "ticketId", author, from_admin AS "fromAdmin", body, created_at AS "createdAt"
     FROM support_messages WHERE ticket_id::text = ANY($1) ORDER BY created_at, id`,
    [ids],
  ) : { rows: [] as { ticketId: string }[] };
  return c.json({ tickets: t.rows.map((r: { id: string }) => ({ ...r, messages: m.rows.filter((x: { ticketId: string }) => x.ticketId === r.id) })) });
});

/** POST /support/tickets/:id/messages — the user answers in their ticket; a closed one opens again. */
support.post('/support/tickets/:id/messages', requireAuth, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid ticket' }, 400);
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 5000) return c.json({ error: 'Повідомлення — обовʼязкове (до 5000 символів)' }, 400);
  const user = c.get('user');
  const own = await pool.query('SELECT id FROM support_tickets WHERE id::text = $1 AND user_id = $2', [id, user.userId]);
  if (!own.rows.length) return c.json({ error: 'Звернення не знайдено' }, 404);
  await pool.query('INSERT INTO support_messages(ticket_id, author, from_admin, body) VALUES($1,$2,false,$3)', [own.rows[0].id, user.username, text]);
  await pool.query(
    `UPDATE support_tickets SET status = CASE WHEN status = 'open' THEN 'open' ELSE 'in_progress' END,
       resolved_at = NULL, resolved_by = NULL, updated_at = now() WHERE id = $1`,
    [own.rows[0].id],
  );
  return c.json({ success: true }, 201);
});

export default support;
