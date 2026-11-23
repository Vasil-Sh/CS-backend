// ═══════════════════════════════════════════════════════════════
// Where matches come from:
//   • Liquipedia  — schedule, series score, live / finished, BO   (every 5 min)
//   • OddsPapi    — bookmaker odds, added to the same match       (every 12 h; only with ODDSPAPI_KEY)
//   • OpenDota    — fresher Dota 2 score between Liquipedia refreshes
//   If Liquipedia gives nothing, OddsPapi's own schedule is used instead.
// (tips.gg, HLTV and the browser scraper were removed on 23.11.2026.)
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { cachedMatches, fetchOddsPapiMatches, oddspapiEnabled, refreshOddsPapi } from './oddspapiFeed';
import { applySeries, recentDotaSeries } from './opendotaScores';
import { fetchLiquipediaMatches } from './liquipediaFeed';
import { normalizeTeam } from '../utils/matchUtils';

/** Kept for callers: the Liquipedia feed is the only one now. */
export const usingNewFeed = () => true;

/** Same team under two sources' spellings: equal once «Team», «Esports», «Gaming», «Club», dots and case
 *  are dropped («Lynn Vision Gaming» / «Lynn Vision», «Team Spirit» / «Spirit»). No prefix guessing —
 *  «MOUZ» and «MOUZ NXT» are different teams. */
export function sameTeam(x: string, y: string): boolean {
  const n = (v: string) => normalizeTeam(v.replace(/\b(e-?sports?|club|clan)\b/gi, ' '));
  const a = n(x), b = n(y);
  return !!a && a === b;
}

/** Put OddsPapi odds (and tournament name if missing) onto Liquipedia matches: same teams, start within 6 h. */
export function addOdds(base: TipsGgMatch[], odds: TipsGgMatch[]): number {
  let n = 0;
  for (const m of base) {
    const t = Date.parse(m.startDate);
    let swapped = false;
    const o = odds.find((x) => {
      if (Math.abs(Date.parse(x.startDate) - t) >= 6 * 3_600_000) return false;
      if (sameTeam(m.nameTeam1, x.nameTeam1) && sameTeam(m.nameTeam2, x.nameTeam2)) { swapped = false; return true; }
      if (sameTeam(m.nameTeam1, x.nameTeam2) && sameTeam(m.nameTeam2, x.nameTeam1)) { swapped = true; return true; }
      return false;
    });
    if (!o) continue;
    if (o.coeff1 != null && o.coeff2 != null) {
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

/** How many of our matches got OddsPapi prices in the last feed build — for the admin «Парсери» card. */
const matched: Record<'cs2' | 'dota2', number> = { cs2: 0, dota2: 0 };
export const oddsMatched = () => ({ ...matched });

/** Liquipedia schedule + OddsPapi odds (OddsPapi spends a request only when its 12-h / daily schedule is due). */
async function newFeed(game: 'cs2' | 'dota2', spendOddsPapi: boolean): Promise<TipsGgMatch[]> {
  const odds = !oddspapiEnabled() ? [] : spendOddsPapi ? await fetchOddsPapiMatches(game) : cachedMatches(game);
  const lp = await fetchLiquipediaMatches(game);
  const list = lp.length ? lp : odds; // Liquipedia down → OddsPapi's own schedule
  if (lp.length && odds.length) matched[game] = addOdds(list, odds);
  else if (lp.length) matched[game] = 0;
  return game === 'dota2' ? withDotaScores(list) : list;
}

export async function fetchDota2Matches(): Promise<TipsGgMatch[]> {
  return newFeed('dota2', true);
}

export async function fetchCs2Matches(): Promise<TipsGgMatch[]> {
  return newFeed('cs2', true);
}

/** The 2-minute incremental refresh: today's and yesterday's matches. Never spends a billable OddsPapi request directly. */
export async function fetchTodayMatches(game: 'dota2' | 'cs2'): Promise<TipsGgMatch[] | null> {
  if (oddspapiEnabled()) void refreshOddsPapi().catch(() => {}); // no-op unless its schedule is due
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return (await newFeed(game, false)).filter((m) => m.date === today || m.date === yesterday);
}

/** Feed loops used to pause while tips.gg had banned us; nothing bans the new feed. */
export function feedPaused(): boolean {
  return false;
}
