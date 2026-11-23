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
/** Match-winner markets: OddsPapi numbers the winner of every sport sportId × 10 + 1 (CS2 171, Dota 2 161).
 *  Always read, on top of whatever /v4/markets resolves — the old fallback had no Dota id at all. */
const WINNER_FALLBACK = ['171', '161', '178077'];
const withFallback = (ids: string[]) => [...new Set([...ids, ...WINNER_FALLBACK])];
/** Bump when the way the cache is filled changes: the next start refetches once (≈5 requests). */
const CACHE_VER = 2;
/** ISO time without milliseconds — the format OddsPapi documents (YYYY-MM-DDTHH:MM:SSZ). */
const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
  ver?: number;
  /** What the last calls brought back — shown on the admin «Парсери» card. */
  diag?: { fixtures: Record<'cs2' | 'dota2', number>; fixturesAt: number; oddsTournaments: number; oddsRows: number; oddsAt: number };
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
  /** OddsPapi's own count from /v4/account (free call): every request on the key, ours or not. */
  account?: { limit: number; count: number; at: number };
  /** First winner prices seen per fixture — the opening line, to show how it moved. */
  opening?: Record<string, { c1: number; c2: number; at: number }>;
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

/** Requests left this month. OddsPapi's own figure (/v4/account) when we have a fresh one — it also counts
 *  calls made outside this server (tests in the browser, older deploys) — else our own count. */
export function budgetLeft(): number {
  const c = load();
  const month = new Date().toISOString().slice(0, 7);
  if (c.month !== month) { c.month = month; c.used = 0; if (c.account) c.account = { ...c.account, count: 0 }; save(); }
  const acc = c.account && c.account.at > Date.parse(`${month}-01T00:00:00Z`) ? c.account : null;
  // between two /account reads, add what we spent since the last one
  return acc ? acc.limit - acc.count - Math.max(0, c.used - (accUsedAt ?? c.used)) : MONTHLY_BUDGET - c.used;
}
let accUsedAt: number | null = null; // our `used` when /account was last read

/** Find a numeric field anywhere in the /account answer (object, array of subscriptions or nested). */
function findNum(v: unknown, key: string): number | null {
  if (!v || typeof v !== 'object') return null;
  if (!Array.isArray(v) && typeof (v as any)[key] === 'number') return (v as any)[key];
  for (const x of Array.isArray(v) ? v : Object.values(v)) { const n = findNum(x, key); if (n != null) return n; }
  return null;
}

/** OddsPapi's own request count — /v4/account is free and answers even when the quota is spent. At most every 10 min. */
async function syncAccount(force = false): Promise<void> {
  const key = (process.env.ODDSPAPI_KEY || '').trim();
  const c = load();
  if (!key || (!force && c.account && Date.now() - c.account.at < 10 * 60_000)) return;
  try {
    const res = await fetch(`${BASE}/account?${new URLSearchParams({ apiKey: key })}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { console.warn(`[oddspapi] /account → HTTP ${res.status}`); return; }
    const json = await res.json();
    const limit = findNum(json, 'request_limit'), count = findNum(json, 'request_count');
    if (limit == null || count == null) { console.warn('[oddspapi] /account: no request_limit / request_count in', JSON.stringify(json).slice(0, 300)); return; }
    c.account = { limit, count, at: Date.now() };
    accUsedAt = c.used;
    save();
  } catch (e) {
    console.warn('[oddspapi] /account failed:', (e as Error).message);
  }
}

let exhaustedUntil = 0;
const nextMonthStart = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

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
  const fail = (why: string) => { console.warn(`[oddspapi] ${path} ${why}`); c.failedAt[path] = Date.now(); save(); recordFailure(ODDSPAPI_PARSER, `${path} · ${why.replace(/^→ /, '').slice(0, 120)}`); return null; };
  try {
    const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const body: any = await res.json().catch(() => ({}));
      const text = JSON.stringify(body);
      if (/REQUEST_LIMIT_EXCEEDED/i.test(text)) {
        exhaustedUntil = nextMonthStart();
        console.warn('[oddspapi] monthly quota exhausted — paused until', new Date(exhaustedUntil).toISOString());
        recordFailure(ODDSPAPI_PARSER, 'місячний ліміт OddsPapi вичерпано');
        return null;
      }
      // per-endpoint cooldown: wait what the API asks and try once more
      const retryMs = Number(body?.error?.retryMs ?? body?.retryMs) || 2500;
      if (retry) { await sleep(Math.min(retryMs, 10_000) + 300); return get<T>(path, params, false); }
      return fail('rate limited twice');
    }
    if (res.status === 404) {
      // OddsPapi answers 404 for a window with no fixtures — that is «nothing», not a failure
      delete c.failedAt[path];
      return [] as unknown as T;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(key, '***').slice(0, 300);
      return fail(`→ HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as T;
    delete c.failedAt[path];
    return json; // the caller logs the success with what it brought
  } catch (e) {
    return fail(`failed: ${(e as Error).message}`);
  }
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : Array.isArray((v as any)?.data) ? (v as any).data : []);

/** Market ids that mean «who wins the match» for esports — resolved by name once a month. */
async function resolveWinnerMarkets(c: CacheShape): Promise<void> {
  if (c.winnerMarkets.length && Date.now() - c.marketsAt < 30 * 24 * H) return;
  const raw = await get('/markets', {});
  const list = asArray<any>(raw);
  if (raw !== null) recordSuccess(ODDSPAPI_PARSER, `ринки · ${list.length}`);
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
  const from = isoSec(Date.now() - 12 * H), to = isoSec(Date.now() + 9 * 24 * H); // < 10 days
  for (const game of ['cs2', 'dota2'] as const) {
    if (Date.now() - (c.discovered[game] || 0) < DISCOVERY_EVERY_MS) continue;
    const rows = await get<unknown>('/fixtures', { sportId: SPORT[game], from, to });
    if (rows === null) continue; // failed — retried after the backoff
    const list = asArray<RawFixture>(rows);
    for (const f of list) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f, sportId: f.sportId ?? SPORT[game] };
    c.tournaments[game] = [...new Set(list.map((f) => f.tournamentId).filter((x): x is number => typeof x === 'number'))];
    c.discovered[game] = Date.now();
    c.diag = { ...diagOf(c), fixtures: { ...diagOf(c).fixtures, [game]: list.length }, fixturesAt: Date.now() };
    console.log(`[oddspapi] ${game}: ${list.length} fixtures in the next 9 days`);
    recordSuccess(ODDSPAPI_PARSER, `${game === 'cs2' ? 'CS2' : 'Dota 2'} · розклад · ${list.length} матчів на 9 днів`);
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

const DAY = 24 * H;
const MIN_ODDS_EVERY_MS = 3 * H;
const RESERVE = 10; // requests kept for restarts and the next month's first day

/** How often odds can refresh so the month's budget lasts to the 1st: what is left (minus a reserve
 *  and the 2 daily schedule calls) spread over the days left, each refresh costing one call per 5
 *  tournaments. Never more often than 3 h, never rarer than ODDSPAPI_ODDS_EVERY_H (12 h). */
export function oddsEveryMs(left: number, tournaments: number, now = Date.now()): number {
  const daysLeft = Math.max(1, (nextMonthStart(now) - now) / DAY);
  const perDay = (left - RESERVE) / daysLeft - 2;
  const perRefresh = Math.max(1, Math.ceil(tournaments / 5));
  const refreshes = perDay / perRefresh;
  if (refreshes <= 0) return ODDS_EVERY_MS * 2;
  return Math.min(ODDS_EVERY_MS, Math.max(MIN_ODDS_EVERY_MS, DAY / refreshes));
}

/** Pinnacle odds for the tournaments playing soon — 5 tournaments per call, as often as the budget allows. */
async function refreshOdds(c: CacheShape): Promise<void> {
  const ids = oddsTournaments(Object.values(c.fixtures));
  if (!ids.length) return;
  if (Date.now() - c.oddsAt < oddsEveryMs(budgetLeft(), ids.length)) return;
  let ok = false, got = 0;
  for (let i = 0; i < ids.length; i += 5) {
    const rows = await get<unknown>('/odds-by-tournaments', { tournamentIds: ids.slice(i, i + 5).join(','), bookmaker: ODDS_BOOKMAKER });
    if (rows === null) break;
    ok = true;
    const list = asArray<RawFixture>(rows);
    got += list.length;
    for (const f of list) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f };
  }
  // opening line: the first prices each fixture got (kept until the fixture is forgotten)
  const winner = withFallback(c.winnerMarkets);
  c.opening ||= {};
  for (const [id, f] of Object.entries(c.fixtures)) {
    if (c.opening[id]) continue;
    const p = winnerPrices(f, winner);
    if (p.coeff1 != null && p.coeff2 != null) c.opening[id] = { c1: p.coeff1, c2: p.coeff2, at: Date.now() };
  }
  if (ok) {
    c.oddsAt = Date.now();
    c.diag = { ...diagOf(c), oddsTournaments: ids.length, oddsRows: got, oddsAt: Date.now() };
    console.log(`[oddspapi] odds: ${got} fixtures from ${ids.length} tournaments (${ODDS_BOOKMAKER})`);
    recordSuccess(ODDSPAPI_PARSER, `коефіцієнти · ${got} матчів із ${ids.length} турнірів · далі через ${Math.round(oddsEveryMs(budgetLeft(), ids.length) / H)} год`);
  }
  // forget fixtures older than 3 days
  const cutoff = Date.now() - 3 * 24 * H;
  for (const [id, f] of Object.entries(c.fixtures)) if (f.startTime && Date.parse(f.startTime) < cutoff) { delete c.fixtures[id]; delete c.opening?.[id]; }
  save();
}

let inflight: Promise<void> | null = null;
/** Bring the cache up to date if a refresh is due (never more often than the schedule above). */
export async function refreshOddsPapi(): Promise<void> {
  if (!oddspapiEnabled()) return;
  if (inflight) return inflight;
  inflight = (async () => {
    await hydrate();
    await syncAccount();
    const c = load();
    if ((c.ver || 0) < CACHE_VER) {
      // fixed request shape / winner markets → fetch schedule and odds once more instead of waiting a day
      c.ver = CACHE_VER; c.discovered = { cs2: 0, dota2: 0 }; c.oddsAt = 0; c.marketsAt = 0; c.failedAt = {};
      save();
    }
    const before = c.used;
    await resolveWinnerMarkets(c);
    await discover(c);
    await refreshOdds(c);
    if (c.used > before) await syncAccount(true); // spent some — read the real count back
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
export function toMatch(f: RawFixture, winnerMarkets: string[], opening?: { c1: number; c2: number }): TipsGgMatch | null {
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
    openCoeff1: opening?.c1 ?? null,
    openCoeff2: opening?.c2 ?? null,
  };
}

/** Cached matches for one game — no API call. */
export function cachedMatches(game: 'cs2' | 'dota2'): TipsGgMatch[] {
  const c = load();
  const winner = withFallback(c.winnerMarkets);
  return Object.values(c.fixtures)
    .filter((f) => (f.sportId ?? 0) === SPORT[game] || (!f.sportId && c.tournaments[game].includes(f.tournamentId ?? -1)))
    .map((f) => toMatch(f, winner, c.opening?.[f.fixtureId]))
    .filter((m): m is TipsGgMatch => !!m)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Refresh if due, then return this game's matches. */
export async function fetchOddsPapiMatches(game: 'cs2' | 'dota2'): Promise<TipsGgMatch[]> {
  await refreshOddsPapi().catch((e) => console.warn('[oddspapi] refresh failed:', (e as Error).message));
  return cachedMatches(game);
}

const diagOf = (c: CacheShape): NonNullable<CacheShape['diag']> =>
  c.diag || { fixtures: { cs2: 0, dota2: 0 }, fixturesAt: 0, oddsTournaments: 0, oddsRows: 0, oddsAt: 0 };

/** For the admin «Парсери» card: what OddsPapi has right now, from the cache (no API call). */
export function oddspapiDiag(): { used: number; budget: number; accountAt: number; scheduled: number; priced: number; fixturesAt: number; oddsAt: number; nextOddsAt: number; oddsTournaments: number } {
  const c = load();
  budgetLeft();
  const now = Date.now(), winner = withFallback(c.winnerMarkets);
  const soon = Object.values(c.fixtures).filter((f) => { const t = Date.parse(f.startTime || ''); return t > now - 12 * H && f.statusId !== 3; });
  const priced = soon.filter((f) => { const p = winnerPrices(f, winner); return p.coeff1 != null && p.coeff2 != null; }).length;
  const d = diagOf(c);
  const ids = oddsTournaments(Object.values(c.fixtures));
  const nextOddsAt = ids.length && c.oddsAt ? c.oddsAt + oddsEveryMs(budgetLeft(), ids.length) : 0;
  const left = budgetLeft();
  const budget = c.account?.limit ?? MONTHLY_BUDGET;
  return { used: Math.max(0, budget - left), budget, accountAt: c.account?.at || 0, scheduled: soon.length, priced, fixturesAt: d.fixturesAt || Math.max(c.discovered.cs2 || 0, c.discovered.dota2 || 0), oddsAt: c.oddsAt, nextOddsAt, oddsTournaments: d.oddsTournaments };
}

/** For the admin «Парсери» screen. */
export function oddspapiUsage(): { used: number; budget: number; oddsAt: number; discovered: Record<'cs2' | 'dota2', number> } {
  const c = load();
  budgetLeft();
  return { used: c.used, budget: MONTHLY_BUDGET, oddsAt: c.oddsAt, discovered: c.discovered };
}

/** Tests only. */
export function __resetOddsPapiCache(): void { cache = emptyCache(); }
