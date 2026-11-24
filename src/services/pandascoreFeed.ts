// ═══════════════════════════════════════════════════════════════
// PandaScore (pandascore.co) — a second schedule for CS2 and Dota 2 next to Liquipedia.
//   • /{game}/matches/upcoming · /running · /past — matches Liquipedia lacks are added to the feed,
//     a known match only takes what it lacks (score, logos, tournament, tier)
// Free («Fixtures») plan: 1000 requests an hour; we use ~36 (6 lists every 10 min). Only with PANDASCORE_API_KEY.
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';
import { pauseInfo, recordFailure, recordSuccess } from './circuitBreaker';
import { isNight } from './nightMode';
import { isTbd, normalizeTeam } from '../utils/matchUtils';
import { seenCount, seenElsewhere } from './teamNames';

export const PANDASCORE_PARSER = 'pandascore';
const BASE = 'https://api.pandascore.co';
const H = 3_600_000;
const EVERY_MS = Number(process.env.PANDASCORE_EVERY_MIN ?? 10) * 60_000;
/** Tournaments PandaScore ranks «unranked» (showmatches, open qualifiers) are left out unless this is set. */
const WITH_UNRANKED = process.env.PANDASCORE_UNRANKED === '1';
const PATH: Record<Game, string> = { cs2: 'csgo', dota2: 'dota2' };
type Game = 'cs2' | 'dota2';
type List = 'upcoming' | 'running' | 'past';

export const pandascoreEnabled = () => !!process.env.PANDASCORE_API_KEY;

/** The part of a PandaScore match we read. */
export interface PsMatch {
  id: number;
  status?: string | null; // not_started · running · finished · canceled · postponed
  begin_at?: string | null;
  scheduled_at?: string | null;
  number_of_games?: number | null;
  match_type?: string | null;
  forfeit?: boolean | null;
  opponents?: { type?: string; opponent?: { id: number; name?: string | null; acronym?: string | null; image_url?: string | null } }[];
  results?: { team_id?: number; score?: number | null }[];
  tournament?: { name?: string | null; tier?: string | null } | null;
  league?: { name?: string | null; image_url?: string | null } | null;
  serie?: { full_name?: string | null; name?: string | null } | null;
}

interface CacheShape { at: number; failedAt: number; calls: { hour: number; n: number }; recent?: number[]; lists: Record<Game, Record<List, PsMatch[]>> }
const emptyLists = (): Record<Game, Record<List, PsMatch[]>> => ({ cs2: { upcoming: [], running: [], past: [] }, dota2: { upcoming: [], running: [], past: [] } });
let cache: CacheShape = { at: 0, failedAt: 0, calls: { hour: 0, n: 0 }, lists: emptyLists() };
let hydrated = false;
const DB_KEY = 'feed_pandascore_cache';

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (rows[0]?.value) cache = { ...cache, ...JSON.parse(rows[0].value) };
  } catch (e) {
    console.warn('[pandascore] cache ← db failed:', (e as Error).message);
  }
}
function save(): void {
  pool.query(
    `INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DB_KEY, JSON.stringify(cache)],
  ).catch((e) => console.warn('[pandascore] cache → db failed:', (e as Error).message));
}

const QUERY: Record<List, string> = {
  upcoming: 'sort=begin_at&per_page=100&filter[opponents_filled]=true',
  running: 'per_page=50',
  past: 'sort=-begin_at&per_page=100',
};

async function get(game: Game, list: List): Promise<PsMatch[] | null> {
  // calls of the last 60 minutes (a rolling hour — a clock hour showed «0 з 1000» right after :00)
  const now = Date.now();
  cache.recent = (cache.recent || []).filter((t) => now - t < H);
  if (cache.recent.length >= 900) return null; // never near the 1000-an-hour cap
  cache.recent.push(now);
  const path = `/${PATH[game]}/matches/${list}`;
  try {
    const res = await fetch(`${BASE}${path}?${QUERY[list]}`, {
      headers: { authorization: `Bearer ${process.env.PANDASCORE_API_KEY}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} — ключ не прийнято`);
    if (res.status === 429) throw new Error('ліміт запитів на годину вичерпано');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('відповідь без списку матчів');
    return body as PsMatch[];
  } catch (e) {
    const why = (e as Error).name === 'TimeoutError' ? 'не відповів за 20 с' : (e as Error).message;
    console.warn(`[pandascore] ${path} ${why}`);
    recordFailure(PANDASCORE_PARSER, `${path} · ${why}`.slice(0, 160));
    return null;
  }
}

let busy = false;
/** Called from the 2-minute refresh; asks PandaScore every 10 min (6 lists). */
export async function refreshPandaScore(force = false): Promise<void> {
  if (!pandascoreEnabled() || busy || pauseInfo(PANDASCORE_PARSER)) return;
  busy = true;
  try {
    await hydrate();
    const now = Date.now();
    const live = (['cs2', 'dota2'] as Game[]).some((g) => cache.lists[g].running.length > 0);
    const every = isNight() && !live ? Math.max(EVERY_MS, 30 * 60_000) : EVERY_MS;
    if (!force && (now - cache.at < every || now - cache.failedAt < 10 * 60_000)) return;
    let ok = 0, failed = 0;
    for (const game of ['cs2', 'dota2'] as Game[]) {
      for (const list of ['upcoming', 'running', 'past'] as List[]) {
        const got = await get(game, list);
        if (got) { cache.lists[game][list] = got; ok++; } else failed++;
      }
    }
    if (ok) cache.at = now;
    if (failed && !ok) cache.failedAt = now;
    if (ok && now - learnedAt > H) { learnedAt = now; void learnAliases().catch((e) => console.warn('[pandascore] aliases failed:', (e as Error).message)); }
    save();
    if (ok) {
      const n = (g: Game) => cache.lists[g].upcoming.length + cache.lists[g].running.length;
      recordSuccess(PANDASCORE_PARSER, `CS2 ${n('cs2')} · Dota 2 ${n('dota2')} матчів попереду й наживо${failed ? ` · ${failed} із 6 запитів не вдалися` : ''}`);
    }
  } finally {
    busy = false;
  }
}

// ── Team aliases from PandaScore's short names: «PVISION» = «PARIVISION», so the sources' copies of a match meet ──
const tkey = (v: string) => normalizeTeam(v.replace(/\b(e-?sports?|club|clan)\b/gi, ' '));
let learnedAt = 0;
let learnedTotal = 0;

/** Short name → full name pairs worth keeping: 3+ letters, differs from the full name, and is not any other team's name. */
export function aliasPairs(lists: PsMatch[]): { canonical: string; alias: string }[] {
  const teams = new Map<number, { name: string; acronym: string }>();
  for (const m of lists) for (const o of m.opponents || []) {
    const t = o.opponent;
    if (t?.id && t.name && !isTbd(t.name)) teams.set(t.id, { name: t.name.trim(), acronym: (t.acronym || '').trim() });
  }
  const names = new Map<string, number>(); // full-name key → how many teams have it
  for (const t of teams.values()) names.set(tkey(t.name), (names.get(tkey(t.name)) || 0) + 1);
  const acr = new Map<string, number>(); // acronym key → how many teams use it
  for (const t of teams.values()) if (t.acronym) acr.set(tkey(t.acronym), (acr.get(tkey(t.acronym)) || 0) + 1);
  const out: { canonical: string; alias: string }[] = [];
  for (const t of teams.values()) {
    const a = tkey(t.acronym), n = tkey(t.name);
    if (!t.acronym || a.length < 3 || !n || a === n || isTbd(t.acronym)) continue;
    if (names.has(a) || (acr.get(a) || 0) > 1) continue; // another team is called that, or shares the short name
    out.push({ canonical: t.name, alias: t.acronym });
  }
  return out;
}

/** Once an hour: the pairs that join two sources — the short name is how Liquipedia / Cito / OddsPapi write the team
 *  while PandaScore writes the full one (or the other way round) — into team_aliases. Auto pairs no longer needed are
 *  removed (fewer pairs, fewer chances of a wrong one); a pair the admin set is never touched. */
async function learnAliases(): Promise<void> {
  for (const game of ['cs2', 'dota2'] as Game[]) {
    if (!seenCount(game)) continue; // the feed has not been built yet: nothing to compare with
    const l = cache.lists[game];
    // pairs the admin removed earlier («different teams») are never learned again
    const rejected = await pool.query<{ name: string; variant: string }>('SELECT name, variant FROM team_distinct WHERE game = $1', [game])
      .then((r) => new Set(r.rows.map((x) => `${tkey(x.name)}|${tkey(x.variant)}`))).catch(() => new Set<string>());
    const pairs = aliasPairs([...l.upcoming, ...l.running, ...l.past])
      .filter((p) => seenElsewhere(game, p.alias)) // PandaScore writes the full name; the pair helps only where another source writes the short one
      .filter((p) => !rejected.has(`${tkey(p.canonical)}|${tkey(p.alias)}`) && !rejected.has(`${tkey(p.alias)}|${tkey(p.canonical)}`));
    const { rowCount: dropped } = await pool.query(
      `DELETE FROM team_aliases WHERE game = $1 AND created_by = 'auto:pandascore' AND NOT (alias = ANY($2::text[]))`,
      [game, pairs.map((p) => p.alias)],
    );
    if (dropped) console.log(`[pandascore] ${game}: ${dropped} auto team aliases no longer needed — removed`);
    if (!pairs.length) continue;
    const { rowCount } = await pool.query(
      `INSERT INTO team_aliases(game, canonical, alias, created_by)
       SELECT $1, c, a, 'auto:pandascore' FROM unnest($2::text[], $3::text[]) AS t(c, a)
       ON CONFLICT (game, alias) DO NOTHING`,
      [game, pairs.map((p) => p.canonical), pairs.map((p) => p.alias)],
    );
    if (rowCount) { learnedTotal += rowCount; console.log(`[pandascore] ${game}: ${rowCount} team aliases learned`); }
  }
}

const TIER: Record<string, TipsGgMatch['tier']> = { s: 'S', a: 'A', b: 'B', c: 'C', d: 'D' };

export function psToMatch(m: PsMatch, now = Date.now()): TipsGgMatch | null {
  const st = String(m.status || '');
  if (st === 'canceled' || st === 'postponed') return null;
  const teams = (m.opponents || []).filter((o) => o.opponent && (o.type ?? 'Team') === 'Team').map((o) => o.opponent!);
  if (teams.length !== 2) return null;
  const [a, b] = teams;
  const n1 = (a.name || '').trim(), n2 = (b.name || '').trim();
  if (isTbd(n1) || isTbd(n2)) return null;
  const tier = String(m.tournament?.tier || '').toLowerCase();
  if (!WITH_UNRANKED && (!tier || tier === 'unranked')) return null;
  const when = m.begin_at || m.scheduled_at;
  if (!when) return null;
  const start = new Date(when);
  if (isNaN(start.getTime())) return null;
  let status: TipsGgMatch['status'] = st === 'finished' ? 'finished' : st === 'running' ? 'live' : 'upcoming';
  // a list is up to 10 min old: a planned match past its start shows as live (not finished — that comes from /past)
  if (status === 'upcoming' && start.getTime() <= now) status = 'live';
  const score = (id: number) => { const r = (m.results || []).find((x) => x.team_id === id); return typeof r?.score === 'number' ? r.score : null; };
  const bo = Number(m.number_of_games);
  const league = (m.league?.name || '').trim(), serie = (m.serie?.full_name || m.serie?.name || '').trim();
  const logo = (u?: string | null) => (u && /^https:\/\//.test(u) ? u : null);
  return {
    id: `ps-${m.id}`,
    date: start.toISOString().slice(0, 10),
    link: '',
    type: m.match_type === 'best_of' && [1, 2, 3, 5].includes(bo) ? `BO${bo}` : 'BO3',
    ...(m.match_type === 'best_of' && [1, 2, 3, 5].includes(bo) ? {} : { boGuessed: true }),
    score1: status === 'upcoming' ? null : score(a.id),
    score2: status === 'upcoming' ? null : score(b.id),
    nameTeam1: n1,
    nameTeam2: n2,
    logoTeam1: logo(a.image_url),
    logoTeam2: logo(b.image_url),
    tournament: [league, serie && !serie.toLowerCase().includes(league.toLowerCase()) ? serie : ''].filter(Boolean).join(' ') || serie || league,
    stage: (m.tournament?.name || '').trim(),
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
    tournamentLogo: logo(m.league?.image_url),
    tier: TIER[tier] ?? null,
  };
}

/** PandaScore's matches for one game from the last answers (no request): finished up to 2 days back, upcoming up to 8 days ahead. */
export function pandascoreMatches(game: Game, now = Date.now()): TipsGgMatch[] {
  if (!pandascoreEnabled()) return [];
  const seen = new Set<string>();
  const out: TipsGgMatch[] = [];
  const l = cache.lists[game];
  for (const raw of [...l.running, ...l.past, ...l.upcoming]) {
    const m = psToMatch(raw, now);
    if (!m || seen.has(m.id)) continue;
    const t = Date.parse(m.startDate);
    if (t < now - 2 * 24 * H || t > now + 8 * 24 * H) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** The cache is loaded and holds lists — only then may a cached PandaScore match missing from the feed be dropped. */
export const pandascoreReady = () => pandascoreEnabled() && hydrated && cache.at > 0;

/** For the admin card. Reads the saved copy first: after a deploy, with no visitors, the refresh has not run yet. */
/** `waiting` — the next refresh is overdue: the app has no visitors, so the feed refresh sleeps (and asks no one). */
export async function pandascoreDiag(): Promise<{ at: string; nextAt: string; callsThisHour: number; cs2: number; dota2: number; aliases: number; waiting: boolean }> {
  await hydrate();
  const iso = (t: number) => (t ? new Date(t).toISOString() : '');
  const n = (g: Game) => pandascoreMatches(g).length;
  const aliases = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM team_aliases WHERE created_by = 'auto:pandascore'`).then((r) => r.rows[0]?.n ?? 0).catch(() => learnedTotal);
  const every = isNight() ? Math.max(EVERY_MS, 30 * 60_000) : EVERY_MS;
  return { at: iso(cache.at), nextAt: iso(cache.at ? cache.at + every : 0), callsThisHour: (cache.recent || []).filter((t) => Date.now() - t < H).length, cs2: n('cs2'), dota2: n('dota2'), aliases,
    waiting: !!cache.at && Date.now() - cache.at > every + 3 * 60_000 };
}

export function __setPandaScoreCache(lists: Partial<Record<Game, Partial<Record<List, PsMatch[]>>>>): void {
  const l = emptyLists();
  for (const g of ['cs2', 'dota2'] as Game[]) Object.assign(l[g], lists[g] || {});
  cache = { at: Date.now(), failedAt: 0, calls: { hour: 0, n: 0 }, lists: l };
  hydrated = true;
}
