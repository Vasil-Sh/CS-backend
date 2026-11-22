// ═══════════════════════════════════════════════════════════════
// Where matches come from. With ODDSPAPI_KEY set, the schedule and odds come
// from OddsPapi and Dota 2 scores from OpenDota (tips.gg blocked us);
// without it, everything works as before through tips.gg.
// The returned shape is the same either way, so callers don't change.
// ═══════════════════════════════════════════════════════════════

import * as tipsgg from './tipsggScraper';
import type { TipsGgMatch } from './tipsggScraper';
import { cachedMatches, fetchOddsPapiMatches, oddspapiEnabled, refreshOddsPapi } from './oddspapiFeed';
import { applySeries, recentDotaSeries } from './opendotaScores';

export const usingOddsPapi = oddspapiEnabled;

async function withDotaScores(list: TipsGgMatch[]): Promise<TipsGgMatch[]> {
  // only ask OpenDota while some match is within its window (started up to 8 h ago or starts within 30 min)
  const now = Date.now();
  const around = list.some((m) => { const t = Date.parse(m.startDate); return t < now + 30 * 60_000 && t > now - 8 * 3_600_000; });
  if (!around) return list;
  applySeries(list, await recentDotaSeries());
  return list;
}

export async function fetchDota2Matches(): Promise<TipsGgMatch[]> {
  if (!usingOddsPapi()) return tipsgg.fetchDota2Matches();
  return withDotaScores(await fetchOddsPapiMatches('dota2'));
}

export async function fetchCs2Matches(): Promise<TipsGgMatch[]> {
  if (!usingOddsPapi()) return tipsgg.fetchCs2Matches();
  return fetchOddsPapiMatches('cs2');
}

/**
 * The 2-minute incremental refresh. With OddsPapi it never spends a billable request
 * (only the 6-hourly schedule does, via refreshOddsPapi) — it returns today's cached
 * matches, with Dota 2 scores from OpenDota.
 */
export async function fetchTodayMatches(game: 'dota2' | 'cs2'): Promise<TipsGgMatch[] | null> {
  if (!usingOddsPapi()) return tipsgg.fetchTodayMatches(game);
  void refreshOddsPapi().catch(() => {}); // no-op unless the schedule is due
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const list = cachedMatches(game).filter((m) => m.date === today || m.date === yesterday);
  return game === 'dota2' ? withDotaScores(list) : list;
}

/** Feed loops pause while tips.gg has banned us — not when OddsPapi is the source. */
export function feedPaused(): boolean {
  return usingOddsPapi() ? false : tipsgg.isBanned();
}
