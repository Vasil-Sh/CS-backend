import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { collectChannel, previewChannel, publicHandle, settleTgTips, tgCandidates, tgCycle, tgNextAt } from '../services/tgSources';
import { isNight } from '../services/nightMode';

/** «Telegram-джерела» in the admin: channels we read, their posts, the queue of posts we did not understand. */
const tg = new Hono();
const DAY = 86_400_000;

function audit(actor: { userId: number; username: string }, action: string, target: string, details: Record<string, unknown>): void {
  void pool.query(`INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status) VALUES($1,$2,$3,$4,$5,'success')`,
    [actor.userId, actor.username, action, target, JSON.stringify(details)]).catch(() => {});
}
const kyivDay = (t: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date(t));

/** GET /api/admin/tg-sources — channels with their week, totals, invites users added (not readable yet). */
tg.get('/admin/tg-sources', requireAuth, requireAdmin, async (c) => {
  const [chs, posts, groups] = await Promise.all([
    pool.query(`SELECT handle, title, subscribers, game, is_test AS "isTest", paused, added_by AS "addedBy", last_post_at AS "lastPostAt", checked_at AS "checkedAt", error, created_at AS "createdAt" FROM tg_channels ORDER BY created_at`),
    pool.query<{ handle: string; posted_at: string; kind: string; result: string | null; odds: string | null }>(
      `SELECT handle, posted_at, kind, result, odds FROM tg_posts WHERE posted_at > now() - interval '30 days'`),
    pool.query<{ name: string; link: string; status: string; username: string | null }>(
      `SELECT g.name, g.link, g.moderation_status AS status, u.username FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id WHERE g.link <> ''`),
  ]);
  const now = Date.now(), days = Array.from({ length: 7 }, (_, i) => kyivDay(now - (6 - i) * DAY));
  const who = new Map<string, Set<string>>(), blocked = new Set<string>();
  const invites: { name: string; link: string; who: string[] }[] = [];
  for (const g of groups.rows) {
    const h = publicHandle(g.link);
    if (!h) { if (/t\.me\/(\+|joinchat)/i.test(g.link) && g.status !== 'rejected') { const x = invites.find((i) => i.link === g.link); if (x) { if (g.username) x.who.push(`@${g.username}`); } else invites.push({ name: g.name, link: g.link, who: g.username ? [`@${g.username}`] : [] }); } continue; }
    if (g.status === 'rejected') blocked.add(h);
    if (g.username) (who.get(h) || who.set(h, new Set()).get(h)!).add(`@${g.username}`);
  }
  const channels = chs.rows.map((ch: any) => {
    const ps = posts.rows.filter((p) => p.handle === ch.handle);
    const wk = ps.filter((p) => now - Date.parse(p.posted_at) < 7 * DAY);
    const tips = wk.filter((p) => p.kind === 'bet').length, unk = wk.filter((p) => p.kind === 'unknown').length;
    const settled = ps.filter((p) => p.kind === 'bet' && p.result);
    const wins = settled.filter((p) => p.result === 'Win').length;
    const priced = settled.filter((p) => p.odds != null);
    const profit = priced.reduce((a, p) => a + (p.result === 'Win' ? Number(p.odds) - 1 : -1), 0);
    const users = [...(who.get(ch.handle) || [])];
    return {
      ...ch, status: blocked.has(ch.handle) ? 'block' : ch.paused ? 'stop' : ch.error ? 'err' : 'run',
      posts7d: wk.length, tips7d: tips, unknown7d: unk, recognized: tips + unk ? Math.round((tips / (tips + unk)) * 100) : null,
      settled: settled.length, wins, winrate: settled.length ? Math.round((wins / settled.length) * 100) : null,
      roi: priced.length ? Math.round((profit / priced.length) * 100) : null, pending: ps.filter((p) => p.kind === 'bet' && !p.result).length,
      users, days: days.map((d) => wk.filter((p) => kyivDay(Date.parse(p.posted_at)) === d).length),
    };
  });
  const p24 = posts.rows.filter((p) => now - Date.parse(p.posted_at) < DAY);
  const wk = posts.rows.filter((p) => now - Date.parse(p.posted_at) < 7 * DAY);
  const tips7 = wk.filter((p) => p.kind === 'bet').length, unk7 = wk.filter((p) => p.kind === 'unknown').length;
  const settled = posts.rows.filter((p) => p.kind === 'bet' && p.result);
  return c.json({
    channels, invites, days,
    totals: { channels: channels.length, running: channels.filter((x) => x.status === 'run').length, posts24h: p24.length, tips24h: p24.filter((p) => p.kind === 'bet').length,
      recognized: tips7 + unk7 ? Math.round((tips7 / (tips7 + unk7)) * 100) : null, unknown7d: unk7, settled30d: settled.length,
      winrate30d: settled.length ? Math.round((settled.filter((p) => p.result === 'Win').length / settled.length) * 100) : null, pending: posts.rows.filter((p) => p.kind === 'bet' && !p.result).length },
    night: isNight(), nextAt: tgNextAt.at ? new Date(tgNextAt.at).toISOString() : null,
  });
});

const postCols = `handle, post_id AS "postId", posted_at AS "postedAt", text, kind, reason, game, match_id AS "matchId", team1, team2, market, pick, odds::float AS odds, result, score, fixed_by AS "fixedBy"`;

/** GET /api/admin/tg-sources/:handle/posts — the channel's newest posts with what we made of them. */
tg.get('/admin/tg-sources/:handle/posts', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(`SELECT ${postCols} FROM tg_posts WHERE handle = $1 ORDER BY posted_at DESC LIMIT 30`, [c.req.param('handle')]);
  return c.json({ posts: rows });
});

/** GET /api/admin/tg-posts/unrecognized — posts that look like tips but were not understood (7 days). */
tg.get('/admin/tg-posts/unrecognized', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT ${postCols.replace(/handle,/, 'p.handle,')}, ch.title FROM tg_posts p LEFT JOIN tg_channels ch ON ch.handle = p.handle
     WHERE p.kind = 'unknown' AND p.posted_at > now() - interval '7 days' ORDER BY p.posted_at DESC LIMIT 100`);
  return c.json({ posts: rows });
});

/** GET /api/admin/tg-posts/matches?q= — matches a post can be tied to (feed + last 3 days). */
tg.get('/admin/tg-posts/matches', requireAuth, requireAdmin, async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const all = await tgCandidates();
  const list = all.filter((m) => !q || `${m.team1} ${m.team2} ${(m.aliases1 || []).join(' ')} ${(m.aliases2 || []).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => Math.abs(Date.parse(a.start) - Date.now()) - Math.abs(Date.parse(b.start) - Date.now())).slice(0, 20)
    .map(({ id, game, team1, team2, start }) => ({ id, game, team1, team2, start }));
  return c.json({ matches: list });
});

/** POST /api/admin/tg-posts/:handle/:postId — the admin's decision: «Не прогноз» or the tip (match, market, pick, odds); «remember» adds a channel rule. */
tg.post('/admin/tg-posts/:handle/:postId', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const handle = c.req.param('handle') || '', postId = Number(c.req.param('postId'));
  const b = await c.req.json().catch(() => null) as { kind?: string; matchId?: string; market?: string; side?: 1 | 2; line?: number; over?: boolean; odds?: number | null; remember?: boolean } | null;
  if (!b || !postId) return c.json({ error: 'Invalid body' }, 400);
  if (b.kind === 'other') {
    await pool.query(`UPDATE tg_posts SET kind = 'other', reason = NULL, fixed_by = $3 WHERE handle = $1 AND post_id = $2`, [handle, postId, actor.username]);
    audit(actor, 'POST', `/admin/tg-posts/${handle}/${postId}`, { kind: 'other' });
    return c.json({ ok: true });
  }
  const m = (await tgCandidates()).find((x) => x.id === b.matchId);
  if (!m) return c.json({ error: 'Матч не знайдено — оберіть інший' }, 400);
  const mk = b.market || 'Match Winner';
  const market = mk === 'Match Winner' ? 'Match Winner' : mk === 'Total' ? `Total Maps ${b.over === false ? 'Under' : 'Over'} ${Number(b.line || 2.5)}` : mk === 'Handicap' ? `Handicap ${Number(b.line) > 0 ? '+' : ''}${Number(b.line || -1.5)}` : '';
  if (!market) return c.json({ error: 'Невідомий ринок' }, 400);
  const pick = mk === 'Total' ? '' : b.side === 2 ? m.team2 : m.team1;
  const odds = b.odds != null && Number(b.odds) > 1 ? Number(b.odds) : null;
  await pool.query(
    `UPDATE tg_posts SET kind = 'bet', reason = NULL, game = $3, match_id = $4, team1 = $5, team2 = $6, market = $7, pick = $8, odds = $9, result = NULL, score = NULL, fixed_by = $10 WHERE handle = $1 AND post_id = $2`,
    [handle, postId, m.game, m.id, m.team1, m.team2, market, pick, odds, actor.username]);
  if (b.remember && mk === 'Match Winner') await pool.query(`UPDATE tg_channels SET rules = rules || jsonb_build_object('oddsOnly', $2::text) WHERE handle = $1`, [handle, b.side === 2 ? 'p2' : 'p1']);
  void settleTgTips().catch(() => {});
  audit(actor, 'POST', `/admin/tg-posts/${handle}/${postId}`, { kind: 'bet', match: `${m.team1} — ${m.team2}`, market, pick, odds, remember: !!b.remember });
  return c.json({ ok: true });
});

/** POST /api/admin/tg-sources/preview {link} — what the channel looks like before adding it. */
tg.post('/admin/tg-sources/preview', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null) as { link?: string } | null;
  return c.json(await previewChannel(String(b?.link || '')));
});

/** POST /api/admin/tg-sources {link, game, test} — add a channel (a test one stays hidden from users) and read it right away. */
tg.post('/admin/tg-sources', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const b = await c.req.json().catch(() => null) as { link?: string; game?: string; test?: boolean } | null;
  const handle = publicHandle(b?.link);
  if (!handle) return c.json({ error: 'Потрібне публічне посилання t.me/… або @нікнейм' }, 400);
  const game = b?.game === 'cs2' || b?.game === 'dota2' ? b.game : 'both';
  await pool.query(`INSERT INTO tg_channels(handle, game, is_test, added_by) VALUES($1,$2,$3,$4)
    ON CONFLICT (handle) DO UPDATE SET game = EXCLUDED.game, is_test = tg_channels.is_test AND EXCLUDED.is_test, paused = false`, [handle, game, b?.test !== false, `@${actor.username}`]);
  audit(actor, 'POST', '/admin/tg-sources', { handle, game, test: b?.test !== false });
  const added = await collectChannel(handle).catch(() => 0);
  return c.json({ ok: true, handle, added });
});

/** POST /api/admin/tg-sources/:handle/pause {paused} — stop / start reading. */
tg.post('/admin/tg-sources/:handle/pause', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '';
  const b = await c.req.json().catch(() => ({})) as { paused?: boolean };
  const { rowCount } = await pool.query('UPDATE tg_channels SET paused = $2 WHERE handle = $1', [handle, !!b.paused]);
  if (!rowCount) return c.json({ error: 'Канал не знайдено' }, 404);
  audit(actor, 'POST', `/admin/tg-sources/${handle}/pause`, { paused: !!b.paused });
  return c.json({ ok: true });
});

/** POST /api/admin/tg-sources/:handle/refresh — read the channel now (or all of them with handle «all»). */
tg.post('/admin/tg-sources/:handle/refresh', requireAuth, requireAdmin, async (c) => {
  const handle = c.req.param('handle') || '';
  if (handle === 'all') { void tgCycle().catch(() => {}); return c.json({ ok: true, started: true }); }
  const added = await collectChannel(handle);
  await settleTgTips().catch(() => 0);
  return c.json({ ok: true, added });
});

/** DELETE /api/admin/tg-sources/:handle — remove a test channel with its posts. */
tg.delete('/admin/tg-sources/:handle', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '';
  const { rowCount } = await pool.query('DELETE FROM tg_channels WHERE handle = $1 AND is_test', [handle]);
  if (!rowCount) return c.json({ error: 'Видалити можна лише тестовий канал' }, 400);
  await pool.query('DELETE FROM tg_posts WHERE handle = $1', [handle]);
  audit(actor, 'DELETE', `/admin/tg-sources/${handle}`, {});
  return c.json({ ok: true });
});

export default tg;
