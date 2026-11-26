/**
 * Our own check of the tips read from Telegram channels: the match is found in our feed / history, the result comes
 * from our scores (series, maps, express legs) — not from the channel's screenshot. Where both exist and differ: a mismatch.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pool } from '../db/client';
import { resultFor } from './betHints';
import { normalizeTeam } from '../utils/matchUtils';
import { shortFor } from '../utils/teamAbbrev';

type Res = 'Win' | 'Loss';
export interface FeedMatch { id: string; game: 'cs2' | 'dota2'; team1: string; team2: string; start: string; status: string; score1: number | null; score2: number | null; maps?: { score1: number | null; score2: number | null }[] }

/** Today's / tomorrow's / live matches of our feed (the caches the matches screen reads). */
export function feedMatches(): FeedMatch[] {
  const out: FeedMatch[] = [];
  for (const game of ['cs2', 'dota2'] as const) {
    const f = join(process.cwd(), '.cache', `${game}_matches.json`);
    try {
      if (!existsSync(f)) continue;
      const data = JSON.parse(readFileSync(f, 'utf8')).data as { id: string; nameTeam1: string; nameTeam2: string; startDate?: string | null; date: string; status?: string; score1?: number | null; score2?: number | null; maps?: FeedMatch['maps'] }[];
      for (const m of data || []) if (m?.id && m.nameTeam1 && m.nameTeam2) out.push({ id: String(m.id), game, team1: m.nameTeam1, team2: m.nameTeam2, start: m.startDate || `${m.date}T12:00:00Z`, status: m.status || 'upcoming', score1: m.score1 ?? null, score2: m.score2 ?? null, maps: m.maps });
    } catch { /* skipped */ }
  }
  return out;
}

/** Same team in two sources / in a post: one key, or one name short for the other («NAVI» / «Natus Vincere»). */
export function sameName(a: string, b: string): boolean {
  const x = normalizeTeam(a), y = normalizeTeam(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) || shortFor(a, b) || shortFor(b, a);
}
const pairOf = (t1: string, t2: string, m1: string, m2: string): 0 | 1 | -1 => (sameName(t1, m1) && sameName(t2, m2) ? 1 : sameName(t1, m2) && sameName(t2, m1) ? -1 : 0);

// ── map winners ──
const keyOf = (game: string, date: string, a: string, b: string) => `${game}|${date}|${[normalizeTeam(a), normalizeTeam(b)].join('|')}`;
/** Who won each map (1 = team1, 2 = team2) — from PandaScore games or Liquipedia map scores. */
export async function recordMaps(game: string, date: string, team1: string, team2: string, winners: (1 | 2)[], source: string): Promise<void> {
  if (!winners.length || !team1 || !team2) return;
  await pool.query(
    `INSERT INTO match_maps(key, game, date, team1, team2, winners, source) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO UPDATE SET winners = CASE WHEN jsonb_array_length(EXCLUDED.winners) >= jsonb_array_length(match_maps.winners) THEN EXCLUDED.winners ELSE match_maps.winners END, updated_at = now()`,
    [keyOf(game, date, team1, team2), game, date, team1, team2, JSON.stringify(winners), source]).catch(() => {});
}
/** Map scores as winners: a map counts once one side has won it (13+ with a 2-round lead, or any map before the last one). */
export function winnersFromScores(maps: { score1: number | null; score2: number | null }[], finished: boolean): (1 | 2)[] {
  const out: (1 | 2)[] = [];
  maps.forEach((m, i) => {
    if (m.score1 == null || m.score2 == null || m.score1 === m.score2) return;
    const last = i === maps.length - 1, hi = Math.max(m.score1, m.score2), lead = Math.abs(m.score1 - m.score2);
    if (!last || finished || (hi >= 13 && lead >= 2)) out.push(m.score1 > m.score2 ? 1 : 2);
  });
  return out;
}
/** Winner of map n of the match (as team1 = 1 of the tip's order), or null. A clean sweep (2:0, 3:0) tells every map. */
async function mapWinner(game: string, day: string, t1: string, t2: string, n: number, series: { s1: number; s2: number } | null): Promise<1 | 2 | null> {
  const rows = (await pool.query<{ team1: string; team2: string; winners: (1 | 2)[] }>(
    `SELECT team1, team2, winners FROM match_maps WHERE date BETWEEN $1::date - 1 AND $1::date + 3`, [day]).catch(() => ({ rows: [] as { team1: string; team2: string; winners: (1 | 2)[] }[] }))).rows;
  for (const r of rows) {
    const o = pairOf(t1, t2, r.team1, r.team2);
    if (!o || !r.winners[n - 1]) continue;
    const w = r.winners[n - 1];
    return o === 1 ? w : w === 1 ? 2 : 1;
  }
  // the map scores our feed holds for the match (Liquipedia's match page)
  for (const m of feedMatches()) {
    if (!m.maps?.length) continue;
    const o = pairOf(t1, t2, m.team1, m.team2);
    if (!o) continue;
    const w = winnersFromScores(m.maps, m.status === 'finished')[n - 1];
    if (w) return o === 1 ? w : w === 1 ? 2 : 1;
  }
  if (series && (series.s1 === 0 || series.s2 === 0) && Math.max(series.s1, series.s2) >= n) return series.s1 > series.s2 ? 1 : 2;
  return null;
}

// ── the finished match of a tip ──
interface Hist { match_id: string; team1: string; team2: string; score1: number | null; score2: number | null; date: string }
async function findFinished(matchId: string | null, team1: string, team2: string, day: string): Promise<{ h: Hist; flip: boolean } | null> {
  if (matchId && !matchId.startsWith('tg:')) {
    const r = (await pool.query<Hist>(`SELECT match_id, team1, team2, score1, score2, to_char(date, 'YYYY-MM-DD') AS date FROM matches_history WHERE match_id = $1 AND status = 'finished'`, [matchId])).rows[0];
    if (r) return { h: r, flip: pairOf(team1, team2, r.team1, r.team2) === -1 };
  }
  const rows = (await pool.query<Hist>(`SELECT match_id, team1, team2, score1, score2, to_char(date, 'YYYY-MM-DD') AS date FROM matches_history WHERE status = 'finished' AND date BETWEEN $1::date - 1 AND $1::date + 3 ORDER BY date`, [day])).rows;
  for (const r of rows) { const o = pairOf(team1, team2, r.team1, r.team2); if (o) return { h: r, flip: o === -1 }; }
  return null;
}

export interface Leg { team1: string; team2: string; market: string; pick: string | null; odds: number | null; matchId?: string | null; result?: Res | null }
/** Our result of one bet (a single or an express leg): null while the match is not over or the market can't be told. */
async function betResult(game: string, day: string, b: { matchId: string | null; team1: string; team2: string; market: string; pick: string | null }): Promise<{ res: Res; score: string; matchId: string } | null> {
  const f = await findFinished(b.matchId, b.team1, b.team2, day);
  if (!f || !(f.h.score1 || f.h.score2)) return null;
  const s1 = f.flip ? f.h.score2! : f.h.score1!, s2 = f.flip ? f.h.score1! : f.h.score2!;
  const mm = /^Map (\d) Winner$/.exec(b.market);
  let res: Res | null;
  if (mm) {
    const w = await mapWinner(game, f.h.date, b.team1, b.team2, Number(mm[1]), { s1, s2 });
    res = w == null || !b.pick ? null : (w === 1 ? sameName(b.pick, b.team1) : sameName(b.pick, b.team2)) ? 'Win' : 'Loss';
  } else {
    res = resultFor({ id: '', team1: b.team1, team2: b.team2, selection: b.pick, betType: b.market, game, date: f.h.date }, { team1: b.team1, team2: b.team2, score1: s1, score2: s2, date: f.h.date, game });
  }
  return res ? { res, score: `${s1}:${s2}`, matchId: f.h.match_id } : null;
}

/** One tip posted twice (a share card and the bookmaker's slip, a repost): the same team at the same odds within two days.
 *  The later post becomes «Результат» (its slip shows the result) or «Повтор»; a result it shows goes to the first one. */
export async function dedupeTips(): Promise<number> {
  const { rows } = await pool.query<{ handle: string; post_id: number; posted_at: string; pick: string | null; odds: string | null; slip: string | null; result: string | null; stake: string | null; currency: string | null; payout: string | null; team1: string | null; team2: string | null; match_id: string | null }>(
    `SELECT handle, post_id, posted_at, pick, odds, slip, result, stake, currency, payout, team1, team2, match_id FROM tg_posts
      WHERE kind = 'bet' AND fixed_by IS NULL AND pick IS NOT NULL AND pick <> '' AND odds IS NOT NULL AND posted_at > now() - interval '120 days' ORDER BY handle, post_id`);
  let n = 0;
  const kept: typeof rows = [];
  for (const r of rows) {
    const first = kept.find((k) => k.handle === r.handle && Math.abs(Number(k.odds) - Number(r.odds)) < 0.015 && sameName(k.pick!, r.pick!)
      && Date.parse(r.posted_at) - Date.parse(k.posted_at) < 2 * 86_400_000
      // and the same match, when both slips name it (two different matches of one team at the same odds are two tips)
      && (k.match_id === r.match_id || !k.team1 || !k.team2 || !r.team1 || !r.team2 || pairOf(k.team1, k.team2, r.team1, r.team2) !== 0));
    if (!first) { kept.push(r); continue; }
    const final = r.slip === 'won' || r.slip === 'lost' || r.slip === 'cashout' || r.slip === 'void';
    await pool.query(`UPDATE tg_posts SET kind = 'other', reason = $3 WHERE handle = $1 AND post_id = $2`, [r.handle, r.post_id, final ? 'Результат' : 'Повтор']);
    if (final && !first.result) {
      const res = r.slip === 'won' ? 'Win' : r.slip === 'lost' ? 'Loss' : 'Void';
      await pool.query(`UPDATE tg_posts SET result = $3, settled_by = 'slip', stake = COALESCE(stake, $4), currency = COALESCE(currency, $5), payout = COALESCE(payout, $6) WHERE handle = $1 AND post_id = $2`,
        [first.handle, first.post_id, res, r.stake, r.currency, r.payout]);
      first.result = res;
    }
    n++;
  }
  return n;
}

/** Every tip not checked yet: our result, the score; the channel's result where it gave none; a mismatch where it differs. */
export async function verifyTips(): Promise<number> {
  await dedupeTips().catch((e) => console.warn('[tg] dedupe:', (e as Error).message));
  const { rows } = await pool.query<{ handle: string; post_id: number; match_id: string | null; market: string; pick: string | null; team1: string; team2: string; game: string | null; day: string; result: string | null; legs: Leg[] | null }>(
    `SELECT handle, post_id, match_id, market, pick, team1, team2, game, to_char(posted_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, result, legs FROM tg_posts
      WHERE kind = 'bet' AND our_result IS NULL AND posted_at > now() - interval '120 days' AND (team1 IS NOT NULL OR legs IS NOT NULL) ORDER BY posted_at LIMIT 400`);
  let n = 0;
  for (const r of rows) {
    const game = r.game === 'dota2' ? 'dota2' : 'cs2';
    let ours: Res | null = null, score: string | null = null, realId: string | null = null;
    if (r.market === 'Express' && r.legs?.length) {
      const legs = [...r.legs];
      for (const l of legs) if (!l.result) { const x = await betResult(game, r.day, { matchId: l.matchId ?? null, team1: l.team1, team2: l.team2, market: l.market, pick: l.pick }); if (x) l.result = x.res; }
      ours = legs.some((l) => l.result === 'Loss') ? 'Loss' : legs.every((l) => l.result === 'Win') ? 'Win' : null;
      await pool.query('UPDATE tg_posts SET legs = $3 WHERE handle = $1 AND post_id = $2', [r.handle, r.post_id, JSON.stringify(legs)]);
    } else if (r.team1 && r.team2) {
      const x = await betResult(game, r.day, { matchId: r.match_id, team1: r.team1, team2: r.team2, market: r.market, pick: r.pick });
      if (x) { ours = x.res; score = x.score; realId = x.matchId; }
    }
    if (!ours) continue;
    const mismatch = (r.result === 'Win' || r.result === 'Loss') && r.result !== ours;
    await pool.query(
      `UPDATE tg_posts SET our_result = $3, score = COALESCE($4, score), mismatch = $5,
          result = CASE WHEN result IS NULL AND fixed_by IS NULL THEN $3 ELSE result END,
          settled_by = CASE WHEN result IS NULL THEN 'ours' ELSE COALESCE(settled_by, 'slip') END,
          match_id = CASE WHEN match_id LIKE 'tg:%' AND $6::text IS NOT NULL THEN $6 ELSE match_id END
        WHERE handle = $1 AND post_id = $2`,
      [r.handle, r.post_id, ours, score, mismatch, realId]);
    n++;
  }
  return n;
}

/** A tip placed after its match started (only known for matches of our feed). */
export function placedLive(matchId: string | null | undefined, postedAt: string, feed: FeedMatch[]): boolean {
  const m = matchId ? feed.find((x) => x.id === matchId) : undefined;
  return !!m && Date.parse(postedAt) > Date.parse(m.start) + 5 * 60_000;
}
