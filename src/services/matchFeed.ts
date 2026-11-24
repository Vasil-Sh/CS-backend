// ═══════════════════════════════════════════════════════════════
// Where matches come from:
//   • Liquipedia  — schedule, series score, live / finished, BO   (every 5 min)
//   • OddsPapi    — bookmaker odds, added to the same match       (every 3–12 h by budget; only with ODDSPAPI_KEY)
//   • OpenDota    — fresher Dota 2 score between Liquipedia refreshes
//   • PandaScore  — second schedule for CS2 and Dota 2 (only with PANDASCORE_API_KEY)
//   • Cito        — second CS2 schedule: matches Liquipedia lacks are added, missing final scores filled (only with CITO_API_KEY)
//   If Liquipedia gives nothing, OddsPapi's own schedule is used instead.
// (tips.gg, HLTV and the browser scraper were removed on 23.11.2026.)
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { cachedMatches, fetchOddsPapiMatches, oddspapiEnabled, refreshOddsPapi, requestScores } from './oddspapiFeed';
import { applySeries, recentDotaSeries } from './opendotaScores';
import { liquipediaOkAt, fetchLiquipediaMatches } from './liquipediaFeed';
import { mergeSameTimeDuplicates, normalizeTeam } from '../utils/matchUtils';
import { citoEnabled, citoMatches, refreshCito } from './citoFeed';
import { isNight } from './nightMode';
import { pandascoreEnabled, pandascoreMatches, refreshPandaScore } from './pandascoreFeed';
import { pool } from '../db/client';

/** Kept for callers: the Liquipedia feed is the only one now. */
export const usingNewFeed = () => true;

/** Team key across sources: case, dots, «Team», «Esports», «Gaming», «Club» dropped
 *  («Lynn Vision Gaming» = «Lynn Vision», «Team Spirit» = «Spirit»). No prefix guessing — «MOUZ» ≠ «MOUZ NXT». */
export const teamKey = (v: string) => normalizeTeam(v.replace(/\b(e-?sports?|club|clan)\b/gi, ' '));
type Resolve = (name: string) => string;

export function sameTeam(x: string, y: string, resolve: Resolve = teamKey): boolean {
  const a = resolve(x), b = resolve(y);
  return !!a && a === b;
}

/** Team aliases from the admin («Це одна команда», «Зв’язати» on OddsPapi): alias → canonical, per game. Re-read every minute. */
let aliasCache: { at: number; map: Record<string, Map<string, string>> } | null = null;
export async function aliasResolver(game: 'cs2' | 'dota2'): Promise<Resolve> {
  if (!aliasCache || Date.now() - aliasCache.at > 60_000) {
    try {
      const { rows } = await pool.query<{ game: string; canonical: string; alias: string }>('SELECT game, canonical, alias FROM team_aliases');
      const map: Record<string, Map<string, string>> = {};
      for (const r of rows) (map[r.game] ||= new Map()).set(teamKey(r.alias), teamKey(r.canonical));
      aliasCache = { at: Date.now(), map };
    } catch {
      aliasCache = { at: Date.now(), map: aliasCache?.map || {} };
    }
  }
  const m = aliasCache.map[game];
  return (name: string) => { const k = teamKey(name); return m?.get(k) || k; };
}
export const forgetAliases = () => { aliasCache = null; };

/** An OddsPapi match with prices that found none of ours — shown in the admin to link the names. */
export interface OddsMiss {
  game: 'cs2' | 'dota2';
  odds: { team1: string; team2: string; start: string; tournament: string; coeff1: number; coeff2: number };
  /** Our match at about the same time sharing one team — most likely the same one under another name. */
  ours: { team1: string; team2: string; start: string } | null;
}

/** Put OddsPapi odds (and tournament name if missing) onto Liquipedia matches: same teams, start within 6 h.
 *  Priced OddsPapi matches still to come that found no match of ours go to `missed`. */
export function addOdds(base: TipsGgMatch[], odds: TipsGgMatch[], resolve: Resolve = teamKey, missed?: OddsMiss[], game: 'cs2' | 'dota2' = 'cs2'): number {
  let n = 0;
  const used = new Set<TipsGgMatch>();
  const near = (a: TipsGgMatch, b: TipsGgMatch) => Math.abs(Date.parse(a.startDate) - Date.parse(b.startDate)) < 6 * 3_600_000;
  for (const m of base) {
    let swapped = false;
    const o = odds.find((x) => {
      if (!near(m, x)) return false;
      if (sameTeam(m.nameTeam1, x.nameTeam1, resolve) && sameTeam(m.nameTeam2, x.nameTeam2, resolve)) { swapped = false; return true; }
      if (sameTeam(m.nameTeam1, x.nameTeam2, resolve) && sameTeam(m.nameTeam2, x.nameTeam1, resolve)) { swapped = true; return true; }
      return false;
    });
    if (!o) continue;
    used.add(o);
    if (o.oddsFixtureId) m.oddsFixtureId = o.oddsFixtureId;
    // a finished match Liquipedia left at «—:—»: OddsPapi's final score, when it has one
    if (m.status === 'finished' && (m.score1 == null || m.score2 == null) && o.score1 != null && o.score2 != null) {
      m.score1 = swapped ? o.score2 : o.score1;
      m.score2 = swapped ? o.score1 : o.score2;
    }
    if (o.coeff1 != null && o.coeff2 != null) {
      m.coeff1 = swapped ? o.coeff2 : o.coeff1;
      m.coeff2 = swapped ? o.coeff1 : o.coeff2;
      const pair = (a: any, b: any) => (swapped ? [b, a] : [a, b]);
      if (o.openCoeff1 != null && o.openCoeff2 != null) [m.openCoeff1, m.openCoeff2] = pair(o.openCoeff1, o.openCoeff2);
      if (o.closeCoeff1 != null && o.closeCoeff2 != null) [m.closeCoeff1, m.closeCoeff2] = pair(o.closeCoeff1, o.closeCoeff2);
      if (o.bestCoeff1 != null && o.bestCoeff2 != null) {
        [m.bestCoeff1, m.bestCoeff2] = pair(o.bestCoeff1, o.bestCoeff2);
        [m.bestBook1, m.bestBook2] = pair(o.bestBook1, o.bestBook2);
      }
      m.performer = m.coeff1! < m.coeff2! ? m.nameTeam1 : m.nameTeam2;
      n++;
    }
    if (!m.tournament && o.tournament) m.tournament = o.tournament;
  }
  if (missed) {
    const now = Date.now();
    for (const o of odds) {
      if (used.has(o) || o.coeff1 == null || o.coeff2 == null || o.status === 'finished' || Date.parse(o.startDate) < now - 3_600_000) continue;
      const cand = base
        .filter((m) => near(m, o) && [m.nameTeam1, m.nameTeam2].some((t) => sameTeam(t, o.nameTeam1, resolve) || sameTeam(t, o.nameTeam2, resolve)))
        .sort((a, z) => Math.abs(Date.parse(a.startDate) - Date.parse(o.startDate)) - Math.abs(Date.parse(z.startDate) - Date.parse(o.startDate)))[0];
      missed.push({
        game,
        odds: { team1: o.nameTeam1, team2: o.nameTeam2, start: o.startDate, tournament: o.tournament, coeff1: o.coeff1, coeff2: o.coeff2 },
        ours: cand ? { team1: cand.nameTeam1, team2: cand.nameTeam2, start: cand.startDate } : null,
      });
    }
  }
  return n;
}

/** Another source's matches (PandaScore, Cito) into our list. The same match is one that has both teams within 6 h of each other
 *  (either order), or one team within 20 min — names differ between sources («NAVI» / «Natus Vincere»).
 *  A known match only takes what it lacks (final score, logos, tournament); the rest are added. Returns how many were added. */
export function addExtra(list: TipsGgMatch[], cito: TipsGgMatch[], resolve: Resolve = teamKey): number {
  let added = 0;
  const pool = [...list];
  for (const c of cito) {
    const t = Date.parse(c.startDate);
    let swapped = false;
    const m = pool.find((x) => {
      const dt = Math.abs(Date.parse(x.startDate) - t);
      if (dt >= 6 * 3_600_000) return false;
      if (sameTeam(x.nameTeam1, c.nameTeam1, resolve) && sameTeam(x.nameTeam2, c.nameTeam2, resolve)) { swapped = false; return true; }
      if (sameTeam(x.nameTeam1, c.nameTeam2, resolve) && sameTeam(x.nameTeam2, c.nameTeam1, resolve)) { swapped = true; return true; }
      if (dt > 20 * 60_000) return false;
      if (sameTeam(x.nameTeam1, c.nameTeam1, resolve) || sameTeam(x.nameTeam2, c.nameTeam2, resolve)) { swapped = false; return true; }
      if (sameTeam(x.nameTeam1, c.nameTeam2, resolve) || sameTeam(x.nameTeam2, c.nameTeam1, resolve)) { swapped = true; return true; }
      return false;
    });
    if (m) {
      if (m.status === 'finished' && (m.score1 == null || m.score2 == null) && c.status === 'finished' && c.score1 != null && c.score2 != null) {
        m.score1 = swapped ? c.score2 : c.score1;
        m.score2 = swapped ? c.score1 : c.score2;
      }
      if (!m.logoTeam1) m.logoTeam1 = swapped ? c.logoTeam2 : c.logoTeam1;
      if (!m.logoTeam2) m.logoTeam2 = swapped ? c.logoTeam1 : c.logoTeam2;
      if (!m.tournament && c.tournament) m.tournament = c.tournament;
      if (!m.stage && c.stage) m.stage = c.stage;
      if (!m.tier && c.tier) m.tier = c.tier;
      if (!m.tournamentLogo && c.tournamentLogo) m.tournamentLogo = c.tournamentLogo;
      // a live match Liquipedia has no series score for yet: the other source's
      if (m.status === 'live' && c.status === 'live' && m.score1 == null && m.score2 == null && c.score1 != null && c.score2 != null) {
        m.score1 = swapped ? c.score2 : c.score1;
        m.score2 = swapped ? c.score1 : c.score2;
      }
      continue;
    }
    list.push(c);
    pool.push(c);
    added++;
  }
  if (added) list.sort((a, z) => Date.parse(a.startDate) - Date.parse(z.startDate));
  return added;
}

/** Matches the last feed build took from Cito / PandaScore (not on Liquipedia) — for the admin cards. */
let citoAddedN = 0;
export const citoAdded = () => citoAddedN;
const psAddedN: Record<'cs2' | 'dota2', number> = { cs2: 0, dota2: 0 };
export const pandascoreAdded = () => ({ ...psAddedN });

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
const misses: Record<'cs2' | 'dota2', OddsMiss[]> = { cs2: [], dota2: [] };
/** Matches taken from OddsPapi's schedule because Liquipedia is down — shown on the admin card. */
const fallback: Record<'cs2' | 'dota2', number> = { cs2: 0, dota2: 0 };
export const fallbackCount = () => fallback.cs2 + fallback.dota2;
const FALLBACK_AFTER_MS = Number(process.env.FALLBACK_AFTER_MIN ?? 60) * 60_000;
export const oddsMatched = () => ({ ...matched });
export const oddsMisses = (): OddsMiss[] => [...misses.cs2, ...misses.dota2].sort((a, z) => a.odds.start.localeCompare(z.odds.start));

/** Liquipedia schedule + OddsPapi odds (OddsPapi spends a request only when its 12-h / daily schedule is due). */
async function newFeed(game: 'cs2' | 'dota2', spendOddsPapi: boolean): Promise<TipsGgMatch[]> {
  // night: OddsPapi spends nothing (its month's budget goes to the day), the cached prices stay
  const odds = !oddspapiEnabled() ? [] : spendOddsPapi && !isNight() ? await fetchOddsPapiMatches(game) : cachedMatches(game);
  const lp = await fetchLiquipediaMatches(game);
  // Liquipedia down → OddsPapi's own schedule: all of it when we have nothing, and when Liquipedia has not
  // refreshed for an hour, OddsPapi's matches of the next day that the old Liquipedia list does not have
  let list = lp.length ? lp : odds;
  fallback[game] = !lp.length && odds.length ? odds.length : 0;
  if (lp.length && odds.length && Date.now() - liquipediaOkAt(game) > FALLBACK_AFTER_MS) {
    const resolve = await aliasResolver(game);
    const extra = odds.filter((o) => {
      const t = Date.parse(o.startDate);
      if (t < Date.now() - 3 * 3_600_000 || t > Date.now() + 24 * 3_600_000) return false;
      return !lp.some((m) => Math.abs(Date.parse(m.startDate) - t) < 6 * 3_600_000
        && ((sameTeam(m.nameTeam1, o.nameTeam1, resolve) && sameTeam(m.nameTeam2, o.nameTeam2, resolve)) || (sameTeam(m.nameTeam1, o.nameTeam2, resolve) && sameTeam(m.nameTeam2, o.nameTeam1, resolve))));
    });
    fallback[game] = extra.length;
    if (extra.length) list = [...lp, ...extra].sort((a, z) => Date.parse(a.startDate) - Date.parse(z.startDate));
  }
  if (pandascoreEnabled()) psAddedN[game] = addExtra(list = [...list], pandascoreMatches(game), await aliasResolver(game));
  if (game === 'cs2' && citoEnabled()) citoAddedN = addExtra(list = [...list], citoMatches(), await aliasResolver(game));
  if (lp.length && odds.length) { const miss: OddsMiss[] = []; matched[game] = addOdds(list, odds, await aliasResolver(game), miss, game); misses[game] = miss; }
  else if (lp.length) { matched[game] = 0; misses[game] = []; }
  // still «—:—» 6 h after the start, and Liquipedia's tournament page did not help: ask OddsPapi (≤ 5 a day)
  const noScore = list.filter((m) => m.status === 'finished' && (m.score1 == null || m.score2 == null) && m.oddsFixtureId && Date.parse(m.startDate) < Date.now() - 6 * 3_600_000);
  if (noScore.length) void requestScores(noScore.map((m) => m.oddsFixtureId!)).catch(() => {});
  list = mergeSameTimeDuplicates(list);
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
  if (oddspapiEnabled() && !isNight()) void refreshOddsPapi().catch(() => {}); // no-op unless its schedule is due
  if (game === 'cs2' && citoEnabled()) void refreshCito().catch(() => {}); // no-op unless its share of the month is due
  if (pandascoreEnabled()) void refreshPandaScore().catch(() => {}); // no-op unless 10 min have passed
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return (await newFeed(game, false)).filter((m) => m.date === today || m.date === yesterday);
}

/** Feed loops used to pause while tips.gg had banned us; nothing bans the new feed. */
export function feedPaused(): boolean {
  return false;
}
