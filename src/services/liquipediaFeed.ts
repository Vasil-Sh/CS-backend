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
// The ticker holds only 50 upcoming matches per wiki, so the pages of the tournaments it shows are
// read too (≤ 2 per wiki every 20 min, each page at most hourly): their full group and playoff
// schedule adds the matches the ticker had no room for.
// ═══════════════════════════════════════════════════════════════

import * as cheerio from 'cheerio';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFailure, recordSuccess, isOpen } from './circuitBreaker';
import { isTbd, mergeSameTimeDuplicates, normalizeTeam } from '../utils/matchUtils';
import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';
import { isNight } from './nightMode';

export const LIQUIPEDIA_PARSER = 'liquipedia';
const WIKI: Record<'cs2' | 'dota2', string> = { cs2: 'counterstrike', dota2: 'dota2' };
const REFRESH_MS = Number(process.env.LIQUIPEDIA_REFRESH_MIN || 5) * 60_000;
const PARSE_GAP_MS = 31_000;
const NIGHT_REFRESH_MS = 15 * 60_000;
const FAIL_BACKOFF_MS = 15 * 60_000;
/** Right after a start (a deploy) the schedule restored from Postgres is served for a few minutes before the first call —
 *  frequent deploys then do not hit Liquipedia's rate limit (the failures at 13:44 on 23.11). Only when there is a saved copy. */
const START_DELAY_MS = Number(process.env.LIQUIPEDIA_START_DELAY_MIN ?? 3) * 60_000;
const STARTED_AT = Date.now();
const USER_AGENT = (process.env.LIQUIPEDIA_USER_AGENT || 'MatchIQ/1.0 (+https://github.com/Vasil-Sh/cs-backend)').trim();
const cacheFile = (game: 'cs2' | 'dota2') => join(process.cwd(), '.cache', `liquipedia_${game}.json`);

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Absolute URL of a Liquipedia image (src is «/commons/images/…» or protocol-relative). */
export function lpUrl(src: string | undefined): string | null {
  if (!src || /filler|placeholder|logo_?unknown|Logo_filler/i.test(src)) return null;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `https://liquipedia.net${src}`;
  return /^https?:\/\//.test(src) ? src : null;
}

/** Stage from the tournament page path: «PGL/2026/Singapore/Stage_1» → «Stage 1», «…/Playoffs» → «Playoffs».
 *  Only the last part, and only when it names a stage (not the event, city or year). */
export function stageOf(page: string | undefined): string {
  const last = (page || '').split('/').filter(Boolean).slice(1).pop() || '';
  return /stage|playoff|group|swiss|main_event|qualifier|play-in|knockout|final|regular|opening|elimination|decider|last_chance|round|week|day_\d/i.test(last)
    ? last.replace(/_/g, ' ').trim() : '';
}

const TIERS = ['S', 'A', 'B', 'C', 'D'] as const;
/** Liquipedia tier of a ticker card: its filter category (1…5) on the card or a wrapper, or a «Tier N» label. */
export function tierOf($: cheerio.CheerioAPI, el: any): TipsGgMatch['tier'] {
  const holder = $(el).closest('[data-filter-category]');
  const raw = holder.attr('data-filter-category') || $(el).attr('data-liquipediatier') || $(el).find('[data-liquipediatier]').first().attr('data-liquipediatier')
    || ($(el).text().match(/\btier\s*([1-5])\b/i) || [])[1] || '';
  const n = Number(String(raw).match(/[1-5]/)?.[0]);
  return n >= 1 && n <= 5 ? TIERS[n - 1] : null;
}

const CS_MAPS = ['Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Dust2', 'Dust II', 'Train', 'Overpass', 'Vertigo', 'Cache', 'Cobblestone', 'Tuscan', 'Office', 'Italy'];
/** Map-by-map scores on a Liquipedia match page: each map name with the two numbers in its row (team1 first). */
export function parseMaps(html: string): { map: string; score1: number | null; score2: number | null }[] {
  const $ = cheerio.load(html);
  const out: { map: string; score1: number | null; score2: number | null }[] = [];
  const seen = new Set<string>();
  $('a[title], span, div').each((_, el) => {
    const own = $(el).children().length === 0 || el.tagName === 'a' ? ($(el).attr('title') || $(el).text()).trim() : '';
    const map = CS_MAPS.find((x) => x.toLowerCase() === own.toLowerCase());
    if (!map) return;
    // climb to the row that holds this map and its two scores, but not another map
    let row = $(el).parent();
    for (let i = 0; i < 4 && row.length; i++, row = row.parent()) {
      const txt = row.text();
      if (CS_MAPS.filter((x) => new RegExp(`\\b${x}\\b`, 'i').test(txt)).length > 1) return;
      const nums = txt.replace(new RegExp(map, 'gi'), ' ').match(/\b\d{1,2}\b/g);
      if (nums && nums.length >= 2) {
        const key = `${map}:${out.length}`;
        const [a, b] = nums.slice(0, 2).map(Number);
        if (a <= 40 && b <= 40 && !seen.has(row.html() || key)) { seen.add(row.html() || key); out.push({ map, score1: a, score2: b }); }
        return;
      }
    }
  });
  return out;
}

/** Liquipedia's «Liquipedia:Matches» ticker HTML → matches in the shape the backend uses.
 *  Two layouts: the older «match-info» blocks and the 2026 «match-ticker-card» cards. */
export function parseTicker(html: string, game: 'cs2' | 'dota2', now = Date.now()): TipsGgMatch[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, TipsGgMatch>();
  $('.match-info, .match-ticker-card').each((_, el) => {
    const b = $(el);
    if (b.parents('.match-ticker-card').length) return; // a .match-info inside a card — the card is parsed itself
    const timer = b.find('.timer-object').first();
    const ts = Number(timer.attr('data-timestamp'));
    if (!ts) return;
    const opps = b.find('.match-info-header-opponent, .match-ticker-card__opponent');
    if (opps.length < 2) return;
    const name = (i: number) => {
      const o = opps.eq(i);
      const title = (o.find('a[title]').first().attr('title') || '').replace(/\s*\(page does not exist\)\s*$/, '').trim();
      return title || o.find('.team-name, .name').first().text().trim();
    };
    const t1 = name(0), t2 = name(1);
    // team logo: the light-mode icon when the page carries both, else the first image
    const logo = (i: number) => {
      const o = opps.eq(i);
      const im = o.find('.team-template-lightmode img').first().length ? o.find('.team-template-lightmode img').first() : o.find('img').first();
      return lpUrl(im.attr('src') || im.attr('data-src'));
    };
    const tourBox = b.find('.match-info-tournament, .match-ticker-card-tournament').first();
    const tourHref = tourBox.find('a[href]').first().attr('href') || '';
    const tourPage = decodeURIComponent(tourHref.replace(/^.*?\/(counterstrike|dota2)\//, '').split('#')[0]);
    const matchHref = decodeURIComponent((b.find('a[href*="Match:"]').first().attr('href') || '').replace(/^.*?\/(counterstrike|dota2)\//, '').split('#')[0]);
    if (isTbd(t1) || isTbd(t2)) return;
    // series score: old layout has two .match-info-header-scoreholder-score; the card layout keeps
    // a score element per opponent (any class with «score» in it) — read whichever is there
    let scores = b.find('.match-info-header-scoreholder-score').map((_, x) => Number($(x).text().trim())).get();
    if (scores.length !== 2) {
      // card layout: <div class="match-ticker-card__opponent"><div class="block-team">…</div><div>2</div></div>
      scores = [0, 1].map((i) => {
        const o = opps.eq(i);
        const x = o.children().not('.block-team').last();
        const t = (x.length ? x : o.find('[class*="score"]').last()).text().trim();
        return /^\d+$/.test(t) ? Number(t) : NaN;
      });
    }
    if (scores.some((n) => !Number.isFinite(n))) {
      const sc = b.find('[class*="score"]').filter((_, x) => /^\d+\s*[:\-–]\s*\d+$/.test($(x).text().trim())).first().text().trim();
      const mm = sc.match(/^(\d+)\s*[:\-–]\s*(\d+)$/);
      if (mm) scores = [Number(mm[1]), Number(mm[2])];
    }
    const hasScore = scores.length === 2 && scores.every((n) => Number.isFinite(n));
    const bo = (b.find('.match-info-header-scoreholder-lower').first().text().match(/bo\s*(\d+)/i)
      || b.text().match(/\(\s*bo\s*(\d+)\s*\)|\bbo(\d)\b/i) || []).slice(1).find(Boolean);
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
      ...(bo ? {} : { boGuessed: true }),
      score1: hasScore ? scores[0] : null,
      score2: hasScore ? scores[1] : null,
      nameTeam1: t1,
      nameTeam2: t2,
      logoTeam1: logo(0),
      logoTeam2: logo(1),
      tournament: b.find('.match-info-tournament-name, .match-ticker-card-tournament-name').first().text().trim(),
      stage: stageOf(tourPage),
      tier: tierOf($, el),
      ...(matchHref ? { matchPage: matchHref } : {}),
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
      tournamentLogo: lpUrl(tourBox.find('img').first().attr('src')),
      ...(tourPage && !/^https?:/.test(tourPage) ? { tournamentPage: tourPage } : {}),
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
const noScore = (m: TipsGgMatch) => m.status === 'finished' && (m.score1 == null || m.score2 == null);

function writeCache(game: 'cs2' | 'dota2', fresh: TipsGgMatch[]): TipsGgMatch[] {
  // The ticker drops a match soon after it ends: keep today's finished ones we already had, so «матчів сьогодні» does not shrink —
  // and finished ones still without a score (up to 36 h), so the score lookup below can fill them in
  const today = new Date().toISOString().slice(0, 10);
  const ids = new Set(fresh.map((m) => m.id));
  const old = new Map((mem[game]?.data || []).map((m) => [m.id, m]));
  const kept = [...old.values()].filter((m) => !ids.has(m.id) && m.status === 'finished' && (m.date === today || (noScore(m) && Date.parse(m.startDate) > Date.now() - 36 * 3_600_000)));
  // a score found on the tournament page stays while the ticker still shows the match without one
  for (const m of fresh) {
    const o = old.get(m.id);
    if (noScore(m) && o && !noScore(o)) { m.score1 = o.score1; m.score2 = o.score2; }
    if (o?.maps && !m.maps) m.maps = o.maps; // map scores come from the match page, not the ticker
  }
  const data = kept.length ? [...fresh, ...kept].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate)) : fresh;
  return persist(game, data);
}

function persist(game: 'cs2' | 'dota2', data: TipsGgMatch[], at = Date.now()): TipsGgMatch[] {
  mem[game] = { at, data };
  try {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(cacheFile(game), JSON.stringify(mem[game]));
  } catch { /* memory copy is enough */ }
  // Railway's disk is wiped on every deploy: keep a copy in Postgres too, so a failed first fetch after a deploy
  // still shows the last schedule (not just OddsPapi's few matches)
  pool.query(
    `INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DB_KEY(game), JSON.stringify(mem[game])],
  ).catch((e) => console.warn(`[liquipedia] ${game} cache → db failed:`, (e as Error).message));
  return data;
}

const DB_KEY = (game: 'cs2' | 'dota2') => `feed_liquipedia_${game}`;
const hydrated: Partial<Record<'cs2' | 'dota2', boolean>> = {};
/** On the first call after start: the copy in Postgres when it is newer than the local file (or there is none). */
async function hydrate(game: 'cs2' | 'dota2'): Promise<void> {
  if (hydrated[game]) return;
  hydrated[game] = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY(game)]);
    if (!rows[0]?.value) return;
    const db = JSON.parse(rows[0].value) as Cached;
    const local = readCache(game);
    if (Array.isArray(db?.data) && (!local || db.at > local.at)) {
      mem[game] = db;
      console.log(`[liquipedia] ${game}: ${db.data.length} matches restored from db (${Math.round((Date.now() - db.at) / 60000)} min old)`);
    }
  } catch (e) {
    console.warn(`[liquipedia] ${game} cache ← db failed:`, (e as Error).message);
  }
}

/** Why a page gave 0 matches: size and the most frequent CSS classes, so a layout change can be fixed from the log. */
function describeHtml(html: string): string {
  const freq = new Map<string, number>();
  for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) freq.set(c, (freq.get(c) || 0) + 1);
  const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([c, n]) => `${c}:${n}`).join(' ');
  return `len=${html.length} match-info=${(html.match(/match-info"/g) || []).length} timer=${(html.match(/timer-object/g) || []).length} | ${top} | head=${html.slice(0, 200).replace(/\s+/g, ' ')}`;
}

let sampled = false;
/** Once per start: one finished card's markup (images stripped) and what we read from it — to check scores / BO. */
function logSampleOnce(html: string, game: string, list: TipsGgMatch[]): void {
  if (sampled || !list.length) return;
  sampled = true;
  const $ = cheerio.load(html);
  const card = $('.match-ticker-card').filter((_, x) => $(x).find('[data-finished="finished"]').length > 0).first();
  const fin = list.filter((m) => m.status === 'finished');
  console.log(`[liquipedia] ${game}: ${list.length} matches (${fin.length} finished, ${fin.filter((m) => m.score1 != null).length} with score) · e.g. ${JSON.stringify(fin[0] ? [fin[0].nameTeam1, fin[0].score1, fin[0].score2, fin[0].nameTeam2, fin[0].type] : null)}`);
  if (card.length) console.log(`[liquipedia] sample card: ${($.html(card) || '').replace(/<img[^>]*>/g, '<img>').replace(/\s+/g, ' ').slice(0, 1800)}`);
}

/** Pages that carry the match ticker, tried in order (Liquipedia has renamed it before). */
const TICKER_PAGES = ['Liquipedia:Matches', 'Liquipedia:Upcoming_and_ongoing_matches'];

type PageResult = { list: TipsGgMatch[] } | { why: string; transient: boolean };

/** One run: the ticker page, the same page once more after the 31 s gap when the failure looked
 *  temporary (timeout, 429, 5xx), then the older page name. Returns the matches or why it failed. */
async function fetchTicker(game: 'cs2' | 'dota2'): Promise<{ list: TipsGgMatch[] | null; why: string }> {
  // runs inside limited(): every further request waits the 31 s gap here (calling limited() again would wait on itself)
  const gap = async () => { await new Promise((r) => setTimeout(r, PARSE_GAP_MS)); lastCall = Date.now(); };
  let why = '';
  for (let i = 0; i < TICKER_PAGES.length; i++) {
    if (i > 0) await gap();
    let r = await fetchPage(game, TICKER_PAGES[i]);
    if ('why' in r && r.transient) { console.warn(`[liquipedia] ${game}: ${r.why} — retrying in ${PARSE_GAP_MS / 1000} s`); await gap(); r = await fetchPage(game, TICKER_PAGES[i]); }
    if ('list' in r) return { list: r.list, why: '' };
    why ||= r.why;
  }
  return { list: null, why };
}

async function fetchPage(game: 'cs2' | 'dota2', page: string): Promise<PageResult> {
  const url = `https://liquipedia.net/${WIKI[game]}/api.php?${new URLSearchParams({ action: 'parse', page, format: 'json', prop: 'text' })}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { console.warn(`[liquipedia] ${game} ${page} → HTTP ${res.status}`); return { why: `HTTP ${res.status}`, transient: res.status === 429 || res.status >= 500 }; }
    const json: any = await res.json();
    if (json?.error) { console.warn(`[liquipedia] ${game} ${page} → ${json.error.code}: ${json.error.info}`); return { why: `API: ${json.error.code}`, transient: false }; }
    const html: string = typeof json?.parse?.text === 'string' ? json.parse.text : json?.parse?.text?.['*'] || '';
    const list = parseTicker(html, game);
    logSampleOnce(html, game, list);
    if (!list.length) { console.warn(`[liquipedia] ${game} ${page} → 0 matches parsed: ${describeHtml(html)}`); return { why: 'сторінка без матчів', transient: false }; }
    return { list };
  } catch (e) {
    const m = (e as Error).message;
    console.warn(`[liquipedia] ${game} ${page} failed:`, m);
    return { why: /timeout|aborted/i.test(m) ? 'немає відповіді 30 с' : `мережа: ${m.slice(0, 80)}`, transient: true };
  }
}

/** «CS2 · 48 матчів · 3 live · 20 завершено» — the run's line in the admin log. */
export function runSummary(game: 'cs2' | 'dota2', list: TipsGgMatch[]): string {
  const live = list.filter((m) => m.status === 'live').length, fin = list.filter((m) => m.status === 'finished').length;
  const n = list.length, w = n % 10 === 1 && n % 100 !== 11 ? 'матч' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'матчі' : 'матчів';
  const tier = list.filter((m) => m.tier).length, stage = list.filter((m) => m.stage).length;
  return `${game === 'cs2' ? 'CS2' : 'Dota 2'} · ${n} ${w}${live ? ` · ${live} live` : ''}${fin ? ` · ${fin} завершено` : ''} · тир у ${tier}, стадія у ${stage}`;
}

// ── Final score for finished matches the ticker left at «—:—» ──
const BACKFILL_EVERY_MS = 60 * 60_000;
const BACKFILL_AFTER_MS = 3 * 3_600_000; // started 3 h ago → over for about an hour
const BACKFILL_PAGES = 3; // per run: each page waits the 31 s gap
const lastBackfill: Partial<Record<'cs2' | 'dota2', number>> = {};
const tk = (v: string) => normalizeTeam(v.replace(/\b(e-?sports?|club|clan)\b/gi, ' '));

/** Results on a tournament page: bracket matches and group match lists → team names and series score. */
export function parseResults(html: string): { team1: string; team2: string; score1: number; score2: number }[] {
  const $ = cheerio.load(html);
  const out: { team1: string; team2: string; score1: number; score2: number }[] = [];
  $('.brkts-match, .brkts-matchlist-match, .match-row, .bracket-game').each((_, el) => {
    const opps = $(el).find('.brkts-opponent-entry, .brkts-matchlist-opponent, .bracket-team-top, .bracket-team-bottom');
    if (opps.length < 2) return;
    const side = (i: number) => {
      const o = opps.eq(i);
      const name = (o.attr('aria-label') || o.find('[data-highlightingclass]').first().attr('data-highlightingclass') || o.attr('data-highlightingclass')
        || o.find('a[title]').first().attr('title') || o.find('.name, .team-template-text').first().text() || '').replace(/\s*\(page does not exist\)\s*$/, '').trim();
      const scoreEl = o.find('.brkts-opponent-score-inner, .brkts-matchlist-score, .bracket-score').first();
      const sc = (scoreEl.length ? scoreEl : o.siblings('.brkts-matchlist-score').eq(i)).text().trim();
      return { name, score: /^\d+$/.test(sc) ? Number(sc) : NaN };
    };
    const a = side(0), b = side(1);
    if (!a.name || !b.name || !Number.isFinite(a.score) || !Number.isFinite(b.score) || a.score + b.score === 0) return;
    out.push({ team1: a.name, team2: b.name, score1: a.score, score2: b.score });
  });
  return out;
}

/** Once an hour: finished matches still without a score, looked up on their tournament page (≤ 3 pages a run). */
async function backfillScores(game: 'cs2' | 'dota2'): Promise<void> {
  if (Date.now() - (lastBackfill[game] || 0) < BACKFILL_EVERY_MS || isOpen(LIQUIPEDIA_PARSER)) return;
  const data = mem[game]?.data || [];
  const todo = data.filter((m) => noScore(m) && m.tournamentPage && Date.parse(m.startDate) < Date.now() - BACKFILL_AFTER_MS);
  if (!todo.length) return;
  lastBackfill[game] = Date.now();
  const pages = [...new Set(todo.map((m) => m.tournamentPage!))].slice(0, BACKFILL_PAGES);
  let filled = 0;
  for (const page of pages) {
    const url = `https://liquipedia.net/${WIKI[game]}/api.php?${new URLSearchParams({ action: 'parse', page, format: 'json', prop: 'text' })}`;
    const html = await limited(async () => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return '';
        const json: any = await res.json();
        return typeof json?.parse?.text === 'string' ? json.parse.text : json?.parse?.text?.['*'] || '';
      } catch { return ''; }
    });
    const results = html ? parseResults(html) : [];
    if (html && !results.length) console.warn(`[liquipedia] ${game} ${page}: no results parsed — ${describeHtml(html)}`);
    for (const m of todo.filter((x) => x.tournamentPage === page)) {
      const a = tk(m.nameTeam1), b = tk(m.nameTeam2);
      const r = results.find((x) => (tk(x.team1) === a && tk(x.team2) === b) || (tk(x.team1) === b && tk(x.team2) === a));
      if (!r) continue;
      const same = tk(r.team1) === a;
      m.score1 = same ? r.score1 : r.score2;
      m.score2 = same ? r.score2 : r.score1;
      filled++;
    }
  }
  if (filled) {
    persist(game, data, mem[game]?.at);
    recordSuccess(LIQUIPEDIA_PARSER, `${game === 'cs2' ? 'CS2' : 'Dota 2'} · рахунок дібрано зі сторінок турнірів · ${filled} з ${todo.length}`);
  }
  console.log(`[liquipedia] ${game}: score backfill — ${filled} of ${todo.length} from ${pages.length} pages`);
}

// ── Tournament pages: the full schedule of the tournaments the ticker shows ──
const PAGES_EVERY_MS = 20 * 60_000;
const PAGE_MIN_AGE_MS = 60 * 60_000;
const PAGES_PER_RUN = 2;
interface PageCache { at: number; matches: TipsGgMatch[] }
const pageStore: Record<'cs2' | 'dota2', Record<string, PageCache>> = { cs2: {}, dota2: {} };
const lastPages: Partial<Record<'cs2' | 'dota2', number>> = {};
const pagesAdded: Record<'cs2' | 'dota2', number> = { cs2: 0, dota2: 0 };
const PAGES_DB_KEY = (game: 'cs2' | 'dota2') => `feed_liquipedia_pages_${game}`;
const pagesHydrated: Partial<Record<'cs2' | 'dota2', boolean>> = {};

async function hydratePages(game: 'cs2' | 'dota2'): Promise<void> {
  if (pagesHydrated[game]) return;
  pagesHydrated[game] = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [PAGES_DB_KEY(game)]);
    if (rows[0]?.value) pageStore[game] = JSON.parse(rows[0].value);
  } catch { /* start empty */ }
}

/** Matches on a tournament page (brackets and group match lists). Only matches with a start time and two named teams.
 *  «Finished» only when the page marks it so (bets settle on it); a score is kept for live and finished ones. */
export function parseSchedule(html: string, game: 'cs2' | 'dota2', page: string, meta: Partial<TipsGgMatch> = {}, now = Date.now()): TipsGgMatch[] {
  const $ = cheerio.load(html);
  const out = new Map<string, TipsGgMatch>();
  const add = (m: TipsGgMatch) => { const prev = out.get(m.id); if (!prev || (m.status === 'finished' && prev.status !== 'finished')) out.set(m.id, m); };
  // the newer layout reuses the ticker's «match-info» blocks inside the bracket popups
  for (const m of parseTicker(html, game, now)) add({ ...m, fromPage: true, tournament: m.tournament || meta.tournament || '', tier: m.tier ?? meta.tier ?? null, tournamentLogo: m.tournamentLogo || meta.tournamentLogo || null, tournamentPage: page, stage: m.stage || stageOf(page) });
  $('.brkts-match, .brkts-matchlist-match').each((_, el) => {
    const b = $(el);
    const timer = b.find('.timer-object[data-timestamp]').first();
    const ts = Number(timer.attr('data-timestamp'));
    if (!ts) return;
    const opps = b.find('.brkts-opponent-entry, .brkts-matchlist-opponent').filter((_, x) => !$(x).parents('.brkts-popup, .brkts-match-info-popup').length);
    if (opps.length < 2) return;
    const side = (i: number) => {
      const o = opps.eq(i);
      const name = (o.find('a[title]').first().attr('title') || o.attr('aria-label') || o.find('[data-highlightingclass]').first().attr('data-highlightingclass')
        || o.find('.name, .team-template-text').first().text() || '').replace(/\s*\(page does not exist\)\s*$/, '').trim();
      const scoreEl = o.find('.brkts-opponent-score-inner, .brkts-matchlist-score').first();
      const sc = (scoreEl.length ? scoreEl : o.siblings('.brkts-matchlist-score').eq(i)).text().trim();
      const im = o.find('.team-template-lightmode img').first().length ? o.find('.team-template-lightmode img').first() : o.find('img').first();
      return { name, score: /^\d+$/.test(sc) ? Number(sc) : null, logo: lpUrl(im.attr('src') || im.attr('data-src')) };
    };
    const a = side(0), z = side(1);
    if (isTbd(a.name) || isTbd(z.name)) return;
    const start = new Date(ts * 1000);
    const finished = timer.attr('data-finished') === 'finished';
    const status: TipsGgMatch['status'] = finished ? 'finished' : start.getTime() <= now ? 'live' : 'upcoming';
    const bo = (b.text().match(/\(\s*bo\s*(\d)\s*\)|\bbo\s*(\d)\b/i) || []).slice(1).find(Boolean);
    const hasScore = status !== 'upcoming' && a.score != null && z.score != null;
    const date = start.toISOString().slice(0, 10);
    const matchHref = decodeURIComponent((b.find('a[href*="Match:"]').first().attr('href') || '').replace(/^.*?\/(counterstrike|dota2)\//, '').split('#')[0]);
    add({
      id: `lp-${game}-${date}-${slug(a.name)}-vs-${slug(z.name)}`,
      date,
      link: '',
      type: bo ? `BO${bo}` : meta.type || 'BO3',
      ...(bo ? {} : { boGuessed: true }),
      score1: hasScore ? a.score : null,
      score2: hasScore ? z.score : null,
      nameTeam1: a.name,
      nameTeam2: z.name,
      logoTeam1: a.logo,
      logoTeam2: z.logo,
      tournament: meta.tournament || '',
      stage: stageOf(page),
      tier: meta.tier ?? null,
      ...(matchHref ? { matchPage: matchHref } : {}),
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
      tournamentLogo: meta.tournamentLogo || null,
      tournamentPage: page,
      fromPage: true,
    });
  });
  return [...out.values()].sort((x, y) => x.startDate.localeCompare(y.startDate));
}

/** Every 20 min: the 2 tournament pages read longest ago among the tournaments the ticker shows as upcoming or live
 *  (the higher tier first), each page at most once an hour. */
async function refreshPages(game: 'cs2' | 'dota2'): Promise<void> {
  if ((await loadPagesMode()) === 'off' || isNight() || Date.now() - (lastPages[game] || 0) < PAGES_EVERY_MS || isOpen(LIQUIPEDIA_PARSER)) return;
  lastPages[game] = Date.now();
  await hydratePages(game);
  const data = mem[game]?.data || [];
  const rank = (t?: TipsGgMatch['tier']) => (t ? 'SABCD'.indexOf(t) : 5);
  const byPage = new Map<string, TipsGgMatch>();
  for (const m of data) if (m.tournamentPage && m.status !== 'finished' && !byPage.has(m.tournamentPage)) byPage.set(m.tournamentPage, m);
  const store = pageStore[game];
  for (const k of Object.keys(store)) if (!byPage.has(k) && Date.now() - store[k].at > 2 * 24 * 3_600_000) delete store[k]; // tournament over
  const due = [...byPage.entries()]
    .filter(([p]) => Date.now() - (store[p]?.at || 0) >= PAGE_MIN_AGE_MS)
    .sort(([pa, a], [pb, z]) => (store[pa]?.at || 0) - (store[pb]?.at || 0) || rank(a.tier) - rank(z.tier))
    .slice(0, PAGES_PER_RUN);
  let got = 0, pages = 0;
  for (const [page, sample] of due) {
    const url = `https://liquipedia.net/${WIKI[game]}/api.php?${new URLSearchParams({ action: 'parse', page, format: 'json', prop: 'text' })}`;
    const html = await limited(async () => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return '';
        const json: any = await res.json();
        return typeof json?.parse?.text === 'string' ? json.parse.text : json?.parse?.text?.['*'] || '';
      } catch { return ''; }
    });
    if (!html) continue;
    const list = parseSchedule(html, game, page, { tournament: sample.tournament, tier: sample.tier, tournamentLogo: sample.tournamentLogo, type: sample.type });
    if (!list.length) console.warn(`[liquipedia] ${game} ${page}: no scheduled matches parsed — ${describeHtml(html)}`);
    store[page] = { at: Date.now(), matches: list };
    got += list.length; pages++;
  }
  if (!pages) return;
  pool.query(
    `INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PAGES_DB_KEY(game), JSON.stringify(store)],
  ).catch(() => {});
  console.log(`[liquipedia] ${game}: tournament pages — ${got} matches on ${pages} pages`);
}

/** The ticker's matches plus the ones only the tournament pages have (same teams within 6 h = the same match). */
/** How the tournament pages agree with the ticker on the matches both have (start within 15 min, same BO) — the pages'
 *  parser was written without a live page to test on, so it is checked against the ticker on every build. */
const pageCheck: Record<'cs2' | 'dota2', { checked: number; agreed: number; off: string[] }> = { cs2: { checked: 0, agreed: 0, off: [] }, dota2: { checked: 0, agreed: 0, off: [] } };
/** Below this share of agreement (over at least 5 matches) the pages add nothing: they are probably read wrong. */
const PAGE_TRUST = 0.7;
const pagesTrusted = (c: { checked: number; agreed: number }) => c.checked < 5 || c.agreed / c.checked >= PAGE_TRUST;

/** The admin's say on tournament pages: «auto» (added while they agree with the ticker), «on» (always), «off» (never read). */
export type PagesMode = 'auto' | 'on' | 'off';
const MODE_KEY = 'liquipedia_pages_mode';
let pagesMode: { mode: PagesMode; at: number } = { mode: 'auto', at: 0 };
async function loadPagesMode(): Promise<PagesMode> {
  if (Date.now() - pagesMode.at < 60_000) return pagesMode.mode;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [MODE_KEY]);
    const v = rows[0]?.value;
    pagesMode = { mode: v === 'on' || v === 'off' ? v : 'auto', at: Date.now() };
  } catch { pagesMode = { ...pagesMode, at: Date.now() }; }
  return pagesMode.mode;
}
export async function setPagesMode(mode: PagesMode): Promise<void> {
  await pool.query(`INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [MODE_KEY, mode]);
  pagesMode = { mode, at: Date.now() };
  if (mode !== 'off') { delete lastPages.cs2; delete lastPages.dota2; }
}

/** The ticker's matches plus the ones only the tournament pages have (same teams within 6 h = the same match). */
function withPages(game: 'cs2' | 'dota2', ticker: TipsGgMatch[], now = Date.now()): TipsGgMatch[] {
  const ids = new Set(ticker.map((m) => m.id));
  const byId = new Map(ticker.map((m) => [m.id, m]));
  const extra: TipsGgMatch[] = [];
  const check = { checked: 0, agreed: 0, off: [] as string[] };
  const compare = (p: TipsGgMatch, x: TipsGgMatch) => {
    // the ticker card often has no «Bo»: its «BO3» is our guess — the page's real one replaces it, and a guess is no disagreement
    if (x.boGuessed && !p.boGuessed) { x.type = p.type; delete x.boGuessed; }
    const okTime = Math.abs(Date.parse(p.startDate) - Date.parse(x.startDate)) <= 15 * 60_000;
    const okBo = p.boGuessed || x.boGuessed || p.type === x.type;
    check.checked++;
    if (okTime && okBo) check.agreed++;
    else if (check.off.length < 5) check.off.push(`${x.nameTeam1} — ${x.nameTeam2}: ${okTime ? '' : `час ${p.startDate.slice(11, 16)} проти ${x.startDate.slice(11, 16)} UTC`}${!okTime && !okBo ? ', ' : ''}${okBo ? '' : `${p.type} проти ${x.type}`}`);
  };
  for (const pc of Object.values(pageStore[game])) {
    for (const m of pc.matches) {
      const t = Date.parse(m.startDate);
      if (t > now + 8 * 24 * 3_600_000 || t < now - 36 * 3_600_000) continue;
      const same = byId.get(m.id);
      if (same) { compare(m, same); continue; }
      if (ids.has(m.id)) continue;
      if (m.status !== 'finished' && t < now - 6 * 3_600_000) continue; // never marked finished: do not show it «live» for ever
      if (isTbd(m.nameTeam1) || isTbd(m.nameTeam2)) continue;
      const a = tk(m.nameTeam1), z = tk(m.nameTeam2);
      const dup = ticker.find((x) => Math.abs(Date.parse(x.startDate) - t) < 6 * 3_600_000
        && ((tk(x.nameTeam1) === a && tk(x.nameTeam2) === z) || (tk(x.nameTeam1) === z && tk(x.nameTeam2) === a)));
      if (dup) { compare(m, dup); continue; }
      if (extra.some((x) => Math.abs(Date.parse(x.startDate) - t) < 6 * 3_600_000 && ((tk(x.nameTeam1) === a && tk(x.nameTeam2) === z) || (tk(x.nameTeam1) === z && tk(x.nameTeam2) === a)))) continue;
      ids.add(m.id);
      extra.push(m);
    }
  }
  pageCheck[game] = check;
  if (pagesMode.mode === 'off') { pagesAdded[game] = 0; return ticker; }
  if (!extra.length || (pagesMode.mode === 'auto' && !pagesTrusted(check))) {
    if (extra.length) console.warn(`[liquipedia] ${game}: tournament pages agree with the ticker on ${check.agreed} of ${check.checked} — their ${extra.length} extra matches are left out`);
    pagesAdded[game] = 0;
    return ticker;
  }
  // names differ between the ticker and a page («PVISION» / «PARIVISION»): one shared team at the same time is the same match
  const merged = mergeSameTimeDuplicates([...ticker, ...extra].sort((x, y) => Date.parse(x.startDate) - Date.parse(y.startDate)));
  pagesAdded[game] = merged.filter((m) => m.fromPage).length;
  return merged;
}

/** For the admin card: tournament pages read, the matches only they gave, and how they agree with the ticker. */
export function liquipediaPagesInfo(): { pages: number; added: number; empty: number; checked: number; agreed: number; trusted: boolean; off: string[]; mode: PagesMode } {
  const all = [...Object.values(pageStore.cs2), ...Object.values(pageStore.dota2)];
  // a page with no dated match: one alone is normal (an overview page that links its stages, a stage still all TBD);
  // half or more of them is not — most likely Liquipedia changed its layout. `empty` counts only then.
  const empty = all.filter((p) => !p.matches.length).length;
  const c = { checked: pageCheck.cs2.checked + pageCheck.dota2.checked, agreed: pageCheck.cs2.agreed + pageCheck.dota2.agreed };
  return {
    pages: all.length, added: pagesAdded.cs2 + pagesAdded.dota2, empty: empty >= 2 && empty * 2 >= all.length ? empty : 0,
    ...c, trusted: pagesTrusted(pageCheck.cs2) && pagesTrusted(pageCheck.dota2), off: [...pageCheck.cs2.off, ...pageCheck.dota2.off].slice(0, 5), mode: pagesMode.mode,
  };
}

// ── Live CS2: map-by-map score from the match page (≤ 2 pages every 3 min, each waits the 31 s gap) ──
const MAPS_EVERY_MS = 3 * 60_000;
let lastMaps = 0, mapsTurn = 0;
async function refreshMaps(game: 'cs2' | 'dota2'): Promise<void> {
  if (game !== 'cs2' || Date.now() - lastMaps < MAPS_EVERY_MS || isOpen(LIQUIPEDIA_PARSER)) return;
  const data = mem[game]?.data || [];
  const live = data.filter((m) => m.status === 'live' && m.matchPage);
  if (!live.length) return;
  lastMaps = Date.now();
  const pick = [0, 1].map((i) => live[(mapsTurn + i) % live.length]).filter((m, i, a) => a.indexOf(m) === i);
  mapsTurn += pick.length;
  let got = 0;
  for (const m of pick) {
    const url = `https://liquipedia.net/${WIKI[game]}/api.php?${new URLSearchParams({ action: 'parse', page: m.matchPage!, format: 'json', prop: 'text' })}`;
    const html = await limited(async () => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return '';
        const json: any = await res.json();
        return typeof json?.parse?.text === 'string' ? json.parse.text : json?.parse?.text?.['*'] || '';
      } catch { return ''; }
    });
    const maps = html ? parseMaps(html) : [];
    if (html && !maps.length) console.warn(`[liquipedia] ${m.matchPage}: no map scores parsed — ${describeHtml(html)}`);
    if (maps.length) { m.maps = maps; got++; }
  }
  if (got) persist(game, data, mem[game]?.at);
}

/** Matches for one game: from cache when fresher than 5 min, otherwise one (rate-limited) API call. */
/** When the feed last asked for Liquipedia data — with no visitors the refresh sleeps, so an old
 *  «last success» alone does not mean Liquipedia is stuck (the admin's «Без оновлень» needs both). */
let askedAt = 0;
/** Last fresh ticker per game (cache restored on start counts as fresh: its `at`). */
const okAt: Partial<Record<'cs2' | 'dota2', number>> = {};
export const liquipediaOkAt = (game: 'cs2' | 'dota2') => okAt[game] || mem[game]?.at || 0;
export const liquipediaAskedAt = () => askedAt;

/** «Оновити зараз»: forget the 5-minute freshness and the failure back-off, then fetch both games (each waits the 31 s gap). */
export function forceLiquipedia(): void {
  for (const g of ['cs2', 'dota2'] as const) { if (mem[g]) mem[g] = { ...mem[g]!, at: 0 }; delete failedAt[g]; delete lastPages[g]; }
  void fetchLiquipediaMatches('cs2').then(() => fetchLiquipediaMatches('dota2')).catch(() => {});
}

export async function fetchLiquipediaMatches(game: 'cs2' | 'dota2'): Promise<TipsGgMatch[]> {
  askedAt = Date.now();
  await hydrate(game);
  const cached = readCache(game);
  // night: every 15 min, unless a match is live or about to start (then as by day)
  const busy = cached?.data.some((m) => m.status === 'live' || (m.status === 'upcoming' && Date.parse(m.startDate) < Date.now() + 15 * 60_000));
  const every = isNight() && !busy ? Math.max(REFRESH_MS, NIGHT_REFRESH_MS) : REFRESH_MS;
  const fresh = cached && (Date.now() - cached.at < every || (cached.data.length > 0 && Date.now() - STARTED_AT < START_DELAY_MS));
  if (fresh || isOpen(LIQUIPEDIA_PARSER) || Date.now() - (failedAt[game] || 0) < FAIL_BACKOFF_MS) {
    void backfillScores(game).catch((e) => console.warn(`[liquipedia] ${game} backfill failed:`, (e as Error).message));
    void refreshMaps(game).catch((e) => console.warn(`[liquipedia] ${game} maps failed:`, (e as Error).message));
    void refreshPages(game).catch((e) => console.warn(`[liquipedia] ${game} pages failed:`, (e as Error).message));
    await hydratePages(game);
    await loadPagesMode();
    return withTimeStatus(withPages(game, cached?.data || []));
  }
  if (!inflight[game]) {
    inflight[game] = limited(() => fetchTicker(game)).then(({ list, why }) => {
      if (list) { const data = writeCache(game, list); okAt[game] = Date.now(); recordSuccess(LIQUIPEDIA_PARSER, runSummary(game, list)); delete failedAt[game]; return data; }
      failedAt[game] = Date.now();
      recordFailure(LIQUIPEDIA_PARSER, `${game === 'cs2' ? 'CS2' : 'Dota 2'} · ${why || 'невідома помилка'}`);
      return cached?.data || [];
    }).finally(() => { delete inflight[game]; });
  }
  const ticker = await inflight[game]!;
  await hydratePages(game);
  await loadPagesMode();
  const out = withTimeStatus(ticker.length ? withPages(game, ticker) : ticker);
  void backfillScores(game).catch((e) => console.warn(`[liquipedia] ${game} backfill failed:`, (e as Error).message));
  void refreshMaps(game).catch((e) => console.warn(`[liquipedia] ${game} maps failed:`, (e as Error).message));
  void refreshPages(game).catch((e) => console.warn(`[liquipedia] ${game} pages failed:`, (e as Error).message));
  return out;
}

/** Cached copy is up to 5 min old: an upcoming match whose time has come is live.
 *  «Finished» only ever comes from Liquipedia itself — never guessed — because bets settle on it. */
function withTimeStatus(list: TipsGgMatch[]): TipsGgMatch[] {
  const now = Date.now();
  return list.map((m) => (m.status === 'upcoming' && Date.parse(m.startDate) <= now ? { ...m, status: 'live' as const } : m));
}
