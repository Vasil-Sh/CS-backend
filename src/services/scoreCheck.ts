// ═══════════════════════════════════════════════════════════════
// Scores cross-checked between the sources:
//   • a conflict — Liquipedia's final score differs from PandaScore's or Cito's → the admin's «Розбіжності» list;
//   • a fallback close — Liquipedia still has the match unfinished, but PandaScore and Cito both say «finished»
//     with the same score for 2 h → the match is closed with that score (bets do not hang on a silent ticker).
// ═══════════════════════════════════════════════════════════════

import type { TipsGgMatch } from './matchTypes';
import { pool } from '../db/client';

export type Source = 'pandascore' | 'cito';
export interface Report { source: Source; status: TipsGgMatch['status']; s1: number | null; s2: number | null }
export interface ScoreIssue {
  kind: 'conflict' | 'closed';
  id: string;
  game: 'cs2' | 'dota2';
  team1: string;
  team2: string;
  start: string;
  tournament: string;
  /** Our score (Liquipedia) — for a fallback close, the score it was closed with. */
  ours: string;
  theirs: { source: Source; score: string }[];
  at: string;
}

const H = 3_600_000;
export const CLOSE_AFTER_MS = 2 * H;
const DB_KEY = 'feed_score_check';
let state: { agreeAt: Record<string, number>; issues: ScoreIssue[] } = { agreeAt: {}, issues: [] };
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (rows[0]?.value) state = { agreeAt: {}, issues: [], ...JSON.parse(rows[0].value) };
  } catch { /* start empty */ }
}
function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pool.query(
      `INSERT INTO app_settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [DB_KEY, JSON.stringify(state)],
    ).catch((e) => console.warn('[scoreCheck] save failed:', (e as Error).message));
  }, 2_000);
  saveTimer.unref?.();
}

const sc = (a: number | null, b: number | null) => `${a ?? '—'}:${b ?? '—'}`;
const done = (r: Report) => r.status === 'finished' && r.s1 != null && r.s2 != null;

/** Apply to one built feed list (mutates it). `reports` — what the other sources said about each of our matches, oriented to it. */
export function checkScores(game: 'cs2' | 'dota2', list: TipsGgMatch[], reports: Map<TipsGgMatch, Report[]>, now = Date.now()): { conflicts: number; closed: number } {
  let conflicts = 0, closed = 0, changed = false;
  const issue = (x: Omit<ScoreIssue, 'at'>) => {
    const i = state.issues.findIndex((y) => y.id === x.id && y.kind === x.kind);
    const prev = i >= 0 ? state.issues[i] : null;
    if (prev && prev.ours === x.ours && JSON.stringify(prev.theirs) === JSON.stringify(x.theirs)) return;
    const item = { ...x, at: new Date(now).toISOString() };
    if (i >= 0) state.issues[i] = item; else state.issues.unshift(item);
    changed = true;
  };
  for (const m of list) {
    const rs = (reports.get(m) || []).filter(done);
    if (!rs.length) continue;
    const base = { id: m.id, game, team1: m.nameTeam1, team2: m.nameTeam2, start: m.startDate, tournament: m.tournament };
    if (m.status === 'finished' && m.score1 != null && m.score2 != null) {
      const off = rs.filter((r) => r.s1 !== m.score1 || r.s2 !== m.score2);
      if (off.length && !m.closedBy) { issue({ ...base, kind: 'conflict', ours: sc(m.score1, m.score2), theirs: off.map((r) => ({ source: r.source, score: sc(r.s1, r.s2) })) }); conflicts++; }
      continue;
    }
    if (m.status === 'finished' || Date.parse(m.startDate) > now) continue;
    // not finished by Liquipedia: two other sources agreeing on the same final score for 2 h close it
    const sources = new Set(rs.map((r) => r.source));
    const same = rs.every((r) => r.s1 === rs[0].s1 && r.s2 === rs[0].s2);
    if (sources.size < 2 || !same || rs[0].s1 === rs[0].s2) { if (state.agreeAt[m.id]) { delete state.agreeAt[m.id]; changed = true; } continue; }
    const since = state.agreeAt[m.id] ??= now;
    if (since === now) changed = true;
    if (now - since < CLOSE_AFTER_MS) continue;
    m.status = 'finished';
    m.score1 = rs[0].s1;
    m.score2 = rs[0].s2;
    m.closedBy = [...sources].sort().join('+');
    issue({ ...base, kind: 'closed', ours: sc(m.score1, m.score2), theirs: rs.map((r) => ({ source: r.source, score: sc(r.s1, r.s2) })) });
    closed++;
  }
  // keep a week of issues and two days of agreements
  const weekAgo = now - 7 * 24 * H;
  const before = state.issues.length;
  state.issues = state.issues.filter((x) => Date.parse(x.at) > weekAgo).slice(0, 100);
  for (const [id, t] of Object.entries(state.agreeAt)) if (now - t > 2 * 24 * H) { delete state.agreeAt[id]; changed = true; }
  if (changed || state.issues.length !== before) save();
  return { conflicts, closed };
}

export async function scoreIssues(): Promise<ScoreIssue[]> {
  await load();
  return state.issues;
}
export async function loadScoreCheck(): Promise<void> { await load(); }
export function __resetScoreCheck(): void { state = { agreeAt: {}, issues: [] }; loaded = true; }
