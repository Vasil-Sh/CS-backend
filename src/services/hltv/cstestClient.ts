/**
 * cstest.pp.ua HTTP Client — fetches HLTV CS2 matches from deployed SC API.
 *
 * api.cstest.pp.ua is the production deployment of petrynyak/SC.
 * Returns 50+ matches with scores, logos, and isLive flag.
 *
 * This is the PRIMARY data source (fast HTTP, no Puppeteer).
 * Our internal hltvScraper.ts + tips.gg serve as fallbacks.
 */

import type { TipsGgMatch } from '../tipsggScraper';
import { fetchLiveHtml } from '../tipsggScraper';
import * as cheerio from 'cheerio';
import { getHltvLogoCache } from './hltvRankingScraper';

const CSTEST_BASE = 'https://api.cstest.pp.ua';

/**
 * Normalize team name to tips.gg-compatible slug segment.
 * tips.gg slugs: lowercase alphanumeric + dashes only.
 * Examples:
 *   "Black Phoenix" → "black-phoenix"
 *   "MOUZ NXT"     → "mouz-nxt"
 *   "G2 Ares"      → "g2-ares"
 */
function teamNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Generate match slug in tips.gg format: "team1-vs-team2".
 * This matches tips.gg live-score IDs exactly, enabling cross-source merging.
 */
function generateMatchSlug(team1: string, team2: string): string {
  return `${teamNameToSlug(team1)}-vs-${teamNameToSlug(team2)}`;
}

interface CstestGame {
  id: number;
  date: string;
  link: string;
  type: string;
  score1: number;
  score2: number;
  stars: number;
  nameTeam1: string;
  nameTeam2: string;
  lastChangeDateTeam1: string | null;
  lastChangeDateTeam2: string | null;
  positionTeam1: number | null;
  positionTeam2: number | null;
  logoTeam1: string | null;
  logoTeam2: string | null;
  predictionPercentTeam1: number | null;
  predictionPercentTeam2: number | null;
  bettingCoefficientTeam1: number | null;
  bettingCoefficientTeam2: number | null;
  isLive: boolean;
}

/**
 * Sanitize external logo URL: skip fallbacks, lookup in HLTV ranking as fallback.
 */
function sanitizeLogoUrl(url: string | null, teamName?: string): string | null {
  if (url) {
    if (/fallback\.(webp|png|svg)/i.test(url)) url = null;
    else {
      try { return encodeURI(url); }
      catch { url = null; }
    }
  }
  // No logo from source — lookup in HLTV ranking logo map (pre-loaded in memory)
  if (!url && teamName) {
    const hltvMap = getHltvLogoCache();
    if (hltvMap) {
      const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (hltvMap.has(norm)) return hltvMap.get(norm)!;
      const raw = teamName.toLowerCase().trim();
      if (hltvMap.has(raw)) return hltvMap.get(raw)!;
    }
  }
  return null;
}

/**
 * Convert cstest.pp.ua Game to TipsGgMatch (unified format).
 */
function cstestToTipsGgMatch(g: CstestGame): TipsGgMatch {
  const now = Date.now();
  const matchTime = new Date(g.date).getTime();
  const hoursAgo = (now - matchTime) / (1000 * 60 * 60);

  // SC parser only scrapes listing page — it returns score 0 for finished matches
  // that it hasn't visited. Detect finished matches: not live + started >2h ago.
  // CS2 BO3 rarely exceeds 2h; even BO5 OT wraps up under 4h. 2h is the sweet spot
  // — short enough to catch all finished, long enough to not flag delayed starts.
  const hasRealScore = g.score1 > 0 || g.score2 > 0;
  const isFinished = !g.isLive && (hasRealScore || hoursAgo > 2);

  const status: 'upcoming' | 'live' | 'finished' = isFinished
    ? 'finished'
    : g.isLive
      ? 'live'
      : 'upcoming';

  // Strip " (Online)" / " (LAN)" suffix from type (e.g. "bo3 (Online)" → "BO3")
  const cleanType = g.type.replace(/\s*\(.*\)/i, '').toUpperCase();

  return {
    id: generateMatchSlug(g.nameTeam1, g.nameTeam2),
    date: g.date.split('T')[0],
    link: g.link.startsWith('http') ? g.link : `https://www.hltv.org${g.link}`,
    type: cleanType || 'BO3',
    // Use ?? null — but if cstest says 0 and we don't have real scores, set null
    score1: hasRealScore || g.isLive ? (g.score1 ?? null) : null,
    score2: hasRealScore || g.isLive ? (g.score2 ?? null) : null,
    nameTeam1: g.nameTeam1,
    nameTeam2: g.nameTeam2,
    logoTeam1: sanitizeLogoUrl(g.logoTeam1, g.nameTeam1),
    logoTeam2: sanitizeLogoUrl(g.logoTeam2, g.nameTeam2),
    tournament: '',
    stage: '',
    status,
    tipsCount: 0,
    performer: null,
    startDate: g.date,
    pred1: g.predictionPercentTeam1 ?? 50,
    pred2: g.predictionPercentTeam2 ?? 50,
    coeff1: g.bettingCoefficientTeam1 ?? null,
    coeff2: g.bettingCoefficientTeam2 ?? null,
  };
}

/**
 * Fetch CS2 matches from api.cstest.pp.ua (deployed SC/HLTV parser).
 * Returns unified TipsGgMatch format for compatibility with createMatchesRouter.
 */
export async function fetchCstestMatches(): Promise<TipsGgMatch[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${CSTEST_BASE}/api/Game/TodaysAndUpcoming`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`cstest.pp.ua returned ${response.status}`);
    }

    const raw = (await response.json()) as CstestGame[];
    if (!Array.isArray(raw)) {
      console.warn('[cstest] Expected array, got', typeof raw);
      return [];
    }

    const matches = raw.map(cstestToTipsGgMatch);
    const liveCount = matches.filter(m => m.status === 'live').length;
    const finishedCount = matches.filter(m => m.status === 'finished').length;

    console.log(
      `[cstest] Fetched ${matches.length} matches ` +
      `(${liveCount} live, ${finishedCount} finished)`,
    );

    return matches;
  } finally {
    clearTimeout(timeout);
  }
}

export interface LiveScoreState {
  id: string;
  score1: number | null;
  score2: number | null;
  status: string;
}

export interface LiveScoresResponse {
  scores: LiveScoreState[];
  lastUpdate: number;
  interval: number;
}

// ── CstestLiveScoresStore — dual-source live scores for CS2 ──
//
// Architecture:
//   1. cstest API → match list + isLive flag (coverage: 50+ matches)
//   2. tips.gg CS2 today page → real scores from HTML (via fast HTTP)
//   3. Merge: cstest provides match discovery, tips.gg provides real scores
//
// Dead-man switch: if cstest fails 3× consecutively, switch to tips.gg-only mode.
// Auto-recover when cstest comes back online.

export class CstestLiveScoresStore {
  private store = new Map<string, LiveScoreState>();
  private lastStore = new Map<string, LiveScoreState>();
  private isUpdating = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastUpdate = 0;
  private currentInterval = 7_000;
  private cstestFailCount = 0;
  private tipsggFailCount = 0;
  private lastCstestLatency = 0;
  private lastTipsggLatency = 0;

  startBackgroundWorker(intervalMs = 7_000): void {
    if (this.intervalId) return;
    this.currentInterval = intervalMs;
    this.updateScores();
    this.intervalId = setInterval(() => this.updateScores(), intervalMs);
    if (this.intervalId && 'unref' in this.intervalId) (this.intervalId as NodeJS.Timeout).unref();
    console.log(`[CstestLiveScoresStore] Worker started (${intervalMs}ms)`);
  }

  getScores(): LiveScoreState[] {
    return Array.from(this.store.values());
  }

  getResponse(): LiveScoresResponse {
    return { scores: this.getScores(), lastUpdate: this.lastUpdate, interval: this.currentInterval };
  }

  getChangedScores(): LiveScoreState[] {
    const changed: LiveScoreState[] = [];
    for (const [id, s] of this.store) {
      const p = this.lastStore.get(id);
      if (!p || s.score1 !== p.score1 || s.score2 !== p.score2 || s.status !== p.status) {
        changed.push(s);
      }
    }
    return changed;
  }

  getLiveCount(): number {
    let n = 0;
    for (const s of this.store.values()) { if (s.status === 'live') n++; }
    return n;
  }

  /** Expose metrics for health monitoring. */
  getMetrics() {
    return {
      storeSize: this.store.size,
      cstestFailCount: this.cstestFailCount,
      tipsggFailCount: this.tipsggFailCount,
      lastCstestLatency: this.lastCstestLatency,
      lastTipsggLatency: this.lastTipsggLatency,
    };
  }

  // ── Score update: fetch cstest + tips.gg in parallel, merge ──
  private async updateScores(): Promise<void> {
    if (this.isUpdating) return;
    this.isUpdating = true;
    const t0 = Date.now();

    try {
      // ── Fetch both sources in parallel ──
      const [cstestResult, tipsggScores] = await Promise.allSettled([
        this.fetchCstestScores(),
        this.fetchTipsggScores(),
      ]);

      // ── Build final store ──
      const ns = new Map<string, LiveScoreState>();

      // Primary: cstest provides the match list (coverage)
      if (cstestResult.status === 'fulfilled' && cstestResult.value) {
        for (const s of cstestResult.value) {
          ns.set(s.id, { ...s });
        }
        this.cstestFailCount = 0;
      } else {
        this.cstestFailCount++;
        if (cstestResult.status === 'rejected') {
          console.warn(`[CstestLiveScoresStore] cstest fetch failed (×${this.cstestFailCount}):`,
            (cstestResult.reason as Error)?.message);
        }
      }

      // Secondary: tips.gg provides real scores — overlay on cstest entries
      if (tipsggScores.status === 'fulfilled') {
        let overlays = 0;
        let newEntries = 0;
        for (const ts of tipsggScores.value) {
          const existing = ns.get(ts.id);
          if (existing) {
            // Overlay tips.gg real scores on cstest match if:
            // - tips.gg has non-null scores (cstest may show 0-0)
            // - Don't overwrite non-zero cstest scores with null tips.gg scores
            if (ts.score1 != null) existing.score1 = ts.score1;
            if (ts.score2 != null) existing.score2 = ts.score2;
            // Status: trust tips.gg more (they update CSS classes faster)
            if (ts.status !== 'upcoming') existing.status = ts.status;
            overlays++;
          } else if (this.cstestFailCount >= 3 || ns.size === 0) {
            // Dead-man switch: cstest is down → add tips.gg entries directly
            // Also triggers on cold start (ns.size === 0) when cstest unreachable
            ns.set(ts.id, ts);
            newEntries++;
          }
        }
        this.tipsggFailCount = 0;

        const liveNow = [...ns.values()].filter(s => s.status === 'live').length;
        if (overlays > 0 || newEntries > 0 || liveNow > 0) {
          const ms = Date.now() - t0;
          console.log(
            `[CstestLiveScoresStore] ${ns.size} matches (${liveNow} live) | ` +
            `${overlays} scores overlaid from tips.gg` +
            (newEntries ? ` | +${newEntries} from tips.gg (dead-man)` : '') +
            ` | ${ms}ms`,
          );
        }
      } else {
        this.tipsggFailCount++;
      }

      if (ns.size > 0) {
        this.lastStore = new Map(this.store);
        this.store = ns;
        this.lastUpdate = Date.now();
      }
    } catch (err) {
      console.error('[CstestLiveScoresStore] fail:', (err as Error).message);
    } finally {
      this.isUpdating = false;
    }
  }

  // ── Fetch from cstest API ──
  private async fetchCstestScores(): Promise<LiveScoreState[] | null> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${CSTEST_BASE}/api/Game/TodaysAndUpcoming`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return null;
      const raw = (await response.json()) as CstestGame[];
      if (!Array.isArray(raw)) return null;

      const result: LiveScoreState[] = [];
      for (const g of raw) {
        const slug = generateMatchSlug(g.nameTeam1, g.nameTeam2);
        let status = 'upcoming';
        if (g.isLive) status = 'live';
        else if (g.score1 > 0 || g.score2 > 0) {
          const matchTime = new Date(g.date).getTime();
          const hoursAgo = (Date.now() - matchTime) / (1000 * 60 * 60);
          status = hoursAgo > 2 ? 'finished' : 'live';
        } else {
          const matchTime = new Date(g.date).getTime();
          const hoursAgo = (Date.now() - matchTime) / (1000 * 60 * 60);
          if (hoursAgo > 4) status = 'finished';
        }

        result.push({
          id: slug,
          score1: g.score1 ?? null,
          score2: g.score2 ?? null,
          status,
        });
      }
      this.lastCstestLatency = Date.now() - t0;
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Fetch from tips.gg CS2 today page (HTTP, real scores via HTML parsing) ──
  // Falls back to Puppeteer when Cloudflare blocks fast HTTP.
  private async fetchTipsggScores(): Promise<LiveScoreState[]> {
    const t0 = Date.now();
    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const url = `https://tips.gg/csgo/matches/${dd}-${mm}-${yyyy}/`;

      // Try fast HTTP first, fall back to Puppeteer
      let html = await fetchLiveHtml(url, 1);
      if (!html) {
        // Cloudflare blocked fast HTTP — use Puppeteer (same pool as main scraper)
        try {
          const { getBrowser } = await import('../tipsggScraper');
          const browser = await getBrowser();
          const page = await browser.newPage();
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            html = await page.content();
          } finally {
            await page.close().catch(() => {});
          }
        } catch (puppErr) {
          console.warn('[CstestLiveScoresStore] tips.gg Puppeteer fallback failed:', (puppErr as Error).message);
        }
      }
      if (!html) return [];

      const $ = cheerio.load(html);
      const result: LiveScoreState[] = [];

      $('.element.match').each((_, el) => {
        const $m = $(el);
        let status = 'upcoming';
        if ($m.hasClass('finished')) status = 'finished';
        else if ($m.hasClass('live')) status = 'live';

        const href = $m.find('a.match-link').attr('href') || '';
        const p = href.replace(/\/$/, '').split('/');
        const id = p[p.length - 2] || p[p.length - 1] || '';
        if (!id) return;

        const rs: number[] = [];
        $m.find('.scores .score').each((_, se) => {
          const v = parseInt($(se).text().trim(), 10);
          if (!isNaN(v)) rs.push(v);
        });

        let w1 = 0, w2 = 0;
        const allLow = rs.length > 0 && rs.every(v => v <= 5);
        if (allLow) {
          w1 = rs[0] ?? 0;
          w2 = rs[1] ?? 0;
        } else {
          for (let i = 0; i + 1 < rs.length; i += 2) {
            if (rs[i] > rs[i + 1]) w1++;
            else if (rs[i + 1] > rs[i]) w2++;
          }
        }

        if (status === 'upcoming' && (w1 > 0 || w2 > 0)) status = 'live';

        if (status === 'live') {
          const startAttr = $m.attr('data-start') || $m.find('time').attr('datetime') || '';
          if (startAttr) {
            const hoursSinceStart = (Date.now() - new Date(startAttr).getTime()) / 3600000;
            if (hoursSinceStart > 4) status = 'finished';
          }
        }

        result.push({
          id,
          score1: rs.length > 0 ? w1 : null,
          score2: rs.length > 0 ? w2 : null,
          status,
        });
      });

      this.lastTipsggLatency = Date.now() - t0;
      if (result.length > 0) {
        const liveNow = result.filter(s => s.status === 'live').length;
        console.log(`[CstestLiveScoresStore] tips.gg: ${result.length} scores (${liveNow} live, via ${html ? 'HTTP' : 'Puppeteer'})`);
      }
      return result;
    } catch (err) {
      console.warn('[CstestLiveScoresStore] tips.gg fetch failed:', (err as Error).message);
      this.tipsggFailCount++;
      return [];
    }
  }
}

export const cstestLiveScoresStore = new CstestLiveScoresStore();
