// ═══════════════════════════════════════════════════════════════
// Polymarket (gamma-api.polymarket.com) — prices of CS2 and Dota 2 matches from a prediction market.
//   • public, no key, no monthly limit: asked every 15 minutes
//   • a share's price is the chance the market gives a team: 0.62 → odds 1 / 0.62 ≈ 1.61, almost no margin
//   • the prices sit next to the bookmakers' (pmCoeff1/2), they do not replace them; the last price before the
//     start is kept as Polymarket's closing line — for the matches history and a predictor
// Off with POLYMARKET_OFF=1.
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';
import { pauseInfo, recordFailure, recordSuccess } from './circuitBreaker';
import { isTbd } from '../utils/matchUtils';

export const POLY_PARSER = 'polymarket';
const BASE = 'https://gamma-api.polymarket.com';
const EVERY_MS = 15 * 60_000;
const SPORTS_EVERY_MS = 12 * 3_600_000;
const H = 3_600_000;

export const polymarketEnabled = () => process.env.POLYMARKET_OFF !== '1';

type Game = 'cs2' | 'dota2';
/** One match as we keep it: the teams, the start, the prices now and the last ones before the start. */
export interface PolyMatch { id: string; game: Game; team1: string; team2: string; start: string; tournament: string; bo: number | null; c1: number | null; c2: number | null; close1: number | null; close2: number | null; closed: boolean }

interface CacheShape { at: number; sportsAt: number; series: Record<Game, string[]>; tags: Record<Game, string[]>; matches: PolyMatch[]; failedAt: number }
const empty = (): CacheShape => ({ at: 0, sportsAt: 0, series: { cs2: [], dota2: [] }, tags: { cs2: [], dota2: [] }, matches: [], failedAt: 0 });
let cache: CacheShape = empty();
let hydrated = false;
const DB_KEY = 'feed_polymarket_cache';

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (rows[0]?.value) cache = { ...empty(), ...JSON.parse(rows[0].value) };
  } catch (e) { console.warn('[polymarket] cache ← db failed:', (e as Error).message); }
}
function save(): void {
  pool.query(`INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [DB_KEY, JSON.stringify(cache)])
    .catch((e) => console.warn('[polymarket] cache → db failed:', (e as Error).message));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Which game a /sports entry is: «cs2», «csgo», «counter-strike» → CS2; «dota2», «dota» → Dota 2. */
export function gameOfSport(sport: unknown): Game | null {
  const s = String(sport || '').toLowerCase().replace(/[\s_]/g, '');
  if (/^(cs2|csgo|cs|counter-?strike2?)$/.test(s)) return 'cs2';
  if (/^(dota2?|dota-?2)$/.test(s)) return 'dota2';
  return null;
}

/** A JSON-array string («["A","B"]») or an array → strings. */
const list = (v: unknown): string[] => { if (Array.isArray(v)) return v.map(String); try { const a = JSON.parse(String(v ?? '')); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
/** A share's price → decimal odds (0.62 → 1.61); a price at the edges (≤ 2 % or ≥ 98 %) is no line to keep. */
export const priceToOdds = (p: unknown): number | null => { const x = Number(p); return Number.isFinite(x) && x >= 0.02 && x <= 0.98 ? Math.round((1 / x) * 100) / 100 : null; };

/** «Counter-Strike: SPARTA vs Rune Eaters (BO3) - CCT Europe Series #6 Group Stage» → teams, best-of, tournament. */
export function parseTitle(title: string): { team1: string; team2: string; bo: number | null; tournament: string } | null {
  const m = String(title || '').match(/^(?:[^:]{2,30}:\s*)?(.+?)\s+vs\.?\s+(.+?)(?:\s*\(BO(\d)\))?(?:\s+-\s+(.+))?$/i);
  if (!m) return null;
  return { team1: m[1].trim(), team2: m[2].trim(), bo: m[3] ? Number(m[3]) : null, tournament: (m[4] || '').trim() };
}

/** One Polymarket event → our match with the series winner's prices (the moneyline market), or null. */
export function eventToMatch(ev: any, game: Game, now = Date.now()): PolyMatch | null {
  const t = parseTitle(ev?.title || '');
  if (!t || isTbd(t.team1) || isTbd(t.team2)) return null;
  const markets: any[] = Array.isArray(ev?.markets) ? ev.markets : [];
  // the series winner: «moneyline», else a two-outcome market whose outcomes are the two teams
  const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ml = markets.find((m) => String(m?.sportsMarketType || '').toLowerCase() === 'moneyline')
    || markets.find((m) => { const o = list(m?.outcomes); return o.length === 2 && o.some((x) => same(x, t.team1)) && o.some((x) => same(x, t.team2)); });
  let c1: number | null = null, c2: number | null = null;
  if (ml) {
    const o = list(ml.outcomes), p = list(ml.outcomePrices);
    if (o.length === 2 && p.length === 2) {
      const first = same(o[0], t.team1) || !same(o[0], t.team2) ? 0 : 1;
      c1 = priceToOdds(p[first]); c2 = priceToOdds(p[1 - first]);
    }
  }
  const startRaw = ev?.startTime || ml?.gameStartTime || ev?.gameStartTime || ev?.endDate;
  const start = new Date(startRaw || '');
  if (!startRaw || Number.isNaN(start.getTime())) return null;
  return { id: String(ev.id), game, team1: t.team1, team2: t.team2, start: start.toISOString(), tournament: t.tournament, bo: t.bo, c1, c2, close1: null, close2: null, closed: !!ev?.closed || start.getTime() < now - 12 * H };
}

/** New prices into the kept list: before the start each price is also the closing one; after it the closing stays as it was. */
export function mergePolyMatches(old: PolyMatch[], fresh: PolyMatch[], now = Date.now()): PolyMatch[] {
  const prev = new Map(old.map((m) => [m.id, m]));
  const out = new Map<string, PolyMatch>();
  for (const m of fresh) {
    const o = prev.get(m.id);
    const before = Date.parse(m.start) > now;
    out.set(m.id, { ...m, close1: before && m.c1 != null ? m.c1 : o?.close1 ?? null, close2: before && m.c2 != null ? m.c2 : o?.close2 ?? null });
  }
  // an event no longer listed (finished, closed): kept 2 days for the history, with its closing line
  for (const o of old) if (!out.has(o.id) && Date.parse(o.start) > now - 2 * 24 * H) out.set(o.id, { ...o, closed: true });
  return [...out.values()];
}

let busy = false;
/** Called from the 2-minute refresh; asks Polymarket every 15 minutes. */
export async function refreshPolymarket(force = false): Promise<void> {
  if (!polymarketEnabled() || busy || pauseInfo(POLY_PARSER)) return;
  busy = true;
  try {
    await hydrate();
    const now = Date.now();
    if (!force && (now - cache.at < EVERY_MS || now - cache.failedAt < 30 * 60_000)) return;
    // which series / tags are CS2 and Dota 2 — asked twice a day
    if (force || now - cache.sportsAt > SPORTS_EVERY_MS || (!cache.series.cs2.length && !cache.tags.cs2.length)) {
      const sports = await get<any[]>('/sports');
      const series: CacheShape['series'] = { cs2: [], dota2: [] }, tags: CacheShape['tags'] = { cs2: [], dota2: [] };
      for (const s of Array.isArray(sports) ? sports : []) {
        const g = gameOfSport(s?.sport);
        if (!g) continue;
        for (const id of String(s?.series ?? '').split(',').map((x) => x.trim()).filter(Boolean)) series[g].push(id);
        // the sport's own tag (the last of its list; the first ones are «Sports», «Esports»)
        const tg = String(s?.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (tg.length) tags[g].push(tg[tg.length - 1]);
      }
      cache.series = series; cache.tags = tags; cache.sportsAt = now;
    }
    const fresh: PolyMatch[] = [];
    for (const g of ['cs2', 'dota2'] as Game[]) {
      const ask = cache.series[g].length ? cache.series[g].map((id) => `series_id=${encodeURIComponent(id)}`)
        : cache.tags[g].length ? cache.tags[g].map((id) => `tag_id=${encodeURIComponent(id)}`)
        : [`tag_slug=${g === 'cs2' ? 'counter-strike' : 'dota-2'}`];
      for (const q of ask) {
        const evs = await get<any[]>(`/events?${q}&closed=false&limit=200`);
        for (const ev of Array.isArray(evs) ? evs : []) { const m = eventToMatch(ev, g, now); if (m) fresh.push(m); }
      }
    }
    cache.matches = mergePolyMatches(cache.matches, fresh, now);
    cache.at = now;
    const priced = fresh.filter((m) => m.c1 != null).length;
    recordSuccess(POLY_PARSER, `ціни CS2 і Dota 2 · ${fresh.length} матчів, з цінами ${priced}`);
  } catch (e) {
    cache.failedAt = Date.now();
    const why = (e as Error).name === 'TimeoutError' ? 'не відповів за 20 с' : (e as Error).message;
    console.warn(`[polymarket] ${why}`);
    recordFailure(POLY_PARSER, why.slice(0, 160));
  } finally {
    save();
    busy = false;
  }
}

/** Kept Polymarket matches of a game (no request). */
export function polymarketMatches(game: Game): PolyMatch[] {
  return polymarketEnabled() ? cache.matches.filter((m) => m.game === game) : [];
}

const matchedN: Record<Game, number> = { cs2: 0, dota2: 0 };
export const polymarketMatched = () => ({ ...matchedN });

/** Polymarket's prices onto our matches (the same teams within 6 h of each other); returns how many got one. */
export function addPolymarket(base: TipsGgMatch[], poly: PolyMatch[], same: (a: string, b: string) => boolean, game: Game): number {
  let n = 0;
  for (const m of base) {
    let swapped = false;
    const p = poly.find((x) => {
      if (Math.abs(Date.parse(x.start) - Date.parse(m.startDate)) >= 6 * H) return false;
      if (same(m.nameTeam1, x.team1) && same(m.nameTeam2, x.team2)) { swapped = false; return true; }
      if (same(m.nameTeam1, x.team2) && same(m.nameTeam2, x.team1)) { swapped = true; return true; }
      return false;
    });
    if (!p) continue;
    const pair = (a: number | null, b: number | null) => (swapped ? [b, a] : [a, b]);
    if (p.c1 != null && p.c2 != null && !p.closed) [m.pmCoeff1, m.pmCoeff2] = pair(p.c1, p.c2);
    if (p.close1 != null && p.close2 != null) [m.pmClose1, m.pmClose2] = pair(p.close1, p.close2);
    if (m.pmCoeff1 != null || m.pmClose1 != null) n++;
  }
  matchedN[game] = n;
  return n;
}

/** For the admin card. */
export async function polymarketDiag(): Promise<{ at: string; nextAt: string; cs2: number; dota2: number; priced: number; matched: number }> {
  await hydrate();
  const iso = (t: number) => (t ? new Date(t).toISOString() : '');
  const open = cache.matches.filter((m) => !m.closed);
  return { at: iso(cache.at), nextAt: iso(cache.at ? cache.at + EVERY_MS : 0), cs2: open.filter((m) => m.game === 'cs2').length, dota2: open.filter((m) => m.game === 'dota2').length, priced: open.filter((m) => m.c1 != null).length, matched: matchedN.cs2 + matchedN.dota2 };
}

export function __setPolyCache(c: Partial<CacheShape>): void { cache = { ...empty(), ...c }; hydrated = true; }
