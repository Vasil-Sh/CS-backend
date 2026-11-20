import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { recordAudit } from '../services/auditLog';
import { telegramBotService } from '../services/telegramBot';
import { LINK_LABEL, REASON_LABEL, linkKey, linkState, mainReason, screenText, segments } from '../services/groupScreening';

/** Moderation of Telegram groups that users added (moderation_status: pending/approved/rejected). */
const groups = new Hono();
const STATUSES = ['pending', 'approved', 'rejected'] as const;
const PAGE = 20;

const columns = `g.id::text AS id, g.name, g.link, g.game, g.has_channel AS "hasChannel", g.comment,
  g.user_id AS "userId", u.username AS "addedBy", u.plan AS "addedByPlan",
  g.moderation_status AS "moderationStatus", g.reviewed_by AS "reviewedBy", g.reviewed_at AS "reviewedAt",
  g.reject_reason AS "rejectReason", g.created_at AS "createdAt"`;

type Row = {
  id: string; name: string; link: string | null; game: string | null; hasChannel: boolean; comment: string | null;
  userId: number | null; addedBy: string | null; addedByPlan: string | null; moderationStatus: string;
  reviewedBy: string | null; reviewedAt: string | null; rejectReason: string | null; createdAt: string;
};
type BetAgg = { bets7d: number; betsTotal: number; wins: number; losses: number; lastBetAt: string | null };

/** Bets users logged for each group (the app's «розбір прогнозів»): bet_data.groupId → group id. */
async function betStats(ids: string[]): Promise<Map<string, BetAgg>> {
  const out = new Map<string, BetAgg>();
  if (!ids.length) return out;
  const r = await pool.query(
    `SELECT bet_data->>'groupId' AS gid,
            COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "bets7d",
            COUNT(*)::int AS "betsTotal",
            COUNT(*) FILTER (WHERE bet_data->>'result' = 'Win')::int AS wins,
            COUNT(*) FILTER (WHERE bet_data->>'result' = 'Loss')::int AS losses,
            MAX(created_at) AS "lastBetAt"
     FROM telegram_bets WHERE bet_data->>'groupId' = ANY($1) GROUP BY 1`,
    [ids],
  ).catch(() => ({ rows: [] as (BetAgg & { gid: string })[] }));
  r.rows.forEach((x: BetAgg & { gid: string }) => out.set(x.gid, { bets7d: x.bets7d, betsTotal: x.betsTotal, wins: x.wins, losses: x.losses, lastBetAt: x.lastBetAt }));
  return out;
}

/** Group row + what the admin needs to decide: suspicious phrases, link problem, how many people added it, bets. */
function enrich(g: Row, people: Map<string, number>, bets: Map<string, BetAgg>) {
  const hits = [...screenText(g.name), ...screenText(g.comment || '')];
  const ls = linkState(g.link);
  const b = bets.get(g.id) || { bets7d: 0, betsTotal: 0, wins: 0, losses: 0, lastBetAt: null };
  const decided = b.wins + b.losses;
  return {
    ...g,
    flags: [...new Set(hits.map((h) => h.phrase.toLowerCase()))],
    flagReason: mainReason(hits) ? REASON_LABEL[mainReason(hits)!] : null,
    linkState: ls,
    linkProblem: ls === 'ok' ? null : LINK_LABEL[ls],
    people: Math.max(1, people.get(linkKey(g.link) || `id:${g.id}`) || 1),
    ...b,
    hitRate: decided ? Math.round((b.wins / decided) * 100) : null,
  };
}

const FILTERS = ['all', ...STATUSES, 'errors'] as const;

/** GET /admin/telegram-groups?status=pending|approved|rejected|errors|all&q=&page= — list, counts and summary. */
groups.get('/admin/telegram-groups', requireAuth, requireAdmin, async (c) => {
  const status = c.req.query('status') || 'all';
  if (!(FILTERS as readonly string[]).includes(status)) return c.json({ error: 'Invalid status' }, 400);
  const q = (c.req.query('q') || '').trim().slice(0, 100).toLowerCase().replace(/^@/, '');
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page')) || 1)));
  // every group at once — there are tens to hundreds of them, and counts/«people» need all links anyway
  const all = (await pool.query(
    `SELECT ${columns} FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id
     ORDER BY (g.moderation_status = 'pending') DESC, g.created_at DESC, g.id LIMIT 5000`,
  )).rows as Row[];
  const people = new Map<string, Set<number>>();
  all.forEach((g) => { const k = linkKey(g.link) || `id:${g.id}`; if (!people.has(k)) people.set(k, new Set()); if (g.userId) people.get(k)!.add(g.userId); });
  const peopleN = new Map([...people].map(([k, v]) => [k, v.size]));
  const bets = await betStats(all.map((g) => g.id));
  const rows = all.map((g) => enrich(g, peopleN, bets));
  const isErr = (g: ReturnType<typeof enrich>) => g.moderationStatus !== 'rejected' && g.linkState !== 'ok';
  const shown = rows.filter((g) => (status === 'all' || (status === 'errors' ? isErr(g) : g.moderationStatus === status))
    && (!q || g.name.toLowerCase().includes(q) || (g.link || '').toLowerCase().includes(q) || (g.addedBy || '').toLowerCase().includes(q)));
  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  rows.forEach((g) => { byStatus[g.moderationStatus] = (byStatus[g.moderationStatus] || 0) + 1; });
  const errs = rows.filter(isErr);
  const pending = rows.filter((g) => g.moderationStatus === 'pending');
  const flaggedReasons = pending.map((g) => g.flagReason).filter(Boolean) as string[];
  const topReason = flaggedReasons.sort((a, b) => flaggedReasons.filter((x) => x === b).length - flaggedReasons.filter((x) => x === a).length)[0] || null;
  return c.json({
    groups: shown.slice((page - 1) * PAGE, page * PAGE),
    hasMore: shown.length > page * PAGE,
    counts: { ...byStatus, errors: errs.length, all: rows.length },
    summary: {
      all: rows.length,
      people: new Set(rows.map((g) => g.userId).filter(Boolean)).size,
      working: rows.filter((g) => g.moderationStatus === 'approved' && g.linkState === 'ok').length,
      bets7d: rows.reduce((a, g) => a + g.bets7d, 0),
      errors: errs.length,
      errorKinds: [...new Set(errs.map((g) => g.linkProblem))].filter(Boolean),
      pending: pending.length,
      flagged: pending.filter((g) => g.flags.length).length,
      pendingReason: topReason,
    },
  });
});

/** GET /admin/telegram-groups/:id — one group: highlighted suspicious text, recent bets users logged from it. */
groups.get('/admin/telegram-groups/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid group' }, 400);
  const r = await pool.query(`SELECT ${columns} FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id WHERE g.id::text = $1`, [id]);
  const g = r.rows[0] as Row | undefined;
  if (!g) return c.json({ error: 'Групу не знайдено' }, 404);
  const same = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS n FROM telegram_groups WHERE id::text = $1 OR (COALESCE(link,'') <> '' AND lower(regexp_replace(regexp_replace(link, '^(https?://)?(www\\.)?(t\\.me|telegram\\.me)/(s/)?|^@', '', 'i'), '/+$', '')) = $2)`,
    [id, linkKey(g.link)],
  );
  const bets = await betStats([id]);
  const recent = await pool.query(
    `SELECT bet_data->>'match' AS match, bet_data->>'betType' AS "betType", (bet_data->>'odds')::text AS odds, bet_data->>'result' AS result, created_at AS "createdAt"
     FROM telegram_bets WHERE bet_data->>'groupId' = $1 ORDER BY created_at DESC LIMIT 5`,
    [id],
  ).catch(() => ({ rows: [] }));
  const texts = [{ field: 'name', text: g.name }, { field: 'comment', text: g.comment || '' }]
    .filter((x) => x.text && screenText(x.text).length)
    .map((x) => ({ field: x.field, parts: segments(x.text) }));
  return c.json({ group: { ...enrich(g, new Map([[linkKey(g.link) || `id:${g.id}`, same.rows[0]?.n || 1]]), bets), flaggedTexts: texts }, recentBets: recent.rows });
});

async function decide(c: any, status: 'approved' | 'rejected', reason: string | null) {
  const id = c.req.param('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid group' }, 400);
  const actor = c.get('user');
  const before = await pool.query(
    `SELECT g.moderation_status AS status, g.name, g.user_id AS "userId", u.username, u.telegram_chat_id AS "chatId"
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
  // the person who added it gets the explanation (and a note when it's back)
  if (row.chatId && row.status !== status && (status === 'rejected' || row.status === 'rejected')) {
    const name = row.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    void telegramBotService.sendMessage(row.chatId, status === 'rejected'
      ? `🚫 Групу «${name}» заблоковано в MatchIQ. Причина: ${(reason || '').replace(/</g, '&lt;')}. Розбір прогнозів з неї зупинено.`
      : `✅ Групу «${name}» знову розблоковано в MatchIQ — її видно в застосунку.`);
  }
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
