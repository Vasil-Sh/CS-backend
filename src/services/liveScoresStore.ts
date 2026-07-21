/**
 * LiveScoresStore — In-memory background worker for match live scores.
 *
 * Runs a background setInterval that fetches tips.gg listing page via Puppeteer
 * once every 30s, parses scores/status with Cheerio, and stores results in a Map.
 *
 * The /live-scores endpoint reads from this Map — no Puppeteer on the hot path.
 * Response time: <1ms (RAM) vs ~5-10s (Puppeteer).
 *
 * Generic: instantiate with a game name to support Dota2 or CS2.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from './tipsggScraper';

export interface LiveScoreState {
  id: string;
  score1: number | null;
  score2: number | null;
  status: string;
}

export class LiveScoresStore {
  private store = new Map<string, LiveScoreState>();
  private isUpdating = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastUpdate = 0;
  private readonly gamePath: string;
  private readonly tag: string;

  constructor(game: 'dota2' | 'cs2') {
    this.gamePath = game === 'dota2' ? 'dota2' : 'csgo';
    this.tag = game === 'dota2' ? 'Dota2' : 'CS2';
  }

  /** Start the background worker. Idempotent — safe to call multiple times. */
  startBackgroundWorker(intervalMs = 30000): void {
    if (this.intervalId) return;

    // Initial fetch immediately
    this.updateScores();

    this.intervalId = setInterval(() => {
      this.updateScores();
    }, intervalMs);

    // Don't keep the process alive just for this
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }

    console.log(`[${this.tag}LiveScoresStore] Background worker started (interval:`, intervalMs, 'ms)');
  }

  /** Stop the background worker. */
  stopBackgroundWorker(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Get current live scores snapshot. O(1) read — no I/O. */
  getScores(): LiveScoreState[] {
    return Array.from(this.store.values());
  }

  /** Get age of last successful update in ms. Useful for health checks. */
  getLastUpdateAge(): number {
    return this.lastUpdate ? Date.now() - this.lastUpdate : Infinity;
  }

  private async updateScores(): Promise<void> {
    if (this.isUpdating) return; // Prevent overlapping fetches
    this.isUpdating = true;

    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const url = `https://tips.gg/${this.gamePath}/matches/${dd}-${mm}-${yyyy}/`;

      const html = await fetchHtml(url, 1);
      if (!html) return;

      const $ = cheerio.load(html);
      const newStore = new Map<string, LiveScoreState>();

      $('.element.match').each((_, el) => {
        const $match = $(el);

        // Status from CSS class
        let status = 'upcoming';
        if ($match.hasClass('finished')) status = 'finished';
        else if ($match.hasClass('live')) status = 'live';

        // Slug from match link href
        const href = $match.find('a.match-link').attr('href') || '';
        const parts = href.replace(/\/$/, '').split('/');
        const id = parts[parts.length - 2] || parts[parts.length - 1] || '';
        if (!id) return;

        // Scores from .scores .score
        const scores: number[] = [];
        $match.find('.scores .score').each((_, scoreEl) => {
          const val = parseInt($(scoreEl).text().trim(), 10);
          if (!isNaN(val)) scores.push(val);
        });

        // Score-based status inference — only when scores exist and are non-zero
        if (status === 'upcoming' && scores.length >= 1) {
          const allZero = scores.every(s => s === 0);
          if (!allZero) status = 'live';
        }

        // Compute cumulative scores (even=team1, odd=team2 maps)
        let c1 = 0, c2 = 0;
        for (let i = 0; i < scores.length; i++) {
          if (i % 2 === 0) c1 += scores[i];
          else c2 += scores[i];
        }
        const bestOf = Math.max(c1, c2);
        const diff = Math.abs(c1 - c2);

        // BO3: 2 wins, BO5: 3 wins, BO2: 2 maps played, BO1: 1-0 diff
        if (bestOf >= 3 && diff >= 1) status = 'finished';        // BO5 3-0/3-1/3-2
        else if (bestOf >= 2 && diff >= 1) status = 'finished';   // BO3 2-0/2-1 or BO2 2-0
        else if (scores.length === 2 && bestOf >= 1 && diff >= 1 && status !== 'upcoming') status = 'finished'; // BO1 1-0

        newStore.set(id, {
          id,
          score1: scores.length > 0 ? scores[0] : null,
          score2: scores.length > 1 ? scores[1] : null,
          status,
        });
      });

      if (newStore.size > 0) {
        this.store = newStore;
        this.lastUpdate = Date.now();
      }
    } catch (err) {
      console.error(`[${this.tag}LiveScoresStore] Background update failed:`, (err as Error).message);
    } finally {
      this.isUpdating = false;
    }
  }
}

// Singleton instances for each game
export const liveScoresStore = new LiveScoresStore('dota2');
export const cs2LiveScoresStore = new LiveScoresStore('cs2');
