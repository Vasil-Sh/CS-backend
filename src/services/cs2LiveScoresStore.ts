/**
 * Cs2LiveScoresStore — In-memory background worker for CS2 live scores.
 * Same architecture as LiveScoresStore, but for tips.gg CS2 listing page.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from './tipsggScraper';

export interface LiveScoreState {
  id: string;
  score1: number | null;
  score2: number | null;
  status: string;
}

class Cs2LiveScoresStore {
  private store = new Map<string, LiveScoreState>();
  private isUpdating = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastUpdate = 0;

  startBackgroundWorker(intervalMs = 30000): void {
    if (this.intervalId) return;
    this.updateScores();
    this.intervalId = setInterval(() => { this.updateScores(); }, intervalMs);
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
    console.log('[Cs2LiveScoresStore] Background worker started (interval:', intervalMs, 'ms)');
  }

  stopBackgroundWorker(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getScores(): LiveScoreState[] {
    return Array.from(this.store.values());
  }

  getLastUpdateAge(): number {
    return this.lastUpdate ? Date.now() - this.lastUpdate : Infinity;
  }

  private async updateScores(): Promise<void> {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const url = `https://tips.gg/csgo/matches/${dd}-${mm}-${yyyy}/`;

      const html = await fetchHtml(url, 1);
      if (!html) return;

      const $ = cheerio.load(html);
      const newStore = new Map<string, LiveScoreState>();

      $('.element.match').each((_, el) => {
        const $match = $(el);

        let status = 'upcoming';
        if ($match.hasClass('finished')) status = 'finished';
        else if ($match.hasClass('live')) status = 'live';

        const href = $match.find('a.match-link').attr('href') || '';
        const parts = href.replace(/\/$/, '').split('/');
        const id = parts[parts.length - 2] || parts[parts.length - 1] || '';
        if (!id) return;

        const scores: number[] = [];
        $match.find('.scores .score').each((_, scoreEl) => {
          const val = parseInt($(scoreEl).text().trim(), 10);
          if (!isNaN(val)) scores.push(val);
        });

        if (status === 'upcoming' && scores.length >= 1) status = 'live';

        let c1 = 0, c2 = 0;
        for (let i = 0; i < scores.length; i++) {
          if (i % 2 === 0) c1 += scores[i];
          else c2 += scores[i];
        }
        const bestOf = Math.max(c1, c2);
        const diff = Math.abs(c1 - c2);

        if (bestOf >= 3 && diff >= 1) status = 'finished';
        else if (bestOf >= 2 && diff >= 1) status = 'finished';
        else if (scores.length === 2 && bestOf >= 1 && diff >= 1 && status !== 'upcoming') status = 'finished';

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
      console.error('[Cs2LiveScoresStore] Background update failed:', (err as Error).message);
    } finally {
      this.isUpdating = false;
    }
  }
}

export const cs2LiveScoresStore = new Cs2LiveScoresStore();
