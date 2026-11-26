/**
 * For the app's users: Telegram channels we checked ourselves (honest results, a positive ROI by our scores) and what they pick on a match.
 * Test channels and blocked ones never show. The app screens that use these are not built yet.
 */
import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/client';

const pub = new Hono();
const VERIFIED = `
  SELECT c.handle, c.title, c.subscribers,
         count(*) FILTER (WHERE p.kind = 'bet' AND COALESCE(p.our_result, p.result) IN ('Win', 'Loss')) AS settled,
         count(*) FILTER (WHERE p.kind = 'bet' AND COALESCE(p.our_result, p.result) = 'Win') AS won,
         count(*) FILTER (WHERE p.kind = 'bet' AND p.settled_by = 'slip' AND p.our_result IS NOT NULL AND NOT p.mismatch) AS confirmed,
         count(*) FILTER (WHERE p.kind = 'bet' AND p.mismatch) AS mismatches,
         sum(CASE WHEN p.kind = 'bet' AND p.odds IS NOT NULL THEN CASE COALESCE(p.our_result, p.result) WHEN 'Win' THEN (p.odds - 1) * 100 WHEN 'Loss' THEN -100 END END) AS profit,
         count(*) FILTER (WHERE p.kind = 'bet' AND p.odds IS NOT NULL AND COALESCE(p.our_result, p.result) IN ('Win', 'Loss')) AS priced
    FROM tg_channels c JOIN tg_posts p ON p.handle = c.handle
   WHERE NOT c.is_test AND c.private_id IS NULL AND NOT EXISTS (SELECT 1 FROM telegram_groups g WHERE g.moderation_status = 'rejected' AND lower(g.link) LIKE '%' || c.handle || '%')
   GROUP BY c.handle, c.title, c.subscribers`;
type Row = { handle: string; title: string | null; subscribers: number | null; settled: string; won: string; confirmed: string; mismatches: string; profit: string | null; priced: string };
const verified = (rows: Row[]) => rows.map((r) => {
  const n = (x: string | null) => Number(x || 0), honest = n(r.confirmed) + n(r.mismatches);
  return { handle: r.handle, title: r.title, subscribers: r.subscribers, settled: n(r.settled), winrate: n(r.settled) ? Math.round((n(r.won) / n(r.settled)) * 100) : null,
    roi: n(r.priced) ? Math.round(n(r.profit) / n(r.priced)) : null, honesty: honest ? Math.round((n(r.confirmed) / honest) * 100) : null };
}).filter((c) => c.settled >= 10 && (c.honesty == null || c.honesty >= 90) && (c.roi ?? 0) > 0).sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0));

/** GET /api/tg/verified-channels — channels with ≥ 10 settled tips, honesty ≥ 90 % and a positive ROI by our check. */
pub.get('/tg/verified-channels', requireAuth, async (c) => {
  const { rows } = await pool.query<Row>(VERIFIED);
  return c.json({ channels: verified(rows) });
});

/** GET /api/tg/matches/:matchId/picks — what the verified channels pick on this match (series winner tips). */
pub.get('/tg/matches/:matchId/picks', requireAuth, async (c) => {
  const ok = new Set(verified((await pool.query<Row>(VERIFIED)).rows).map((x) => x.handle));
  const { rows } = await pool.query<{ handle: string; pick: string; market: string; odds: number | null; posted_at: string }>(
    `SELECT handle, pick, market, odds::float AS odds, posted_at FROM tg_posts WHERE kind = 'bet' AND match_id = $1 ORDER BY posted_at`, [c.req.param('matchId')]);
  const picks = rows.filter((r) => ok.has(r.handle));
  const sides = new Map<string, number>();
  for (const p of picks) if (p.market === 'Match Winner' && p.pick) sides.set(p.pick, (sides.get(p.pick) || 0) + 1);
  return c.json({ picks, bySide: Object.fromEntries(sides) });
});

export default pub;
