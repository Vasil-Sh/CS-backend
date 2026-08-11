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
import { isBanned } from '../tipsggScraper';
import { isIdle, IDLE_POLL_MS } from '../activityTracker';
import { getHltvLogoCache } from './hltvRankingScraper';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  // that it hasn't visited. Detect finished matches: not live + started beyond format
  // max duration. CS2: BO1≈1h, BO3≈2.5h, BO5≈4.5h.
  const hasRealScore = g.score1 > 0 || g.score2 > 0;
  const maxHours = g.type === 'BO5' ? 4.5 : g.type === 'BO1' ? 1 : 2.5;
  const isFinished = !g.isLive && (hasRealScore || hoursAgo > maxHours);

  const status: 'upcoming' | 'live' | 'finished' = isFinished
    ? 'finished'
    : g.isLive
      ? 'live'
      : 'upcoming';

  // Strip " (Online)" / " (LAN)" suffix from type (e.g. "bo3 (Online)" → "BO3")
  const cleanType = g.type.replace(/\s*\(.*\)/i, '').toUpperCase();

  // Build proper HLTV URL using numeric ID (g.id is the HLTV match ID).
  // g.link sometimes has date-based paths like /matches/counter-strike/.../ that don't work.
  // Using numeric ID + team slug always works — HLTV redirects correctly.
  const team1Slug = g.nameTeam1.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const team2Slug = g.nameTeam2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hltvUrl = `https://www.hltv.org/matches/${g.id}/${team1Slug}-vs-${team2Slug}`;

  return {
    id: generateMatchSlug(g.nameTeam1, g.nameTeam2),
    date: g.date.split('T')[0],
    link: hltvUrl,
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
    positionTeam1: g.positionTeam1 ?? null,
    positionTeam2: g.positionTeam2 ?? null,
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
  href?: string;
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
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastUpdate = 0;
  private currentInterval = 7_000;
  private cstestFailCount = 0;
  private tipsggFailCount = 0;
  private lastCstestLatency = 0;
  private lastTipsggLatency = 0;

  startBackgroundWorker(intervalMs = 7_000): void {
    if (this.timeoutId) return;
    this.currentInterval = intervalMs;

    // Dynamic interval: fast when users are watching, slow when idle.
    // Uses setTimeout chain with jitter to avoid predictable patterns.
    const nextDelay = (): number => {
      const base = (isIdle() || isBanned()) ? IDLE_POLL_MS : this.currentInterval;
      return Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% jitter
    };

    const tick = async () => {
      await this.updateScores();
      this.timeoutId = setTimeout(tick, nextDelay());
      if (this.timeoutId && 'unref' in this.timeoutId) (this.timeoutId as NodeJS.Timeout).unref();
    };

    // Fire first update immediately, then schedule next
    tick();
    console.log(`[CstestLiveScoresStore] Worker started (${intervalMs}ms active, ${IDLE_POLL_MS}ms idle ±20% jitter)`);
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

  // ── Score update: cstest-only (no tips.gg overlay) ──
  private async updateScores(): Promise<void> {
    if (this.isUpdating) return;
    this.isUpdating = true;
    const t0 = Date.now();

    try {
      const cstestResult = await this.fetchCstestScores().catch(() => null);

      const ns = new Map<string, LiveScoreState>();

      if (cstestResult) {
        for (const s of cstestResult) ns.set(s.id, { ...s });
        this.cstestFailCount = 0;
      } else {
        this.cstestFailCount++;
        if (this.cstestFailCount >= 3) {
          console.warn(`[CstestLiveScoresStore] cstest failed ${this.cstestFailCount}× — keeping previous store`);
        }
      }

      // Preserve entries from previous store if cstest returned nothing
      const cstestEmpty = !cstestResult || cstestResult.length === 0;
      const now = Date.now();
      for (const [id, s] of this.store) {
        if (!ns.has(id)) {
          if (s.status === 'live' && now - this.lastUpdate < 12 * 60 * 60 * 1000) {
            ns.set(id, s);
          } else if (cstestEmpty && now - this.lastUpdate < 10 * 60 * 1000) {
            ns.set(id, s);
          }
        }
      }

      // Cold start with no data — seed from cache file
      if (ns.size === 0 && this.store.size === 0) {
        try {
          const cacheFile = join(process.cwd(), '.cache', 'cs2_matches.json');
          if (existsSync(cacheFile)) {
            const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
            const cacheData: TipsGgMatch[] = raw?.data ?? [];
            for (const m of cacheData) {
              if (m.date < new Date().toISOString().split('T')[0]) continue;
              ns.set(m.id, {
                id: m.id,
                score1: m.score1 ?? null,
                score2: m.score2 ?? null,
                status: m.status ?? 'upcoming',
              });
            }
            if (ns.size > 0) console.log(`[CstestLiveScoresStore] Seeded from cache: ${ns.size} matches`);
          }
        } catch { /* ignore */ }
      }

      if (ns.size > 0) {
        const liveNow = [...ns.values()].filter(s => s.status === 'live').length;
        const ms = Date.now() - t0;
        if (liveNow > 0 || cstestEmpty) {
          console.log(`[CstestLiveScoresStore] ${ns.size} matches (${liveNow} live, cstest-only) | ${ms}ms`);
        }
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
        const s1 = g.score1 ?? 0;
        const s2 = g.score2 ?? 0;

        // Detect finished matches even when cstest still reports isLive=true.
        // Score-decided takes priority over isLive flag.
        const winsNeeded = g.type === 'BO5' ? 3 : g.type === 'BO1' ? 1 : 2;
        const maxScore = Math.max(s1, s2);
        const isScoreDecided =
          maxScore >= winsNeeded &&
          Math.abs(s1 - s2) >= (g.type === 'BO1' ? 0 : 1);

        let status: string;
        if (isScoreDecided) {
          status = 'finished';
        } else if (g.isLive) {
          status = 'live';
        } else if (s1 > 0 || s2 > 0) {
          const matchTime = new Date(g.date).getTime();
          const hoursAgo = (Date.now() - matchTime) / (1000 * 60 * 60);
          // Format-dependent: Bo1→1h, Bo5→4.5h, Bo3→2.5h
          const maxH = g.type === 'BO5' ? 4.5 : g.type === 'BO1' ? 1 : 2.5;
          status = hoursAgo > maxH ? 'finished' : 'live';
        } else {
          const matchTime = new Date(g.date).getTime();
          const hoursAgo = (Date.now() - matchTime) / (1000 * 60 * 60);
          // No scores at all: shorter thresholds (match likely cancelled/postponed)
          const maxH = g.type === 'BO5' ? 4.5 : g.type === 'BO1' ? 1 : 2.5;
          status = hoursAgo > maxH ? 'finished' : 'upcoming';
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
}

export const cstestLiveScoresStore = new CstestLiveScoresStore();
