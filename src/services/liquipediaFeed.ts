// ═══════════════════════════════════════════════════════════════
// Liquipedia — schedule, series scores and live / finished state for CS2 and
// Dota 2, from the «Liquipedia:Matches» ticker (upcoming 50 + recent 50).
//
// Liquipedia API terms (https://liquipedia.net/api-terms-of-use):
//   • MediaWiki API only — never the rendered HTML pages;
//   • identifying User-Agent with contact info, Accept-Encoding: gzip;
//   • action=parse at most once per 30 s, other calls once per 2 s;
//   • cache as long as possible; content is CC-BY-SA 3.0 — credit Liquipedia.
// We parse each wiki at most every 5 minutes and serialise all calls through
// one limiter (≥ 31 s apart), so 2 wikis = ≤ 24 calls / hour.
// ═══════════════════════════════════════════════════════════════

import * as cheerio from 'cheerio';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure, recordSuccess, isOpen } from './circuitBreaker';
import type { TipsGgMatch } from './tipsggScraper';

export const LIQUIPEDIA_PARSER = 'liquipedia';
const WIKI: Record<'cs2' | 'dota2', string> = { cs2: 'counterstrike', dota2: 'dota2' };
const REFRESH_MS = Number(process.env.LIQUIPEDIA_REFRESH_MIN || 5) * 60_000;
const PARSE_GAP_MS = 31_000;
const FAIL_BACKOFF_MS = 15 * 60_000;
const USER_AGENT = (process.env.LIQUIPEDIA_USER_AGENT || 'MatchIQ/1.0 (+https://github.com/Vasil-Sh/cs-backend)').trim();
const cacheFile = (game: 'cs2' | 'dota2') => join(process.cwd(), '.cache', `liquipedia_${game}.json`);

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Liquipedia's «Liquipedia:Matches» ticker HTML → matches in the shape the backend uses. */
export function parseTicker(html: string, game: 'cs2' | 'dota2', now = Date.now()): TipsGgMatch[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, TipsGgMatch>();
  $('.match-info').each((_, el) => {
    const b = $(el);
    const timer = b.find('.timer-object').first();
    const ts = Number(timer.attr('data-timestamp'));
    if (!ts) return;
    const opps = b.find('.match-info-header-opponent');
    if (opps.length < 2) return;
    const name = (i: number) => {
      const o = opps.eq(i);
      const title = (o.find('a[title]').first().attr('title') || '').replace(/\s*\(page does not exist\)\s*$/, '').trim();
      return title || o.find('.name').first().text().trim();
    };
    const t1 = name(0), t2 = name(1);
    if (!t1 || !t2 || /^tbd$/i.test(t1) || /^tbd$/i.test(t2)) return;
    const scores = b.find('.match-info-header-scoreholder-score').map((_, s) => Number($(s).text().trim())).get();
    const hasScore = scores.length === 2 && scores.every((n) => Number.isFinite(n));
    const bo = (b.find('.match-info-header-scoreholder-lower').first().text().match(/bo\s*(\d+)/i) || [])[1];
    const finished = timer.attr('data-finished') === 'finished';
    const start = new Date(ts * 1000);
    const status: TipsGgMatch['status'] = finished ? 'finished' : start.getTime() <= now ? 'live' : 'upcoming';
    const date = start.toISOString().slice(0, 10);
    const id = `lp-${game}-${date}-${slug(t1)}-vs-${slug(t2)}`;
    const m: TipsGgMatch = {
      id,
      date,
      link: '',
      type: bo ? `BO${bo}` : 'BO3',
      score1: hasScore ? scores[0] : null,
      score2: hasScore ? scores[1] : null,
      nameTeam1: t1,
      nameTeam2: t2,
      logoTeam1: null,
      logoTeam2: null,
      tournament: b.find('.match-info-tournament-name').first().text().trim(),
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
    // the page lists a match in both «upcoming» and «recent» around its start — keep the most advanced copy
    const prev = seen.get(id);
    const rank = (x: TipsGgMatch) => (x.status === 'finished' ? 2 : x.status === 'live' ? 1 : 0);
    if (!prev || rank(m) >= rank(prev)) seen.set(id, m);
  });
  return [...seen.values()].sort((a, z) => a.startDate.localeCompare(z.startDate));
}

// ── One limiter for every Liquipedia call ──
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
function limited<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + PARSE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

interface Cached { at: number; data: TipsGgMatch[] }
const mem: Partial<Record<'cs2' | 'dota2', Cached>> = {};
const failedAt: Partial<Record<'cs2' | 'dota2', number>> = {};
const inflight: Partial<Record<'cs2' | 'dota2', Promise<TipsGgMatch[]>>> = {};

function readCache(game: 'cs2' | 'dota2'): Cached | null {
  if (mem[game]) return mem[game]!;
  try {
    const f = cacheFile(game);
    if (existsSync(f)) return (mem[game] = JSON.parse(readFileSync(f, 'utf-8')) as Cached);
  } catch { /* corrupt — refetch */ }
  return null;
}
function writeCache(game: 'cs2' | 'dota2', data: TipsGgMatch[]): void {
  mem[game] = { at: Date.now(), data };
  try {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(cacheFile(game), JSON.stringify(mem[game]));
  } catch { /* memory copy is enough */ }
}

async function fetchTicker(game: 'cs2' | 'dota2'): Promise<TipsGgMatch[] | null> {
  const url = `https://liquipedia.net/${WIKI[game]}/api.php?${new URLSearchParams({ action: 'parse', page: 'Liquipedia:Matches', format: 'json', prop: 'text', formatversion: '2' })}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { console.warn(`[liquipedia] ${game} → HTTP ${res.status}`); return null; }
    const json: any = await res.json();
    if (json?.error) { console.warn(`[liquipedia] ${game} → ${json.error.code}: ${json.error.info}`); return null; }
    const html: string = typeof json?.parse?.text === 'string' ? json.parse.text : json?.parse?.text?.['*'] || '';
    const list = parseTicker(html, game);
    if (!list.length) { console.warn(`[liquipedia] ${game} → 0 matches parsed (page layout changed?)`); return null; }
    return list;
  } catch (e) {
    console.warn(`[liquipedia] ${game} failed:`, (e as Error).message);
    return null;
  }
}

/** Matches for one game: from cache when fresher than 5 min, otherwise one (rate-limited) API call. */
export async function fetchLiquipediaMatches(game: 'cs2' | 'dota2'): Promise<TipsGgMatch[]> {
  const cached = readCache(game);
  const fresh = cached && Date.now() - cached.at < REFRESH_MS;
  if (fresh || isOpen(LIQUIPEDIA_PARSER) || Date.now() - (failedAt[game] || 0) < FAIL_BACKOFF_MS) return withTimeStatus(cached?.data || []);
  if (!inflight[game]) {
    inflight[game] = limited(() => fetchTicker(game)).then((list) => {
      if (list) { writeCache(game, list); recordSuccess(LIQUIPEDIA_PARSER); delete failedAt[game]; return list; }
      failedAt[game] = Date.now();
      recordFailure(LIQUIPEDIA_PARSER);
      return cached?.data || [];
    }).finally(() => { delete inflight[game]; });
  }
  return withTimeStatus(await inflight[game]!);
}

/** Cached copy is up to 5 min old: an upcoming match whose time has come is live.
 *  «Finished» only ever comes from Liquipedia itself — never guessed — because bets settle on it. */
function withTimeStatus(list: TipsGgMatch[]): TipsGgMatch[] {
  const now = Date.now();
  return list.map((m) => (m.status === 'upcoming' && Date.parse(m.startDate) <= now ? { ...m, status: 'live' as const } : m));
}
