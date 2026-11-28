// ═══════════════════════════════════════════════════════════════
// «Ринок Telegram»: the odds the Telegram channels give for a match's winner — read from their posts and slips.
// For each of our matches: the median price on each team, from tips posted before the start (live bets left out),
// and how many channels priced it. Next to the bookmakers' and Polymarket's prices; kept in the matches history.
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';

export interface TgPrice { side1: number[]; side2: number[]; channels: number }
const cache: { at: number; byMatch: Map<string, { picks: { pick: string; odds: number; handle: string }[]; team1: string; team2: string }> } = { at: 0, byMatch: new Map() };
const EVERY_MS = 5 * 60_000;

/** The channels' Match Winner tips of the last 14 days with odds, by match (read at most every 5 minutes). */
async function load(): Promise<void> {
  if (Date.now() - cache.at < EVERY_MS) return;
  cache.at = Date.now();
  const { rows } = await pool.query<{ match_id: string; team1: string; team2: string; pick: string; odds: number; handle: string }>(
    `SELECT match_id, team1, team2, pick, odds::float AS odds, handle FROM tg_posts
      WHERE kind = 'bet' AND market = 'Match Winner' AND match_id IS NOT NULL AND pick IS NOT NULL AND NOT is_live AND deleted_at IS NULL
        AND odds BETWEEN 1.01 AND 30 AND posted_at > now() - interval '14 days' ORDER BY posted_at`).catch(() => ({ rows: [] as never[] }));
  const by = new Map<string, { picks: { pick: string; odds: number; handle: string }[]; team1: string; team2: string }>();
  for (const r of rows) {
    const x = by.get(r.match_id) || { picks: [], team1: r.team1, team2: r.team2 };
    x.picks.push({ pick: r.pick, odds: r.odds, handle: r.handle });
    by.set(r.match_id, x);
  }
  cache.byMatch = by;
}

export const median = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
};

/** One match's tips → the median price on each of its teams (one price a channel: its latest), and the channels that priced it. */
export function tgPriceOf(m: { nameTeam1: string; nameTeam2: string }, picks: { pick: string; odds: number; handle: string }[], same: (a: string, b: string) => boolean): { c1: number | null; c2: number | null; channels: number } {
  const per = new Map<string, { side: 1 | 2; odds: number }>(); // a channel posting the same match twice counts once (its last tip)
  for (const p of picks) {
    const side = same(p.pick, m.nameTeam1) ? 1 : same(p.pick, m.nameTeam2) ? 2 : 0;
    if (side) per.set(`${p.handle}|${side}`, { side, odds: p.odds });
  }
  const v = [...per.values()];
  return { c1: median(v.filter((x) => x.side === 1).map((x) => x.odds)), c2: median(v.filter((x) => x.side === 2).map((x) => x.odds)), channels: new Set([...per.keys()].map((k) => k.split('|')[0])).size };
}

/** The channels' prices onto our matches; returns how many got one. */
export async function addTgMarket(list: TipsGgMatch[], same: (a: string, b: string) => boolean): Promise<number> {
  await load();
  let n = 0;
  for (const m of list) {
    const x = cache.byMatch.get(String(m.id));
    if (!x) continue;
    const p = tgPriceOf(m, x.picks, same);
    if (!p.channels) continue;
    m.tgCoeff1 = p.c1; m.tgCoeff2 = p.c2; m.tgChannels = p.channels;
    n++;
  }
  return n;
}
