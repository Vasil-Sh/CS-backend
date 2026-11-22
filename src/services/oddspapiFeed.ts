// ═══════════════════════════════════════════════════════════════
// OddsPapi — schedule + bookmaker odds for CS2 and Dota 2 (replaces tips.gg).
//
// Free plan = 250 requests / month, so every call is budgeted:
//   • discovery  — /v4/fixtures per game, once a day        (~2/day)
//   • odds       — /v4/odds-by-tournaments, every 6 hours   (~4/day)
//   → ~180 requests / month, the rest is slack for restarts.
// Everything is cached in .cache/oddspapi.json so a restart does not refetch,
// and a monthly counter there stops all calls at ODDSPAPI_MONTHLY_BUDGET.
//
// Docs: https://oddspapi.io/en/docs  (auth = ?apiKey=, JSON, times in UTC)
// ═══════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure, recordSuccess, isOpen } from './circuitBreaker';
import type { TipsGgMatch } from './tipsggScraper';

export const ODDSPAPI_PARSER = 'oddspapi';
const BASE = 'https://api.oddspapi.io/v4';
const SPORT: Record<'cs2' | 'dota2', number> = { cs2: 17, dota2: 16 };
const H = 60 * 60 * 1000;
const DISCOVERY_EVERY_MS = 24 * H;
const ODDS_EVERY_MS = Number(process.env.ODDSPAPI_ODDS_EVERY_H || 6) * H;
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
  discoveredAt: number;
  oddsAt: number;
  marketsAt: number;
  winnerMarkets: string[];
  tournaments: Record<'cs2' | 'dota2', number[]>;
  fixtures: Record<string, RawFixture>; // by fixtureId, latest data
}

const emptyCache = (): CacheShape => ({
  month: new Date().toISOString().slice(0, 7),
  used: 0, discoveredAt: 0, oddsAt: 0, marketsAt: 0,
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
function save(): void {
  try {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[oddspapi] cache write failed:', (e as Error).message);
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

/** One billable GET. Returns null on any failure (logged, counted in the parser breaker). */
async function get<T>(path: string, params: Record<string, string | number | boolean>): Promise<T | null> {
  const key = (process.env.ODDSPAPI_KEY || '').trim();
  if (!key || Date.now() < exhaustedUntil || isOpen(ODDSPAPI_PARSER)) return null;
  if (budgetLeft() <= 0) { console.warn('[oddspapi] monthly budget spent — skipping', path); return null; }
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apiKey: key });
  const c = load();
  c.used++;
  save();
  try {
    const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const body: any = await res.json().catch(() => ({}));
      const code = body?.error?.code || body?.code || '';
      if (/REQUEST_LIMIT_EXCEEDED/i.test(JSON.stringify(body))) {
        exhaustedUntil = nextMonthStart();
        console.warn('[oddspapi] monthly quota exhausted — paused until', new Date(exhaustedUntil).toISOString());
      } else {
        console.warn('[oddspapi] rate limited', path, code);
      }
      recordFailure(ODDSPAPI_PARSER);
      return null;
    }
    if (!res.ok) {
      console.warn(`[oddspapi] ${path} → HTTP ${res.status}`);
      recordFailure(ODDSPAPI_PARSER);
      return null;
    }
    const json = (await res.json()) as T;
    recordSuccess(ODDSPAPI_PARSER);
    return json;
  } catch (e) {
    console.warn(`[oddspapi] ${path} failed:`, (e as Error).message);
    recordFailure(ODDSPAPI_PARSER);
    return null;
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
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

/** Daily: which tournaments of each game have fixtures with odds in the next 9 days. */
async function discover(c: CacheShape): Promise<void> {
  if (Date.now() - c.discoveredAt < DISCOVERY_EVERY_MS && (c.tournaments.cs2.length || c.tournaments.dota2.length)) return;
  const from = day(Date.now() - 12 * H), to = day(Date.now() + 9 * 24 * H);
  let any = false;
  for (const game of ['cs2', 'dota2'] as const) {
    const rows = asArray<RawFixture>(await get('/fixtures', { sportId: SPORT[game], from, to, hasOdds: true }));
    if (!rows.length) continue;
    any = true;
    c.tournaments[game] = [...new Set(rows.map((f) => f.tournamentId).filter((x): x is number => typeof x === 'number'))];
    for (const f of rows) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f, sportId: f.sportId ?? SPORT[game] };
  }
  if (any) c.discoveredAt = Date.now();
  save();
}

/** Every 6 h: odds (and fresh status / names) for all fixtures of the known tournaments — one request. */
async function refreshOdds(c: CacheShape): Promise<void> {
  if (Date.now() - c.oddsAt < ODDS_EVERY_MS) return;
  const ids = [...c.tournaments.cs2, ...c.tournaments.dota2];
  if (!ids.length) return;
  const rows = asArray<RawFixture>(await get('/odds-by-tournaments', { tournamentIds: ids.slice(0, 60).join(',') }));
  if (!rows.length) return;
  for (const f of rows) if (f.fixtureId) c.fixtures[f.fixtureId] = { ...c.fixtures[f.fixtureId], ...f };
  c.oddsAt = Date.now();
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
export function oddspapiUsage(): { used: number; budget: number; oddsAt: number; discoveredAt: number } {
  const c = load();
  budgetLeft();
  return { used: c.used, budget: MONTHLY_BUDGET, oddsAt: c.oddsAt, discoveredAt: c.discoveredAt };
}

/** Tests only. */
export function __resetOddsPapiCache(): void { cache = emptyCache(); }
