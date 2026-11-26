import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';
import { collectArchive, collectChannel, fetchChannelPage, rereadChannel, firstRead, progress, previewChannel, publicHandle, settleTgTips, tgCandidates, tgCycle, tgNextAt } from '../services/tgSources';
import { isNight } from '../services/nightMode';
import { ocrStats } from '../services/tgOcr';
import { aiEnabled, aiQuota, aiStats } from '../services/tgAi';
import { feedMatches } from '../services/tgVerify';

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
  const [chs, posts, groups, all, again, money, byDay] = await Promise.all([
    pool.query(`SELECT handle, title, subscribers, game, is_test AS "isTest", paused, added_by AS "addedBy", last_post_at AS "lastPostAt", checked_at AS "checkedAt", error, created_at AS "createdAt", auto_paused AS "autoPaused", fails, profile FROM tg_channels ORDER BY created_at`),
    pool.query<{ handle: string; posted_at: string; kind: string; result: string | null; odds: string | null }>(
      `SELECT handle, posted_at, kind, result, odds FROM tg_posts WHERE posted_at > now() - interval '30 days'`),
    pool.query<{ name: string; link: string; status: string; username: string | null }>(
      `SELECT g.name, g.link, g.moderation_status AS status, u.username FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id WHERE g.link <> ''`),
    // all time: what the channel posted and how its tips went (a tip = 100 on the odds; repeats are not counted)
    pool.query<{ handle: string; total: string; tips: string; unknown: string; other: string; repeats: string; won: string; lost: string; pending: string; profit: string | null; priced: string; first_at: string | null;
      o_won: string; o_lost: string; o_profit: string | null; o_priced: string; confirmed: string; mismatches: string; ours_only: string; live: string; live_won: string; live_lost: string; deleted: string; edited: string; deleted_lost: string; odds_high: string; w_won: string; w_lost: string; w_profit: string | null; w_priced: string }>(
      `SELECT handle, count(*) AS total, count(*) FILTER (WHERE kind = 'bet') AS tips, count(*) FILTER (WHERE kind = 'unknown') AS unknown,
              count(*) FILTER (WHERE kind = 'other' AND reason IS DISTINCT FROM 'Повтор' AND reason IS DISTINCT FROM 'Результат') AS other, count(*) FILTER (WHERE reason IN ('Повтор', 'Результат')) AS repeats,
              count(*) FILTER (WHERE kind = 'bet' AND result = 'Win') AS won, count(*) FILTER (WHERE kind = 'bet' AND result = 'Loss') AS lost,
              count(*) FILTER (WHERE kind = 'bet' AND result IS NULL) AS pending,
              sum(CASE WHEN kind = 'bet' AND result = 'Win' AND odds IS NOT NULL THEN (odds - 1) * 100 WHEN kind = 'bet' AND result = 'Loss' AND odds IS NOT NULL THEN -100 END) AS profit,
              count(*) FILTER (WHERE kind = 'bet' AND result IS NOT NULL AND odds IS NOT NULL) AS priced, min(posted_at) AS first_at,
              -- our own check: results by our scores, the channel's claims we confirmed / disproved
              count(*) FILTER (WHERE kind = 'bet' AND our_result = 'Win') AS o_won, count(*) FILTER (WHERE kind = 'bet' AND our_result = 'Loss') AS o_lost,
              sum(CASE WHEN kind = 'bet' AND our_result = 'Win' AND odds IS NOT NULL THEN (odds - 1) * 100 WHEN kind = 'bet' AND our_result = 'Loss' AND odds IS NOT NULL THEN -100 END) AS o_profit,
              count(*) FILTER (WHERE kind = 'bet' AND our_result IS NOT NULL AND odds IS NOT NULL) AS o_priced,
              count(*) FILTER (WHERE kind = 'bet' AND settled_by = 'slip' AND our_result IS NOT NULL AND NOT mismatch) AS confirmed,
              count(*) FILTER (WHERE kind = 'bet' AND mismatch) AS mismatches, count(*) FILTER (WHERE kind = 'bet' AND settled_by = 'ours') AS ours_only,
              count(*) FILTER (WHERE kind = 'bet' AND is_live) AS live, count(*) FILTER (WHERE kind = 'bet' AND is_live AND result = 'Win') AS live_won, count(*) FILTER (WHERE kind = 'bet' AND is_live AND result = 'Loss') AS live_lost,
              count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted, count(*) FILTER (WHERE edited_at IS NOT NULL) AS edited,
              count(*) FILTER (WHERE kind = 'bet' AND deleted_at IS NOT NULL AND COALESCE(our_result, result) = 'Loss') AS deleted_lost,
              count(*) FILTER (WHERE kind = 'bet' AND odds_high) AS odds_high,
              -- this week (the «канал тижня»)
              count(*) FILTER (WHERE kind = 'bet' AND posted_at > now() - interval '7 days' AND COALESCE(our_result, result) = 'Win') AS w_won,
              count(*) FILTER (WHERE kind = 'bet' AND posted_at > now() - interval '7 days' AND COALESCE(our_result, result) = 'Loss') AS w_lost,
              sum(CASE WHEN kind = 'bet' AND posted_at > now() - interval '7 days' AND odds IS NOT NULL THEN CASE COALESCE(our_result, result) WHEN 'Win' THEN (odds - 1) * 100 WHEN 'Loss' THEN -100 END END) AS w_profit,
              count(*) FILTER (WHERE kind = 'bet' AND posted_at > now() - interval '7 days' AND odds IS NOT NULL AND COALESCE(our_result, result) IN ('Win', 'Loss')) AS w_priced
         FROM tg_posts GROUP BY handle`),
    pool.query<{ handle: string; n: string }>(`SELECT handle, count(*) AS n FROM tg_posts WHERE photos IS NULL GROUP BY handle`),
    // real money from the slips (the slip's currency): won → paid − staked, lost → −staked
    pool.query<{ handle: string; currency: string; profit: string; staked: string; n: string }>(
      `SELECT handle, currency, sum(CASE WHEN result = 'Win' THEN COALESCE(payout - stake, stake * (odds - 1)) WHEN result = 'Loss' THEN -stake ELSE 0 END) AS profit,
              sum(stake) FILTER (WHERE result IN ('Win', 'Loss')) AS staked, count(*) FILTER (WHERE result IN ('Win', 'Loss')) AS n
         FROM tg_posts WHERE kind = 'bet' AND stake IS NOT NULL AND currency IS NOT NULL GROUP BY handle, currency`),
    // 7 days by kind, for the day sheet
    pool.query<{ handle: string; day: string; kind: string; reason: string | null; n: string }>(
      `SELECT handle, to_char(posted_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, kind, reason, count(*) AS n FROM tg_posts
        WHERE posted_at > now() - interval '8 days' GROUP BY 1, 2, 3, 4`),
  ]);
  const agg = new Map(all.rows.map((r) => [r.handle, r]));
  const rereading = new Map(again.rows.map((r) => [r.handle, Number(r.n)]));
  const moneyOf = (h: string) => money.rows.filter((r) => r.handle === h && Number(r.n) > 0)
    .map((r) => ({ currency: r.currency, profit: Math.round(Number(r.profit) * 100) / 100, staked: Math.round(Number(r.staked || 0) * 100) / 100, bets: Number(r.n) }))
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit));
  const dayOf = (h: string, d: string) => {
    const rs = byDay.rows.filter((r) => r.handle === h && r.day === d), cnt = (f: (r: typeof rs[number]) => boolean) => rs.filter(f).reduce((x, r) => x + Number(r.n), 0);
    return { tips: cnt((r) => r.kind === 'bet'), unknown: cnt((r) => r.kind === 'unknown'), info: cnt((r) => r.kind === 'other' && r.reason !== 'Повтор' && r.reason !== 'Результат'), repeats: cnt((r) => r.kind === 'other' && (r.reason === 'Повтор' || r.reason === 'Результат')) };
  };
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
    const a = agg.get(ch.handle), n = (x?: string | null) => Number(x || 0);
    const tipsAll = n(a?.tips), unkAll = n(a?.unknown), wonAll = n(a?.won), lostAll = n(a?.lost), pricedAll = n(a?.priced), profitAll = Math.round(n(a?.profit));
    return {
      ...ch, status: blocked.has(ch.handle) ? 'block' : ch.paused ? 'stop' : ch.error ? 'err' : 'run',
      posts7d: wk.length, tips7d: tips, unknown7d: unk, recognized: tips + unk ? Math.round((tips / (tips + unk)) * 100) : null,
      settled: settled.length, wins, winrate: settled.length ? Math.round((wins / settled.length) * 100) : null,
      roi: priced.length ? Math.round((profit / priced.length) * 100) : null, pending: ps.filter((p) => p.kind === 'bet' && !p.result).length,
      users, rereading: rereading.get(ch.handle) || 0, money: moneyOf(ch.handle), daysDetail: days.map((d) => dayOf(ch.handle, d)), progress: progress.get(ch.handle) || null,
      all: { posts: n(a?.total), tips: tipsAll, unknown: unkAll, other: n(a?.other), repeats: n(a?.repeats), won: wonAll, lost: lostAll, pending: n(a?.pending),
        recognized: tipsAll + unkAll ? Math.round((tipsAll / (tipsAll + unkAll)) * 100) : null, winrate: wonAll + lostAll ? Math.round((wonAll / (wonAll + lostAll)) * 100) : null,
        profit: pricedAll ? profitAll : null, roi: pricedAll ? Math.round(profitAll / pricedAll) : null, firstAt: a?.first_at ?? null,
        // our check: ROI by our scores, how honest the channel's results are (confirmed / (confirmed + disproved))
        ours: { won: n(a?.o_won), lost: n(a?.o_lost), roi: n(a?.o_priced) ? Math.round(n(a?.o_profit) / n(a?.o_priced)) : null, onlyOurs: n(a?.ours_only) },
        confirmed: n(a?.confirmed), mismatches: n(a?.mismatches), honesty: n(a?.confirmed) + n(a?.mismatches) ? Math.round((n(a?.confirmed) / (n(a?.confirmed) + n(a?.mismatches))) * 100) : null,
        live: n(a?.live), liveWon: n(a?.live_won), liveLost: n(a?.live_lost), deleted: n(a?.deleted), edited: n(a?.edited), deletedLost: n(a?.deleted_lost), oddsHigh: n(a?.odds_high),
        week: { won: n(a?.w_won), lost: n(a?.w_lost), roi: n(a?.w_priced) ? Math.round(n(a?.w_profit) / n(a?.w_priced)) : null } },
      days: days.map((d) => wk.filter((p) => kyivDay(Date.parse(p.posted_at)) === d).length),
    };
  });
  const p24 = posts.rows.filter((p) => now - Date.parse(p.posted_at) < DAY);
  const wk = posts.rows.filter((p) => now - Date.parse(p.posted_at) < 7 * DAY);
  const tips7 = wk.filter((p) => p.kind === 'bet').length, unk7 = wk.filter((p) => p.kind === 'unknown').length;
  const settled = posts.rows.filter((p) => p.kind === 'bet' && p.result);
  return c.json({
    channels, invites, days,
    totals: { channels: channels.length, running: channels.filter((x) => x.status === 'run').length, posts24h: p24.length, tips24h: p24.filter((p) => p.kind === 'bet').length,
      recognized: tips7 + unk7 ? Math.round((tips7 / (tips7 + unk7)) * 100) : null, unknown7d: unk7, queue: all.rows.reduce((x, r) => x + Number(r.unknown || 0), 0), settled30d: settled.length,
      winrate30d: settled.length ? Math.round((settled.filter((p) => p.result === 'Win').length / settled.length) * 100) : null, pending: posts.rows.filter((p) => p.kind === 'bet' && !p.result).length },
    // the channel of the week: the best ROI (ours where we checked) of the last 7 days, at least 3 settled tips
    best: (() => { const c = channels.filter((x: any) => x.all.week.won + x.all.week.lost >= 3 && x.all.week.roi != null).sort((x: any, y: any) => y.all.week.roi - x.all.week.roi)[0]; return c ? { handle: c.handle, title: c.title, roi: c.all.week.roi, won: c.all.week.won, lost: c.all.week.lost } : null; })(),
    alerts: { unknown: all.rows.reduce((x, r) => x + Number(r.unknown || 0), 0), mismatches: all.rows.reduce((x, r) => x + Number(r.mismatches || 0), 0) },
    reader: { ai: aiEnabled(), model: aiStats.model || null, quota: aiQuota(), aiCalls: aiStats.calls, aiFailed: aiStats.failed, aiError: aiStats.lastError,
      ocrImages: ocrStats.images, ocrFailed: ocrStats.failed, ocrAvgMs: ocrStats.images ? Math.round(ocrStats.ms / ocrStats.images) : null, ocrError: ocrStats.lastError },
    night: isNight(), nextAt: tgNextAt.at ? new Date(tgNextAt.at).toISOString() : null,
  });
});

const postCols = `handle, post_id AS "postId", posted_at AS "postedAt", text, kind, reason, game, match_id AS "matchId", team1, team2, market, pick, odds::float AS odds, result, score, fixed_by AS "fixedBy", COALESCE(photos, '{}') AS photos, ocr, slip, stake::float AS stake, currency, payout::float AS payout, our_odds::float AS "ourOdds", odds_high AS "oddsHigh", claim, our_result AS "ourResult", settled_by AS "settledBy", mismatch, is_live AS "isLive", deleted_at AS "deletedAt", edited_at AS "editedAt", legs`;
/** A tip on a match of our feed that is on now / ahead: its live state and score. */
function withLive<T extends { matchId?: string | null; kind?: string }>(rows: T[]): (T & { live?: { status: string; score1: number | null; score2: number | null; start: string } })[] {
  const feed = feedMatches();
  return rows.map((r) => { const m = r.kind === 'bet' && r.matchId ? feed.find((x) => x.id === r.matchId) : undefined; return m ? { ...r, live: { status: m.status, score1: m.score1, score2: m.score2, start: m.start } } : r; });
}

/** GET /api/admin/tg-sources/:handle/posts — the channel's newest posts with what we made of them. */
tg.get('/admin/tg-sources/:handle/posts', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(`SELECT ${postCols} FROM tg_posts WHERE handle = $1 ORDER BY posted_at DESC LIMIT 30`, [c.req.param('handle')]);
  return c.json({ posts: withLive(rows) });
});

/** GET /api/admin/tg-posts/unrecognized — posts that look like tips but were not understood (not sorted yet, newest 100). */
tg.get('/admin/tg-posts/unrecognized', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT ${postCols.replace(/(^|, )(?!COALESCE)(\w+)/g, '$1p.$2').replace('COALESCE(photos', 'COALESCE(p.photos').replace(/(^|, )(our_result|settled_by|is_live|deleted_at|edited_at|our_odds|odds_high)/g, '$1p.$2')}, ch.title FROM tg_posts p LEFT JOIN tg_channels ch ON ch.handle = p.handle
     WHERE (p.kind = 'unknown' AND p.fixed_by IS NULL) OR (p.kind = 'bet' AND p.mismatch) ORDER BY p.mismatch DESC, p.posted_at DESC LIMIT 100`);
  return c.json({ posts: rows });
});

/** GET /api/admin/tg-posts/matches?q= — matches a post can be tied to: today, tomorrow, live (feed) and the last 30 days. */
tg.get('/admin/tg-posts/matches', requireAuth, requireAdmin, async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const all = await tgCandidates(since);
  const feed = new Map(feedMatches().map((m) => [m.id, m]));
  const list = all.filter((m) => !q || `${m.team1} ${m.team2} ${(m.aliases1 || []).join(' ')} ${(m.aliases2 || []).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => Math.abs(Date.parse(a.start) - Date.now()) - Math.abs(Date.parse(b.start) - Date.now())).slice(0, 20)
    .map(({ id, game, team1, team2, start }) => ({ id, game, team1, team2, start, status: feed.get(id)?.status || (Date.parse(start) < Date.now() - 6 * 3_600_000 ? 'finished' : 'upcoming') }));
  return c.json({ matches: list });
});

/** POST /api/admin/tg-posts/:handle/:postId — the admin's decision: «Не прогноз» or the tip (match, market, pick, odds); «remember» adds a channel rule. */
tg.post('/admin/tg-posts/:handle/:postId', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const handle = c.req.param('handle') || '', postId = Number(c.req.param('postId'));
  const b = await c.req.json().catch(() => null) as { kind?: string; matchId?: string; market?: string; side?: 1 | 2; line?: number; over?: boolean; map?: number; odds?: number | null; remember?: boolean } | null;
  if (!b || !postId) return c.json({ error: 'Invalid body' }, 400);
  if (b.kind === 'other') {
    await pool.query(`UPDATE tg_posts SET kind = 'other', reason = NULL, fixed_by = $3 WHERE handle = $1 AND post_id = $2`, [handle, postId, actor.username]);
    audit(actor, 'POST', `/admin/tg-posts/${handle}/${postId}`, { kind: 'other' });
    return c.json({ ok: true });
  }
  // a match of our feed, or the one read from the post itself (not in the feed: «tg:…»)
  let m: { id: string; game: string; team1: string; team2: string } | undefined = (await tgCandidates()).find((x) => x.id === b.matchId);
  if (!m && b.matchId) {
    const own = (await pool.query<{ match_id: string; game: string | null; team1: string; team2: string }>('SELECT match_id, game, team1, team2 FROM tg_posts WHERE handle = $1 AND post_id = $2 AND match_id = $3', [handle, postId, b.matchId])).rows[0];
    if (own?.team1 && own.team2) m = { id: own.match_id, game: own.game || 'cs2', team1: own.team1, team2: own.team2 };
  }
  if (!m) return c.json({ error: 'Матч не знайдено — оберіть інший' }, 400);
  const mk = b.market || 'Match Winner';
  const ln = Math.abs(Number(b.line) || 1.5), mapN = Math.min(5, Math.max(1, Math.round(Number(b.map) || 1)));
  const market = mk === 'Match Winner' ? 'Match Winner' : mk === 'Total' ? `Total Maps ${b.over === false ? 'Under' : 'Over'} ${Number(b.line || 2.5)}`
    : mk === 'Handicap' ? `Handicap ${Number(b.line) > 0 ? '+' : '-'}${ln}` : mk === 'Map' ? `Map ${mapN} Winner` : '';
  if (!market) return c.json({ error: 'Невідомий ринок' }, 400);
  const pick = mk === 'Total' ? '' : b.side === 2 ? m.team2 : m.team1;
  const odds = b.odds != null && Number(b.odds) > 1 ? Number(b.odds) : null;
  await pool.query(
    `UPDATE tg_posts SET kind = 'bet', reason = NULL, game = $3, match_id = $4, team1 = $5, team2 = $6, market = $7, pick = $8, odds = $9, result = CASE slip WHEN 'won' THEN 'Win' WHEN 'lost' THEN 'Loss' ELSE NULL END, score = NULL, our_result = NULL, mismatch = false, settled_by = NULL, fixed_by = $10 WHERE handle = $1 AND post_id = $2`,
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
  // reading takes a while (screenshots, ≈6 s a post with the AI reader): it runs on, the list shows the progress
  void firstRead(handle).catch((e) => console.warn(`[tg] add ${handle}:`, (e as Error).message));
  return c.json({ ok: true, handle, started: true });
});

/** POST /api/admin/tg-sources/:handle/pause {paused} — stop / start reading. */
tg.post('/admin/tg-sources/:handle/pause', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '';
  const b = await c.req.json().catch(() => ({})) as { paused?: boolean };
  const { rowCount } = await pool.query('UPDATE tg_channels SET paused = $2, auto_paused = NULL WHERE handle = $1', [handle, !!b.paused]);
  if (!rowCount) return c.json({ error: 'Канал не знайдено' }, 404);
  audit(actor, 'POST', `/admin/tg-sources/${handle}/pause`, { paused: !!b.paused });
  // started again: read it now, not at the next 10-minute pass (the card shows the progress)
  if (!b.paused) void collectChannel(handle).then(() => settleTgTips()).catch((e) => console.warn(`[tg] ${handle}:`, (e as Error).message));
  return c.json({ ok: true });
});

/** POST /api/admin/tg-sources/:handle/refresh — read the channel now (or all of them with handle «all»). */
tg.post('/admin/tg-sources/:handle/refresh', requireAuth, requireAdmin, async (c) => {
  const handle = c.req.param('handle') || '';
  if (handle === 'all') { void tgCycle().catch(() => {}); return c.json({ ok: true, started: true }); }
  // reading screenshots takes seconds a post: the pass runs on, the admin reloads the list
  void collectChannel(handle).then(() => settleTgTips()).catch((e) => console.warn(`[tg] ${handle}:`, (e as Error).message));
  return c.json({ ok: true, started: true });
});

/** POST /api/admin/tg-sources/:handle/reread — read the channel's saved posts again (after GEMINI_API_KEY is added, say); manual fixes stay. */
tg.post('/admin/tg-sources/:handle/reread', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '';
  // only the posts still on the channel's page can be read again (t.me/s shows the last ~20)
  const page = await fetchChannelPage(handle).catch(() => null);
  const ids = (page?.posts || []).map((p) => p.id);
  const { rowCount } = await pool.query('UPDATE tg_posts SET photos = NULL WHERE handle = $1 AND fixed_by IS NULL AND post_id = ANY($2::int[])', [handle, ids]);
  audit(actor, 'tg_channel_reread', handle, { posts: rowCount });
  void rereadChannel(handle, rowCount || 0).catch((e) => console.warn(`[tg] reread ${handle}:`, (e as Error).message));
  return c.json({ ok: true, posts: rowCount || 0 });
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

/** POST /api/admin/tg-posts/:handle/:postId/resolve {who: 'channel' | 'ours'} — a mismatch closed by the admin. */
tg.post('/admin/tg-posts/:handle/:postId/resolve', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '', postId = Number(c.req.param('postId'));
  const b = await c.req.json().catch(() => ({})) as { who?: string };
  const who = b.who === 'channel' ? 'channel' : 'ours';
  const { rowCount } = await pool.query(
    `UPDATE tg_posts SET result = CASE WHEN $3 = 'ours' THEN our_result ELSE result END, our_result = CASE WHEN $3 = 'channel' THEN result ELSE our_result END,
       mismatch = false, settled_by = 'admin', fixed_by = $4 WHERE handle = $1 AND post_id = $2 AND kind = 'bet'`, [handle, postId, who, actor.username]);
  audit(actor, 'POST', `/admin/tg-posts/${handle}/${postId}/resolve`, { who });
  return rowCount ? c.json({ ok: true }) : c.json({ error: 'Пост не знайдено' }, 404);
});

/** POST /api/admin/tg-sources/:handle/archive {pages} — older posts (before the oldest we have), read in the background. */
tg.post('/admin/tg-sources/:handle/archive', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user'), handle = c.req.param('handle') || '';
  const b = await c.req.json().catch(() => ({})) as { pages?: number };
  const pages = Math.min(10, Math.max(1, Math.round(Number(b.pages) || 5)));
  audit(actor, 'POST', `/admin/tg-sources/${handle}/archive`, { pages });
  void collectArchive(handle, pages).catch((e) => console.warn(`[tg] archive ${handle}:`, (e as Error).message));
  return c.json({ ok: true, started: true, pages });
});

/** GET /api/admin/tg-sources/:handle/stats — profit by day (the channel's results and ours), by game / market, streaks, the channel's own summaries. */
tg.get('/admin/tg-sources/:handle/stats', requireAuth, requireAdmin, async (c) => {
  const handle = c.req.param('handle') || '';
  const { rows } = await pool.query<{ day: string; game: string | null; market: string; odds: number | null; result: string | null; our_result: string | null }>(
    `SELECT to_char(posted_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, game, market, odds::float AS odds, result, our_result FROM tg_posts
      WHERE handle = $1 AND kind = 'bet' ORDER BY posted_at`, [handle]);
  const unit = (r: string | null, o: number | null) => (!o ? 0 : r === 'Win' ? (o - 1) * 100 : r === 'Loss' ? -100 : 0);
  // profit by day, cumulative
  const byDay = new Map<string, { claimed: number; ours: number }>();
  for (const r of rows) { const d = byDay.get(r.day) || { claimed: 0, ours: 0 }; d.claimed += unit(r.result, r.odds); d.ours += unit(r.our_result ?? r.result, r.odds); byDay.set(r.day, d); }
  let ca = 0, oa = 0;
  const chart = [...byDay.entries()].sort().map(([day, v]) => ({ day, claimed: Math.round((ca += v.claimed)), ours: Math.round((oa += v.ours)) }));
  // by game and by market
  const kindOf = (m: string) => /^Map \d (Total|Handicap)/.test(m) ? 'Карта: тотал/фора' : /^Map \d Winner/.test(m) ? 'Карта' : /^Total/.test(m) ? 'Тотал' : /^Handicap/.test(m) ? 'Фора' : m === 'Express' ? 'Експрес' : 'Матч';
  const group = (key: (r: typeof rows[number]) => string) => {
    const g = new Map<string, { won: number; lost: number; profit: number; priced: number }>();
    for (const r of rows) { const res = r.our_result ?? r.result; if (res !== 'Win' && res !== 'Loss') continue; const x = g.get(key(r)) || { won: 0, lost: 0, profit: 0, priced: 0 }; if (res === 'Win') x.won++; else x.lost++; if (r.odds) { x.profit += unit(res, r.odds); x.priced++; } g.set(key(r), x); }
    return [...g.entries()].map(([name, x]) => ({ name, won: x.won, lost: x.lost, winrate: Math.round((x.won / (x.won + x.lost)) * 100), roi: x.priced ? Math.round(x.profit / x.priced) : null })).sort((a, b) => b.won + b.lost - (a.won + a.lost));
  };
  // streaks
  let best = 0, worst = 0, cur = 0;
  for (const r of rows) { const res = r.our_result ?? r.result; if (res === 'Win') cur = cur > 0 ? cur + 1 : 1; else if (res === 'Loss') cur = cur < 0 ? cur - 1 : -1; else continue; best = Math.max(best, cur); worst = Math.min(worst, cur); }
  // the channel's own summaries next to our results of the same period (the day before the summary)
  const claims = (await pool.query<{ posted_at: string; claim: { won?: number; total?: number; period?: string }; text: string }>(
    `SELECT posted_at, claim, text FROM tg_posts WHERE handle = $1 AND claim IS NOT NULL ORDER BY posted_at DESC LIMIT 10`, [handle])).rows;
  const summaries = [];
  for (const cl of claims) {
    const day = new Date(Date.parse(cl.posted_at) - 86_400_000 + 2 * 3_600_000).toISOString().slice(0, 10);
    const ours = rows.filter((r) => r.day === day || r.day === cl.posted_at.slice(0, 10)).map((r) => r.our_result ?? r.result).filter((x) => x === 'Win' || x === 'Loss');
    summaries.push({ at: cl.posted_at, period: cl.claim.period || null, claimed: { won: cl.claim.won ?? null, total: cl.claim.total ?? null }, ours: { won: ours.filter((x) => x === 'Win').length, total: ours.length } });
  }
  return c.json({ chart, byGame: group((r) => (r.game === 'dota2' ? 'Dota 2' : 'CS2')), byMarket: group((r) => kindOf(r.market)), streaks: { best, worst, current: cur }, summaries });
});

export default tg;
