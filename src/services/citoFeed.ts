// ═══════════════════════════════════════════════════════════════
// Cito CS2 API (citoapi.com) — a second CS2 schedule next to Liquipedia.
//   • /cs2/matches/upcoming — matches Liquipedia's ticker does not list are added to the feed
//   • /cs2/matches/recent   — final scores for finished matches still at «—:—»
// Free plan: 500 requests a month for the whole account, so the requests are spread over the
// month (about every 2 h for the schedule, every 4–5 h for the results). Only with CITO_API_KEY.
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';
import { pauseInfo, recordFailure, recordSuccess } from './circuitBreaker';

export const CITO_PARSER = 'cito';
const BASE = 'https://api.citoapi.com/api/v1';
const H = 3_600_000;
const MONTHLY = Number(process.env.CITO_MONTHLY ?? 500);
/** Requests kept back for «Оновити зараз» from the admin. */
const RESERVE = 15;
const MIN_UPCOMING_MS = 90 * 60_000;
const MIN_RECENT_MS = 3 * H;

export const citoEnabled = () => !!process.env.CITO_API_KEY;

/** A match as Cito returns it (fields the cs2-api package documents; logos are not documented, so read defensively). */
export interface CitoMatch {
  id: string;
  status?: string | null;
  startsAt?: string | null;
  bestOf?: number | null;
  eventName?: string | null;
  team1Name?: string | null;
  team2Name?: string | null;
  team1Score?: number | null;
  team2Score?: number | null;
  [key: string]: unknown;
}

interface CacheShape {
  month: string;
  used: number;
  /** Cito's own figure from X-Cito-Credits-Remaining, when it sent one. */
  remaining: number | null;
  upcomingAt: number;
  recentAt: number;
  upcoming: CitoMatch[];
  recent: CitoMatch[];
  failedAt: number;
}
const monthNow = () => new Date().toISOString().slice(0, 7);
const empty = (): CacheShape => ({ month: monthNow(), used: 0, remaining: null, upcomingAt: 0, recentAt: 0, upcoming: [], recent: [], failedAt: 0 });

let cache: CacheShape = empty();
let hydrated = false;
const DB_KEY = 'feed_cito_cache';

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (rows[0]?.value) cache = { ...empty(), ...JSON.parse(rows[0].value) };
  } catch (e) {
    console.warn('[cito] cache ← db failed:', (e as Error).message);
  }
}
function save(): void {
  pool.query(
    `INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DB_KEY, JSON.stringify(cache)],
  ).catch((e) => console.warn('[cito] cache → db failed:', (e as Error).message));
}
function rollMonth(): void {
  if (cache.month !== monthNow()) cache = { ...cache, month: monthNow(), used: 0, remaining: null };
}

/** Requests left this month: Cito's own count when it sent one, else ours. */
export function citoLeft(): number {
  rollMonth();
  const ours = MONTHLY - cache.used;
  return Math.max(0, cache.remaining != null ? Math.min(cache.remaining, ours) : ours);
}

/** Spread what is left over the rest of the month: the schedule gets two thirds of it, the results one third. */
export function citoEveryMs(left: number, share: number, min: number, now = Date.now()): number {
  const d = new Date(now);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const usable = Math.floor((left - RESERVE) * share);
  if (usable <= 0) return Infinity;
  return Math.max(min, (monthEnd - now) / usable);
}

async function get(path: string): Promise<CitoMatch[] | null> {
  const key = process.env.CITO_API_KEY;
  if (!key) return null;
  rollMonth();
  cache.used++;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const left = Number(res.headers.get('x-cito-credits-remaining'));
    if (Number.isFinite(left) && res.headers.has('x-cito-credits-remaining')) cache.remaining = left;
    if (res.status === 429) { cache.remaining = 0; throw new Error('місячний ліміт Cito вичерпано'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error('відповідь без списку матчів');
    return body.data as CitoMatch[];
  } catch (e) {
    cache.failedAt = Date.now();
    const why = (e as Error).name === 'TimeoutError' ? 'не відповів за 20 с' : (e as Error).message;
    console.warn(`[cito] ${path} ${why}`);
    recordFailure(CITO_PARSER, `${path.split('?')[0]} · ${why}`.slice(0, 160));
    return null;
  } finally {
    save();
  }
}

let busy = false;
/** Called from the 2-minute refresh; asks Cito only when its share of the month says so. */
export async function refreshCito(force = false): Promise<void> {
  if (!citoEnabled() || busy || pauseInfo(CITO_PARSER)) return;
  busy = true;
  try {
    await hydrate();
    const now = Date.now();
    if (!force && now - cache.failedAt < 30 * 60_000) return; // a failure: wait half an hour
    const left = citoLeft();
    if (force || now - cache.upcomingAt >= citoEveryMs(left, 2 / 3, MIN_UPCOMING_MS, now)) {
      const list = await get('/cs2/matches/upcoming?limit=100');
      if (list) {
        // a match that started drops out of «upcoming» before «recent» has it: keep it for 6 h as live
        const ids = new Set(list.map((m) => m.id));
        const carry = cache.upcoming.filter((m) => !ids.has(m.id) && m.startsAt && Date.parse(m.startsAt) <= now && Date.parse(m.startsAt) > now - 6 * H);
        cache.upcoming = [...list, ...carry]; cache.upcomingAt = now; save();
      }
    }
    if (force || now - cache.recentAt >= citoEveryMs(citoLeft(), 1 / 3, MIN_RECENT_MS, now)) {
      const list = await get('/cs2/matches/recent?limit=100');
      if (list) { cache.recent = list; cache.recentAt = now; save(); }
    }
    if (cache.upcomingAt === now || cache.recentAt === now) {
      recordSuccess(CITO_PARSER, `розклад CS2 · ${cache.upcoming.length} майбутніх, ${cache.recent.length} завершених · лишилось ${citoLeft()} запитів`);
    }
  } finally {
    busy = false;
  }
}

const logo = (m: CitoMatch, n: 1 | 2): string | null => {
  const t = m[`team${n}`] as { logoUrl?: string } | undefined;
  const v = m[`team${n}LogoUrl`] ?? m[`team${n}Logo`] ?? t?.logoUrl;
  return typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
};

export function citoToMatch(m: CitoMatch, now = Date.now()): TipsGgMatch | null {
  const t1 = (m.team1Name || '').trim(), t2 = (m.team2Name || '').trim();
  if (!m.id || !m.startsAt || !t1 || !t2 || /^tbd$/i.test(t1) || /^tbd$/i.test(t2)) return null;
  const start = new Date(m.startsAt);
  if (isNaN(start.getTime())) return null;
  const st = String(m.status || '').toLowerCase();
  if (/cancel|postpon|forfeit/.test(st)) return null;
  let status: TipsGgMatch['status'] = /complete|finish|ended|over/.test(st) ? 'finished' : st === 'live' ? 'live' : 'upcoming';
  // the list is up to hours old: started → live, started over 6 h ago → finished
  const since = now - start.getTime();
  if (status !== 'finished') status = since > 6 * H ? 'finished' : since > 0 ? 'live' : status;
  const bo = Number(m.bestOf);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: `ct-${m.id}`,
    date: start.toISOString().slice(0, 10),
    link: '',
    type: [1, 2, 3, 5].includes(bo) ? `BO${bo}` : 'BO3',
    score1: status === 'upcoming' ? null : num(m.team1Score),
    score2: status === 'upcoming' ? null : num(m.team2Score),
    nameTeam1: t1,
    nameTeam2: t2,
    logoTeam1: logo(m, 1),
    logoTeam2: logo(m, 2),
    tournament: (m.eventName || '').trim(),
    stage: '',
    status,
    tipsCount: 0,
    performer: null,
    startDate: start.toISOString(),
    pred1: null,
    pred2: null,
    coeff1: null,
    coeff2: null,
    positionTeam1: null,
    positionTeam2: null,
    tournamentLogo: null,
  };
}

/** Cito's matches from the last answers (no request): finished ones from up to 2 days back, upcoming ones up to 8 days ahead. */
export function citoMatches(now = Date.now()): TipsGgMatch[] {
  if (!citoEnabled()) return [];
  const seen = new Set<string>();
  const out: TipsGgMatch[] = [];
  for (const raw of [...cache.recent, ...cache.upcoming]) {
    const m = citoToMatch(raw, now);
    if (!m || seen.has(m.id)) continue;
    const t = Date.parse(m.startDate);
    if (t < now - 2 * 24 * H || t > now + 8 * 24 * H) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** The cache is loaded and holds a schedule — only then may a cached Cito match missing from the feed be dropped. */
export const citoReady = () => citoEnabled() && hydrated && cache.upcomingAt > 0;

export function citoDiag(): { used: number; left: number; budget: number; upcomingAt: string; recentAt: string; upcoming: number; recent: number; nextAt: string } {
  const left = citoLeft();
  const next = Math.min(cache.upcomingAt + citoEveryMs(left, 2 / 3, MIN_UPCOMING_MS), cache.recentAt + citoEveryMs(left, 1 / 3, MIN_RECENT_MS));
  const iso = (t: number) => (t && Number.isFinite(t) ? new Date(t).toISOString() : '');
  return { used: MONTHLY - left, left, budget: MONTHLY, upcomingAt: iso(cache.upcomingAt), recentAt: iso(cache.recentAt), upcoming: cache.upcoming.length, recent: cache.recent.length, nextAt: iso(next) };
}

export function __setCitoCache(c: Partial<CacheShape>): void { cache = { ...empty(), ...c }; hydrated = true; }
