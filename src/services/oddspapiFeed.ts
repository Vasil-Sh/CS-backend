// ═══════════════════════════════════════════════════════════════
// OddsPapi — schedule + bookmaker odds for CS2 and Dota 2 (replaces tips.gg).
//
// Free plan = 250 requests / month, so every call is budgeted:
//   • schedule — /v4/fixtures per game, once a day (names, times, status)   ~2/day
//   • odds     — /v4/odds-by-tournaments, every 12 h: max 5 tournaments and
//                exactly one bookmaker (Pinnacle) per call, so only the
//                tournaments playing in the next 36 h, ≤ 10 of them            ≤4/day
//   → ≤ ~180 requests / month, the rest is slack for restarts.
// Endpoint cooldowns (fixtures 2 s, odds 1 s) are respected; a failed call
// backs that endpoint off for 3 h so a broken request can't drain the quota.
// Everything is cached in .cache/oddspapi.json so a restart does not refetch,
// and a monthly counter there stops all calls at ODDSPAPI_MONTHLY_BUDGET.
//
// Docs: https://oddspapi.io/en/docs  (auth = ?apiKey=, JSON, times in UTC)
// ═══════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure, recordSuccess, isOpen } from './circuitBreaker';
import { pool } from '../db/client';
import type { TipsGgMatch } from './matchTypes';

export const ODDSPAPI_PARSER = 'oddspapi';
const BASE = 'https://api.oddspapi.io/v4';
const SPORT: Record<'cs2' | 'dota2', number> = { cs2: 17, dota2: 16 };
const H = 60 * 60 * 1000;
const DISCOVERY_EVERY_MS = 24 * H;
const ODDS_EVERY_MS = Number(process.env.ODDSPAPI_ODDS_EVERY_H || 12) * H;
const ODDS_BOOKMAKER = (process.env.ODDSPAPI_BOOKMAKER || 'pinnacle').trim();
const MAX_ODDS_TOURNAMENTS = 10; // 2 calls of 5
const FAIL_BACKOFF_MS = 3 * H;
/** Minimum gap between two calls to the same endpoint (OddsPapi cooldowns + margin). */
const COOLDOWN: Record<string, number> = { '/fixtures': 2500, '/odds-by-tournaments': 1500 };
const MONTHLY_BUDGET = Number(process.env.ODDSPAPI_MONTHLY_BUDGET || 230);
const CACHE_FILE = join(process.cwd(), '.cache', 'oddspapi.json');
/** Bookmakers to read the match price from, in order of preference. */
const BOOK_ORDER = ['pinnacle', 'ggbet', 'thunderpick', '1xbet', 'bet365', 'stake'];
/** Match-winner market ids seen in OddsPapi's own CS2 example; used when /v4/markets gives nothing better. */
const WINNER_FALLBACK = ['171', '178077'];

export function oddspapiEnabled(): boolean {
  return !!(process.env.ODDSPAPI_KEY || '').trim();
}

// ── Raw API shapes (only the fields we read) ──
interface RawPlayer { price?: number; active?: boolean }
interface RawOutcome { players?: Record<string, RawPlayer> }
interface RawMarket { outcomes?: Record<string, RawOutcome> }
interface RawBook { markets?: Record<string, RawMarket>; bookmakerIsActive?: boolean }
export interface RawFixture {
  fixtureId: string;
  sportId?: number;
  tournamentId?: number;
  statusId?: number;
  startTime?: string;
  participant1Name?: string;
  participant2Name?: string;
  tournamentName?: string;
  categoryName?: string;
  hasOdds?: boolean;
  bookmakerOdds?: Record<string, RawBook>;
}

interface CacheShape {
  month: string; // YYYY-MM the counter belongs to
  used: number; // requests spent this month
  discoveredAt: number; // legacy, unused
  discovered: Record<'cs2' | 'dota2', number>;
  failedAt: Record<string, number>; // endpoint → last failure (backoff)
  oddsAt: number;
  marketsAt: number;
  winnerMarkets: string[];
  tournaments: Record<'cs2' | 'dota2', number[]>;
  fixtures: Record<string, RawFixture>; // by fixtureId, latest data
}

const emptyCache = (): CacheShape => ({
  month: new Date().toISOString().slice(0, 7),
  used: 0, discoveredAt: 0, discovered: { cs2: 0, dota2: 0 }, failedAt: {}, oddsAt: 0, marketsAt: 0,
  winnerMarkets: [], tournaments: { cs2: [], dota2: [] }, fixtures: {},
});

let cache: CacheShape | null = null;
function load(): CacheShape {
  if (cache) return cache;
  try {
    if (existsSync(CACHE_FILE)) cache = { ...emptyCache(), ...JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) };
  } catch { /* corrupt — start over */ }
  cache = cache || emptyCache();
  return cache;
}
// Railway gives every deploy a fresh disk, so the file alone was lost on each push and the
// next start re-spent ~5 requests (markets + 2 schedules + odds). The same JSON is kept in
// Postgres (app_settings, not one of the admin's settings keys) and read back on start.
const DB_KEY = 'feed_oddspapi_cache';
let dbTimer: NodeJS.Timeout | null = null;
function save(): void {
  try {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[oddspapi] cache write failed:', (e as Error).message);
  }
  if (dbTimer) return;
  dbTimer = setTimeout(() => {
    dbTimer = null;
    pool.query(
      `INSERT INTO app_settings(key, value) VALUES($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [DB_KEY, JSON.stringify(cache)],
    ).catch((e) => console.warn('[oddspapi] cache → db failed:', (e as Error).message));
  }, 2_000);
  dbTimer.unref?.();
}

let hydrated = false;
/** On start: take the cache saved in Postgres when it is newer than the local file (or there is no file). */
async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (!rows[0]?.value) return;
    const db = { ...emptyCache(), ...JSON.parse(rows[0].value) } as CacheShape;
    const local = load();
    const stamp = (c: CacheShape) => Math.max(c.oddsAt || 0, c.discovered?.cs2 || 0, c.discovered?.dota2 || 0, c.marketsAt || 0);
    if (stamp(db) >= stamp(local) || db.used > local.used) {
      cache = db;
      console.log(`[oddspapi] cache restored from db (${db.used} requests used in ${db.month})`);
    }
  } catch (e) {
    console.warn('[oddspapi] cache ← db failed:', (e as Error).message);
  }
}

/** Requests left this month by our own count (resets on the 1st, like OddsPapi's quota). */
export function budgetLeft(): number {
  const c = load();
  const month = new Date().toISOString().slice(0, 7);
  if (c.month !== month) { c.month = month; c.used = 0; save(); }
  return MONTHLY_BUDGET - c.used;
}

let exhaustedUntil = 0;
const nextMonthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

const lastCall: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One billable GET. Returns null on any failure (logged, counted in the parser breaker). */
async function get<T>(path: string, params: Record<string, string | number | boolean>, retry = true): Promise<T | null> {
  const key = (process.env.ODDSPAPI_KEY || '').trim();
  if (!key || Date.now() < exhaustedUntil || isOpen(ODDSPAPI_PARSER)) return null;
  const c = load();
  if (Date.now() - (c.failedAt[path] || 0) < FAIL_BACKOFF_MS) return null;
  if (budgetLeft() <= 0) { console.warn('[oddspapi] monthly budget spent — skipping', path); return null; }
  const wait = (lastCall[path] || 0) + (COOLDOWN[path] ?? 1500) - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[path] = Date.now();
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apiKey: key });
  c.used++;
  save();
  const fail = (why: string) => { console.warn(`[oddspapi] ${path} ${why}`); c.failedAt[path] = Date.now(); save(); recordFailure(ODDSPAPI_PARSER); return null; };
  try {
    const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const body: any = await res.json().catch(() => ({}));
      const text = JSON.stringify(body);
      if (/REQUEST_LIMIT_EXCEEDED/i.test(text)) {
        exhaustedUntil = nextMonthStart();
        console.warn('[oddspapi] monthly quota exhausted — paused until', new Date(exhaustedUntil).toISOString());
        recordFailure(ODDSPAPI_PARSER);
        return null;
      }
      // per-endpoint cooldown: wait what the API asks and try once more
      const retryMs = Number(body?.error?.retryMs ?? body?.retryMs) || 2500;
      if (retry) { await sleep(Math.min(retryMs, 10_000) + 300); return get<T>(path, params, false); }
      return fail('rate limited twice');
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(key, '***').slice(0, 300);
      return fail(`→ HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as T;
    delete c.failedAt[path];
    recordSuccess(ODDSPAPI_PARSER);
    return json;
  } catch (e) {
    return fail(`failed: ${(e as Error).message}`);
  }
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : Array.isArray((v as any)?.data) ? (v as any).data : []);

/** Market ids that mean «who wins the match» for esports — resolved by name once a month. */
async function resolveWinnerMarkets(c: CacheShape): Promise<void> {
  if (c.winnerMarkets.length && Date.now() - c.marketsAt < 30 * 24 * H) return;
  const list = asArray<any>(await get('/markets', {}));
  if (!list.length) { if (!c.winnerMarkets.length) c.winnerMarkets = [...WINNER_FALLBACK]; return; }
  c.winnerMarkets = pickWinnerMarkets(list);
  if (!c.winnerMarkets.length) c.winnerMarkets = [...WINNER_FALLBACK];
  c.marketsAt = Date.now();
  save();
}

/** From /v4/markets rows keep the full-match winner markets of CS2 / Dota 2 (2 outcomes, no map / handicap / total). */
export function pickWinnerMarkets(rows: any[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const sport = Number(r.sportId ?? r.sport_id);
    if (sport && sport !== SPORT.cs2 && sport !== SPORT.dota2) continue;
    const name = String(r.marketName ?? r.name ?? '').toLowerCase().trim();
    if (!/^(winner|match winner|moneyline|1x2|match result|to win match)$/.test(name)) continue;
    if (/map|handicap|total|half|round|period/.test(`${name} ${r.period ?? ''} ${r.marketType ?? ''}`.toLowerCase())) continue;
    const id = r.marketId ?? r.id;
    if (id != null) ids.add(String(id));
  }
  return [...ids];
}

/** Daily per game: schedule for the next 9 days (names, times, status, tournaments). */
async function discover(c: CacheShape): Promise<void> {
  const from = new Date(Date.now() - 12 * H).toISOString(), to = new Date(Date.now() + 9 * 24 * H).toISOString(); // < 10 days
  for (const game of ['cs2', 'dota2'] as const) {
    if (Date.now() - (c.discovered[game] || 0) < DISCOVERY_EVERY_MS) continue;
    const rows = await get<unknown>('/fixtures', { sportId: SPORT[game], from, to });
    if (rows === null) continue; // failed — retried after the backoff
    const list = asArray<RawFixture>(rows);
    for (const f of list) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f, sportId: f.sportId ?? SPORT[game] };
    c.tournaments[game] = [...new Set(list.map((f) => f.tournamentId).filter((x): x is number => typeof x === 'number'))];
    c.discovered[game] = Date.now();
    save();
  }
}

/** Tournaments worth odds now: fixtures starting within the next 36 h, busiest first. */
export function oddsTournaments(fixtures: RawFixture[], now = Date.now(), max = MAX_ODDS_TOURNAMENTS): number[] {
  const n = new Map<number, number>();
  for (const f of fixtures) {
    const t = Date.parse(f.startTime || '');
    if (typeof f.tournamentId !== 'number' || !(t > now - 2 * H && t < now + 36 * H) || f.statusId === 2 || f.statusId === 3) continue;
    n.set(f.tournamentId, (n.get(f.tournamentId) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
}

/** Every 12 h: Pinnacle odds for the tournaments playing soon — 5 tournaments per call. */
async function refreshOdds(c: CacheShape): Promise<void> {
  if (Date.now() - c.oddsAt < ODDS_EVERY_MS) return;
  const ids = oddsTournaments(Object.values(c.fixtures));
  if (!ids.length) return;
  let ok = false;
  for (let i = 0; i < ids.length; i += 5) {
    const rows = await get<unknown>('/odds-by-tournaments', { tournamentIds: ids.slice(i, i + 5).join(','), bookmaker: ODDS_BOOKMAKER });
    if (rows === null) break;
    ok = true;
    for (const f of asArray<RawFixture>(rows)) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f };
  }
  if (ok) c.oddsAt = Date.now();
  // forget fixtures older than 3 days
  const cutoff = Date.now() - 3 * 24 * H;
  for (const [id, f] of Object.entries(c.fixtures)) if (f.startTime && Date.parse(f.startTime) < cutoff) delete c.fixtures[id];
  save();
}

let inflight: Promise<void> | null = null;
/** Bring the cache up to date if a refresh is due (never more often than the schedule above). */
export async function refreshOddsPapi(): Promise<void> {
  if (!oddspapiEnabled()) return;
  if (inflight) return inflight;
  inflight = (async () => {
    await hydrate();
    const c = load();
    await resolveWinnerMarkets(c);
    await discover(c);
    await refreshOdds(c);
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Decimal price of the match winner for team 1 / team 2, from the most trusted bookmaker that has it. */
export function winnerPrices(f: RawFixture, winnerMarkets: string[]): { coeff1: number | null; coeff2: number | null } {
  const books = f.bookmakerOdds || {};
  const order = [...BOOK_ORDER.filter((b) => books[b]), ...Object.keys(books).filter((b) => !BOOK_ORDER.includes(b))];
  for (const b of order) {
    const book = books[b];
    if (!book?.markets || book.bookmakerIsActive === false) continue;
    for (const mid of winnerMarkets) {
      const outcomes = book.markets[mid]?.outcomes;
      if (!outcomes) continue;
      const ids = Object.keys(outcomes).sort((a, z) => Number(a) - Number(z));
      if (ids.length !== 2) continue;
      const price = (o?: RawOutcome) => { const p = o?.players?.['0']; return p && p.active !== false && typeof p.price === 'number' && p.price > 1 ? p.price : null; };
      const c1 = price(outcomes[ids[0]]), c2 = price(outcomes[ids[1]]);
      if (c1 && c2) return { coeff1: Math.round(c1 * 100) / 100, coeff2: Math.round(c2 * 100) / 100 };
    }
  }
  return { coeff1: null, coeff2: null };
}

/** OddsPapi fixture → the match shape the rest of the backend already uses (tips.gg's). */
export function toMatch(f: RawFixture, winnerMarkets: string[]): TipsGgMatch | null {
  if (!f.fixtureId || !f.startTime || !f.participant1Name || !f.participant2Name) return null;
  if (f.statusId === 3) return null; // cancelled
  const start = new Date(f.startTime);
  if (isNaN(start.getTime())) return null;
  let status: TipsGgMatch['status'] = f.statusId === 1 ? 'live' : f.statusId === 2 ? 'finished' : 'upcoming';
  // Odds refresh only every 6 h, so the status can be stale: same rule as tips.gg had —
  // started over 6 h ago → finished; already started → live.
  const sinceStart = Date.now() - start.getTime();
  if (status !== 'finished') status = sinceStart > 6 * H ? 'finished' : sinceStart > 0 ? 'live' : status;
  const { coeff1, coeff2 } = winnerPrices(f, winnerMarkets);
  return {
    id: `op-${f.fixtureId}`,
    date: start.toISOString().slice(0, 10),
    link: '',
    type: 'BO3', // OddsPapi has no series length; Dota gets the real one from OpenDota
    score1: null,
    score2: null,
    nameTeam1: f.participant1Name.trim(),
    nameTeam2: f.participant2Name.trim(),
    logoTeam1: null,
    logoTeam2: null,
    tournament: (f.tournamentName || '').trim(),
    stage: '',
    status,
    tipsCount: 0,
    performer: coeff1 && coeff2 ? (coeff1 < coeff2 ? f.participant1Name.trim() : f.participant2Name.trim()) : null,
    startDate: start.toISOString(),
    pred1: null,
    pred2: null,
    coeff1,
    coeff2,
    positionTeam1: null,
    positionTeam2: null,
    tournamentLogo: null,
  };
}

/** Cached matches for one game — no API call. */
export function cachedMatches(game: 'cs2' | 'dota2'): TipsGgMatch[] {
  const c = load();
  const winner = c.winnerMarkets.length ? c.winnerMarkets : WINNER_FALLBACK;
  return Object.values(c.fixtures)
    .filter((f) => (f.sportId ?? 0) === SPORT[game] || (!f.sportId && c.tournaments[game].includes(f.tournamentId ?? -1)))
    .map((f) => toMatch(f, winner))
    .filter((m): m is TipsGgMatch => !!m)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Refresh if due, then return this game's matches. */
export async function fetchOddsPapiMatches(game: 'cs2' | 'dota2'): Promise<TipsGgMatch[]> {
  await refreshOddsPapi().catch((e) => console.warn('[oddspapi] refresh failed:', (e as Error).message));
  return cachedMatches(game);
}

/** For the admin «Парсери» screen. */
export function oddspapiUsage(): { used: number; budget: number; oddsAt: number; discovered: Record<'cs2' | 'dota2', number> } {
  const c = load();
  budgetLeft();
  return { used: c.used, budget: MONTHLY_BUDGET, oddsAt: c.oddsAt, discovered: c.discovered };
}

/** Tests only. */
export function __resetOddsPapiCache(): void { cache = emptyCache(); }
