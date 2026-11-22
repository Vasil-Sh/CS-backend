// ═══════════════════════════════════════════════════════════════
// Where matches come from.
//
// New feed (ODDSPAPI_KEY set, or MATCH_SOURCE=liquipedia) — tips.gg blocks us:
//   • Liquipedia  — schedule, series score, live / finished, BO   (every 5 min)
//   • OddsPapi    — bookmaker odds, added to the same match       (every 12 h)
//   • OpenDota    — fresher Dota 2 score between Liquipedia refreshes
//   If Liquipedia gives nothing, OddsPapi's own schedule is used instead.
// Old feed (neither set): everything through tips.gg, as before.
// The returned shape is the same either way, so callers don't change.
// ═══════════════════════════════════════════════════════════════

import * as tipsgg from './tipsggScraper';
import type { TipsGgMatch } from './tipsggScraper';
import { cachedMatches, fetchOddsPapiMatches, oddspapiEnabled, refreshOddsPapi } from './oddspapiFeed';
import { applySeries, recentDotaSeries } from './opendotaScores';
import { fetchLiquipediaMatches } from './liquipediaFeed';
import { normalizeTeam } from '../utils/matchUtils';

export const usingNewFeed = () => oddspapiEnabled() || (process.env.MATCH_SOURCE || '').trim().toLowerCase() === 'liquipedia';

/** Put OddsPapi odds (and tournament name if missing) onto Liquipedia matches: same teams, start within 6 h. */
export function addOdds(base: TipsGgMatch[], odds: TipsGgMatch[]): number {
  let n = 0;
  for (const m of base) {
    const a = normalizeTeam(m.nameTeam1), b = normalizeTeam(m.nameTeam2), t = Date.parse(m.startDate);
    const o = odds.find((x) => {
      const x1 = normalizeTeam(x.nameTeam1), x2 = normalizeTeam(x.nameTeam2);
      return ((x1 === a && x2 === b) || (x1 === b && x2 === a)) && Math.abs(Date.parse(x.startDate) - t) < 6 * 3_600_000;
    });
    if (!o) continue;
    if (o.coeff1 != null && o.coeff2 != null) {
      const swapped = normalizeTeam(o.nameTeam1) !== a;
      m.coeff1 = swapped ? o.coeff2 : o.coeff1;
      m.coeff2 = swapped ? o.coeff1 : o.coeff2;
      m.performer = m.coeff1! < m.coeff2! ? m.nameTeam1 : m.nameTeam2;
      n++;
    }
    if (!m.tournament && o.tournament) m.tournament = o.tournament;
  }
  return n;
}

async function withDotaScores(list: TipsGgMatch[]): Promise<TipsGgMatch[]> {
  // only ask OpenDota while some unfinished match is within its window (started up to 8 h ago or starts within 30 min)
  const now = Date.now();
  const around = list.filter((m) => { const t = Date.parse(m.startDate); return m.status !== 'finished' && t < now + 30 * 60_000 && t > now - 8 * 3_600_000; });
  if (!around.length) return list;
  applySeries(around, await recentDotaSeries());
  return list;
}

/** Liquipedia schedule + OddsPapi odds (OddsPapi spends a request only when its 12-h / daily schedule is due). */
async function newFeed(game: 'cs2' | 'dota2', spendOddsPapi: boolean): Promise<TipsGgMatch[]> {
  const odds = !oddspapiEnabled() ? [] : spendOddsPapi ? await fetchOddsPapiMatches(game) : cachedMatches(game);
  const lp = await fetchLiquipediaMatches(game);
  const list = lp.length ? lp : odds; // Liquipedia down → OddsPapi's own schedule
  if (lp.length && odds.length) addOdds(list, odds);
  return game === 'dota2' ? withDotaScores(list) : list;
}

export async function fetchDota2Matches(): Promise<TipsGgMatch[]> {
  return usingNewFeed() ? newFeed('dota2', true) : tipsgg.fetchDota2Matches();
}

export async function fetchCs2Matches(): Promise<TipsGgMatch[]> {
  return usingNewFeed() ? newFeed('cs2', true) : tipsgg.fetchCs2Matches();
}

/** The 2-minute incremental refresh: today's and yesterday's matches. Never spends a billable OddsPapi request directly. */
export async function fetchTodayMatches(game: 'dota2' | 'cs2'): Promise<TipsGgMatch[] | null> {
  if (!usingNewFeed()) return tipsgg.fetchTodayMatches(game);
  if (oddspapiEnabled()) void refreshOddsPapi().catch(() => {}); // no-op unless its schedule is due
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return (await newFeed(game, false)).filter((m) => m.date === today || m.date === yesterday);
}

/** Feed loops pause while tips.gg has banned us — not when the new feed is the source. */
export function feedPaused(): boolean {
  return usingNewFeed() ? false : tipsgg.isBanned();
}
