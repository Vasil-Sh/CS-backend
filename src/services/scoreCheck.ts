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
let state: { agreeAt: Record<string, number>; issues: ScoreIssue[]; resolved: Record<string, number> } = { agreeAt: {}, issues: [], resolved: {} };
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [DB_KEY]);
    if (rows[0]?.value) state = { agreeAt: {}, issues: [], resolved: {}, ...JSON.parse(rows[0].value) };
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

/** The series result a score stands for. A CS2 BO1 is often given in rounds (13:8) by one source and in maps (1:0)
 *  by another — both mean «team 1 won 1:0». Any number above 5 is rounds: only the winner is compared then. */
export function sameResult(a1: number, a2: number, b1: number, b2: number): boolean {
  const rounds = (x: number, y: number) => Math.max(x, y) > 5;
  if (rounds(a1, a2) || rounds(b1, b2)) return Math.sign(a1 - a2) === Math.sign(b1 - b2);
  return a1 === b1 && a2 === b2;
}

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
      // a match we closed by PandaScore + Cito that Liquipedia has now finished itself: same result → verified, off the list;
      // another result → it becomes a conflict below (Liquipedia's score against what we closed with)
      const ci = m.closedBy ? -1 : state.issues.findIndex((y) => y.id === m.id && y.kind === 'closed');
      if (ci >= 0) {
        const c = state.issues[ci];
        const [c1, c2] = c.ours.split(':').map(Number);
        state.issues.splice(ci, 1);
        changed = true;
        if (!sameResult(m.score1, m.score2, c1, c2)) { issue({ ...base, kind: 'conflict', ours: sc(m.score1, m.score2), theirs: c.theirs }); conflicts++; continue; }
      }
      const off = rs.filter((r) => !sameResult(m.score1!, m.score2!, r.s1!, r.s2!));
      if (off.length && !m.closedBy && !state.resolved[m.id]) { issue({ ...base, kind: 'conflict', ours: sc(m.score1, m.score2), theirs: off.map((r) => ({ source: r.source, score: sc(r.s1, r.s2) })) }); conflicts++; }
      else if (!off.length) { const i = state.issues.findIndex((y) => y.id === m.id && y.kind === 'conflict'); if (i >= 0) { state.issues.splice(i, 1); changed = true; } }
      continue;
    }
    if (m.status === 'finished' || Date.parse(m.startDate) > now) continue;
    // not finished by Liquipedia: two other sources agreeing on the same final score for 2 h close it
    const sources = new Set(rs.map((r) => r.source));
    const same = rs.every((r) => r.s1 === rs[0].s1 && r.s2 === rs[0].s2) && Math.max(rs[0].s1!, rs[0].s2!) <= 5; // maps, not rounds
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
  for (const [id, t] of Object.entries(state.resolved)) if (now - t > 7 * 24 * H) { delete state.resolved[id]; changed = true; }
  if (changed || state.issues.length !== before) save();
  return { conflicts, closed };
}

export async function scoreIssues(): Promise<ScoreIssue[]> {
  await load();
  return state.issues;
}
/** The admin chose the right score (or confirmed a closed match): the item leaves the list and is not raised again. */
export async function resolveScoreIssue(kind: ScoreIssue['kind'], id: string): Promise<ScoreIssue | null> {
  await load();
  const i = state.issues.findIndex((x) => x.id === id && x.kind === kind);
  if (i < 0) return null;
  const [item] = state.issues.splice(i, 1);
  state.resolved[id] = Date.now();
  save();
  return item;
}
export async function loadScoreCheck(): Promise<void> { await load(); }
export function __resetScoreCheck(): void { state = { agreeAt: {}, issues: [], resolved: {} }; loaded = true; }
