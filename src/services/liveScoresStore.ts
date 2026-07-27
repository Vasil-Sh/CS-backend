import * as cheerio from 'cheerio';
import { fetchHtml } from './tipsggScraper';

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

export class LiveScoresStore {
  private store = new Map<string, LiveScoreState>();
  private lastStore = new Map<string, LiveScoreState>();
  private isUpdating = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastUpdate = 0;
  private currentInterval = 15_000;
  private readonly gamePath: string;
  private readonly tag: string;

  constructor(game: 'dota2' | 'cs2') {
    this.gamePath = game === 'dota2' ? 'dota2' : 'csgo';
    this.tag = game === 'dota2' ? 'Dota2' : 'CS2';
  }

  startBackgroundWorker(intervalMs = 15_000): void {
    if (this.intervalId) return;
    this.currentInterval = intervalMs;
    this.updateScores();
    this.intervalId = setInterval(() => this.updateScores(), intervalMs);
    if (this.intervalId && 'unref' in this.intervalId) (this.intervalId as NodeJS.Timeout).unref();
    console.log(`[${this.tag}LiveScoresStore] Worker started (${intervalMs}ms)`);
  }

  stopBackgroundWorker(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
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
      const today = new Date();
      const dd = String(today.getDate()).padStart(2,'0');
      const mm = String(today.getMonth()+1).padStart(2,'0');
      const yyyy = today.getFullYear();
      const url = `https://tips.gg/${this.gamePath}/matches/${dd}-${mm}-${yyyy}/`;
      const html = await fetchHtml(url, 1);
      if (!html) return;
      const $ = cheerio.load(html);
      const ns = new Map<string, LiveScoreState>();

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
        for (let i = 0; i+1 < rs.length; i+=2) {
          if (rs[i] > rs[i+1]) w1++;
          else if (rs[i+1] > rs[i]) w2++;
        }

        if (status === 'upcoming' && (w1>0||w2>0)) status = 'live';

        // Date-based finished detection (mirrors tipsggScraper logic).
        // If HTML says 'live' but match started too long ago, mark as finished.
        if (status === 'live') {
          const startAttr = $m.attr('data-start') || $m.find('time').attr('datetime') || '';
          if (startAttr) {
            const hoursSinceStart = (Date.now() - new Date(startAttr).getTime()) / 3600000;
            if (hoursSinceStart > 4) status = 'finished'; // 4h conservative cutoff for live scores
          }
        }

        ns.set(id, { id, score1: rs.length>0?w1:null, score2: rs.length>0?w2:null, status });
      });

      if (ns.size > 0) {
        this.lastStore = new Map(this.store);
        this.store = ns;
        this.lastUpdate = Date.now();
      }
    } catch (err) {
      console.error(`[${this.tag}LiveScoresStore] fail:`, (err as Error).message);
    } finally { this.isUpdating = false; }
  }
}

export const liveScoresStore = new LiveScoresStore('dota2');
export const cs2LiveScoresStore = new LiveScoresStore('cs2');
