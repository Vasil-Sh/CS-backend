import * as cheerio from 'cheerio';
import { fetchLiveHtml, isBanned } from './tipsggScraper';
import { isIdle, IDLE_POLL_MS } from './activityTracker';

export interface LiveScoreState {
  id: string;
  score1: number | null;
  score2: number | null;
  status: string;
  href?: string; // relative match page URL (e.g. /dota2/matches/03-08-2026/team-liquid-vs-vici-gaming/07-00/)
}

export interface LiveScoresResponse {
  scores: LiveScoreState[];
  lastUpdate: number;
  interval: number;
}

/** Shared interface — both LiveScoresStore and CstestLiveScoresStore implement this. */
export interface ILiveScoresStore {
  getScores(): LiveScoreState[];
  getChangedScores(): LiveScoreState[];
  getResponse(): LiveScoresResponse;
  startBackgroundWorker(intervalMs?: number): void;
}

export class LiveScoresStore {
  private store = new Map<string, LiveScoreState>();
  private lastStore = new Map<string, LiveScoreState>();
  private isUpdating = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastUpdate = 0;
  private currentInterval = 15_000;
  private readonly gamePath: string;
  private readonly tag: string;

  constructor(game: 'dota2' | 'cs2') {
    this.gamePath = game === 'dota2' ? 'dota2' : 'csgo';
    this.tag = game === 'dota2' ? 'Dota2' : 'CS2';
  }

  startBackgroundWorker(intervalMs = 15_000): void {
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
    console.log(`[${this.tag}LiveScoresStore] Worker started (${intervalMs}ms active, ${IDLE_POLL_MS}ms idle ±20% jitter)`);
  }

  stopBackgroundWorker(): void {
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
  }

  getScores(): LiveScoreState[] {
    return Array.from(this.store.values());
  }

  getResponse(): LiveScoresResponse {
    return {
      scores: this.getScores(),
      lastUpdate: this.lastUpdate,
      interval: this.currentInterval,
    };
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

  getLastUpdateAge(): number {
    return this.lastUpdate ? Date.now() - this.lastUpdate : Infinity;
  }

  private async updateScores(): Promise<void> {
    if (this.isUpdating) return;
    this.isUpdating = true;
    try {
      // Skip if tips.gg is in ban cooldown — don't even try, save the request
      if (isBanned()) {
        return;
      }

      const today = new Date();
      const dd = String(today.getDate()).padStart(2,'0');
      const mm = String(today.getMonth()+1).padStart(2,'0');
      const yyyy = today.getFullYear();
      const url = `https://tips.gg/${this.gamePath}/matches/${dd}-${mm}-${yyyy}/`;

      // Also scrape yesterday's page — live matches that started yesterday
      // still appear there after midnight.
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const ydd = String(yesterday.getDate()).padStart(2,'0');
      const ymm = String(yesterday.getMonth()+1).padStart(2,'0');
      const yyyy2 = yesterday.getFullYear();
      const yesterdayUrl = `https://tips.gg/${this.gamePath}/matches/${ydd}-${ymm}-${yyyy2}/`;

      const scrapePage = async (pageUrl: string): Promise<Map<string, LiveScoreState>> => {
        // No Puppeteer fallback for live polling — aggressive browser is worse than
        // missing one cycle. The fetchLiveHtml rate limiter already handles ban cooldown.
        const html = await fetchLiveHtml(pageUrl, 1);
        if (!html) return new Map();
        const $ = cheerio.load(html);
        const result = new Map<string, LiveScoreState>();
        this.parseScores($, result);
        return result;
      };

      // Scrape today and yesterday in parallel (rate limiter sequentializes actual HTTP)
      const [todayScores, yesterdayScores] = await Promise.all([
        scrapePage(url),
        scrapePage(yesterdayUrl),
      ]);

      // Merge: today wins for same IDs, yesterday fills gaps
      const ns = new Map<string, LiveScoreState>();
      for (const [id, s] of yesterdayScores) ns.set(id, s);
      for (const [id, s] of todayScores) ns.set(id, s);

      // Also keep any existing live entries that weren't found on either page
      // (e.g., match page returns 404 temporarily).
      // Only preserve entries from the last 12 hours — clean up stale orphans.
      for (const [id, s] of this.store) {
        if (!ns.has(id) && s.status === 'live') {
          if (Date.now() - this.lastUpdate < 12 * 60 * 60 * 1000) {
            ns.set(id, s);
          }
        }
      }

      // For matches with scores on the date pages, also scrape individual match detail pages.
      // Date-based archive pages may show stale scores after midnight.
      // Target: all scored matches (live or finished) — detail page has the real final score.
      const scoredMatches = [...ns.values()].filter(
        (s) => s.href && s.score1 != null && s.score2 != null,
      );
      if (scoredMatches.length > 0) {
        const detailResults = await Promise.allSettled(
          scoredMatches.map(async (s) => {
            const href = s.href!;
            const detailUrl = href.startsWith('http') ? href : `https://tips.gg${href}`;
            const html = await fetchLiveHtml(detailUrl, 1); // no Puppeteer fallback
            if (!html) return null;
            const $ = cheerio.load(html);
            const temp = new Map<string, LiveScoreState>();
            this.parseScores($, temp);
            return temp.get(s.id) || null;
          }),
        );
        for (const result of detailResults) {
          if (result.status === 'fulfilled' && result.value) {
            const fresh = result.value;
            ns.set(fresh.id, fresh);
          }
        }
      }

      if (ns.size > 0) {
        this.lastStore = new Map(this.store);
        this.store = ns;
        this.lastUpdate = Date.now();
      }
    } catch (err) {
      console.error(`[${this.tag}LiveScoresStore] fail:`, (err as Error).message);
    } finally { this.isUpdating = false; }
  }

  /** Parse scores from cheerio $ into a LiveScoreState map. Extracted for reuse. */
  private parseScores($: cheerio.CheerioAPI, ns: Map<string, LiveScoreState>): void {
    $('.element.match').each((_, el) => {
      const $m = $(el);
      let status = 'upcoming';
      if ($m.hasClass('finished')) status = 'finished';
      else if ($m.hasClass('live')) status = 'live';

      const href = $m.find('a.match-link').attr('href') || '';
      const p = href.replace(/\/$/,'').split('/');
      const id = p[p.length-2] || p[p.length-1] || '';
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
        for (let i = 0; i+1 < rs.length; i+=2) {
          if (rs[i] > rs[i+1]) w1++;
          else if (rs[i+1] > rs[i]) w2++;
        }
      }

      if (status === 'upcoming' && (w1>0||w2>0)) status = 'live';

      if (status === 'live') {
        const startAttr = $m.attr('data-start') || $m.find('time').attr('datetime') || '';
        if (startAttr) {
          const hoursSinceStart = (Date.now() - new Date(startAttr).getTime()) / 3600000;
          if (hoursSinceStart > 4) status = 'finished';
        }
      }

      ns.set(id, { id, score1: rs.length>0?w1:null, score2: rs.length>0?w2:null, status, href });
    });
  }
}

export const liveScoresStore = new LiveScoresStore('dota2');
export const cs2LiveScoresStore = new LiveScoresStore('cs2');
