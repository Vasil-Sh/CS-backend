// ═══════════════════════════════════════════════════════════════
// OpenDota — series scores and live state for Dota 2 pro matches.
// Free, no key: ~60 requests / minute, 2,000 / day. We call /proMatches and
// /live at most once every 3 minutes (≤ 960 / day), only while a match
// from the schedule is around its start time.
// ═══════════════════════════════════════════════════════════════

import { normalizeTeam } from '../utils/matchUtils';
import { recordFailure, recordSuccess, isOpen } from './circuitBreaker';
import type { TipsGgMatch } from './matchTypes';

export const OPENDOTA_PARSER = 'opendota';
const BASE = 'https://api.opendota.com/api';
const MIN_GAP_MS = 3 * 60 * 1000;

export interface ProGame {
  match_id: number;
  start_time: number; // unix seconds
  duration?: number;
  radiant_name?: string | null;
  dire_name?: string | null;
  series_id?: number | null;
  series_type?: number | null; // 0 = BO1, 1 = BO3, 2 = BO5, 3 = BO2
  radiant_win?: boolean | null;
  league_name?: string | null;
}
export interface LiveGame { team_name_radiant?: string | null; team_name_dire?: string | null; league_id?: number }

export interface SeriesScore { team1: string; team2: string; score1: number; score2: number; type: string; finished: boolean; live: boolean; start: number }

const TYPE: Record<number, { label: string; games: number }> = { 0: { label: 'BO1', games: 1 }, 1: { label: 'BO3', games: 3 }, 2: { label: 'BO5', games: 5 }, 3: { label: 'BO2', games: 2 } };

async function get<T>(path: string): Promise<T | null> {
  if (isOpen(OPENDOTA_PARSER)) return null;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'MatchIQ (contact: admin)' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { console.warn(`[opendota] ${path} → HTTP ${res.status}`); recordFailure(OPENDOTA_PARSER); return null; }
    const json = (await res.json()) as T;
    recordSuccess(OPENDOTA_PARSER);
    return json;
  } catch (e) {
    console.warn(`[opendota] ${path} failed:`, (e as Error).message);
    recordFailure(OPENDOTA_PARSER);
    return null;
  }
}

/** Group single games into series and count wins per team (team1 = radiant side of the first game). */
export function buildSeries(games: ProGame[], live: LiveGame[]): SeriesScore[] {
  const bySeries = new Map<string, ProGame[]>();
  for (const g of games) {
    if (!g.radiant_name || !g.dire_name) continue;
    const key = g.series_id ? `s${g.series_id}` : `m${g.match_id}`;
    (bySeries.get(key) || bySeries.set(key, []).get(key)!).push(g);
  }
  const liveTeams = new Set(live.flatMap((l) => [l.team_name_radiant, l.team_name_dire]).filter(Boolean).map((n) => normalizeTeam(n!)));
  const out: SeriesScore[] = [];
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.start_time - b.start_time);
    const first = list[0];
    const t1 = first.radiant_name!, t2 = first.dire_name!;
    const n1 = normalizeTeam(t1);
    let s1 = 0, s2 = 0;
    for (const g of list) {
      if (g.radiant_win == null) continue;
      const winner = g.radiant_win ? g.radiant_name! : g.dire_name!;
      if (normalizeTeam(winner) === n1) s1++; else s2++;
    }
    const type = TYPE[first.series_type ?? 0] || TYPE[0];
    // BO2 ends after both games (1:1 is a result); otherwise first to a majority wins
    const finishedBySeries = type.games === 2 ? s1 + s2 >= 2 : Math.max(s1, s2) >= Math.floor(type.games / 2) + 1;
    const isLive = !finishedBySeries && (liveTeams.has(n1) || liveTeams.has(normalizeTeam(t2)));
    out.push({ team1: t1, team2: t2, score1: s1, score2: s2, type: type.label, finished: finishedBySeries, live: isLive, start: first.start_time * 1000 });
  }
  return out;
}

let last = 0;
let lastSeries: SeriesScore[] = [];

/** Recent Dota 2 pro series with scores (cached for 3 minutes). */
export async function recentDotaSeries(): Promise<SeriesScore[]> {
  if (Date.now() - last < MIN_GAP_MS) return lastSeries;
  last = Date.now();
  const [games, live] = await Promise.all([get<ProGame[]>('/proMatches'), get<LiveGame[]>('/live')]);
  if (!games) return lastSeries;
  lastSeries = buildSeries(games, Array.isArray(live) ? live : []);
  return lastSeries;
}

/** Put series scores / status / BO onto scheduled matches (same teams, started within 12 h of the schedule). */
export function applySeries(matches: TipsGgMatch[], series: SeriesScore[]): number {
  let changed = 0;
  for (const m of matches) {
    const a = normalizeTeam(m.nameTeam1), b = normalizeTeam(m.nameTeam2);
    const at = Date.parse(m.startDate);
    const hit = series.find((s) => {
      const x = normalizeTeam(s.team1), y = normalizeTeam(s.team2);
      return ((x === a && y === b) || (x === b && y === a)) && Math.abs(s.start - at) < 12 * 3600 * 1000;
    });
    if (!hit) continue;
    const flipped = normalizeTeam(hit.team1) !== a;
    const s1 = flipped ? hit.score2 : hit.score1, s2 = flipped ? hit.score1 : hit.score2;
    const status: TipsGgMatch['status'] = hit.finished ? 'finished' : hit.live || s1 + s2 > 0 ? 'live' : m.status;
    if (m.score1 !== s1 || m.score2 !== s2 || m.status !== status || m.type !== hit.type) {
      m.score1 = s1; m.score2 = s2; m.status = status; m.type = hit.type;
      changed++;
    }
  }
  return changed;
}
