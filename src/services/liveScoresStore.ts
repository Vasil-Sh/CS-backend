/**
 * Live scores used to be polled from tips.gg. The schedule (Liquipedia, refreshed every few minutes) now carries
 * the live score itself, so the store is empty — it stays only so /live-scores keeps answering.
 */
export interface LiveScoreState { id: string; score1: number | null; score2: number | null; status: string; href?: string }
export interface LiveScoresResponse { scores: LiveScoreState[]; lastUpdate: number; interval: number }
export interface ILiveScoresStore {
  getScores(): LiveScoreState[];
  getChangedScores(): LiveScoreState[];
  getResponse(): LiveScoresResponse;
  startBackgroundWorker(intervalMs?: number): void;
}

class EmptyLiveScores implements ILiveScoresStore {
  getScores(): LiveScoreState[] { return []; }
  getChangedScores(): LiveScoreState[] { return []; }
  getResponse(): LiveScoresResponse { return { scores: [], lastUpdate: 0, interval: 0 }; }
  startBackgroundWorker(): void { /* nothing to poll */ }
}

export const liveScoresStore = new EmptyLiveScores();
export const cs2LiveScoresStore = new EmptyLiveScores();
