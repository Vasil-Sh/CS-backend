/**
 * Closing line: the last prices OddsPapi showed before a match started. Kept per match so the journal can
 * tell whether a bet beat it (odds 1.95 vs closing 1.80 → +8 %) — the best single sign of a good bettor.
 */
import { pool } from '../db/client';
import { normalizeTeam } from '../utils/matchUtils';
import { sameMatch, type HintBet } from './betHints';

const saved = new Set<string>();

/** Upsert the closing line of every match whose line is new or changed since this process saved it. */
export function saveClosing(game: 'cs2' | 'dota2', matches: any[]): void {
  const k = (m: any) => `${m.id}:${m.closeCoeff1}:${m.closeCoeff2}`; // re-saved when the exact line replaces our last seen one
  const rows = matches.filter((m) => m.closeCoeff1 != null && m.closeCoeff2 != null && !saved.has(k(m)));
  if (!rows.length) return;
  const vals: unknown[] = [];
  const ph = rows.map((m, i) => { vals.push(m.id, game, m.nameTeam1, m.nameTeam2, m.date, m.closeCoeff1, m.closeCoeff2); const b = i * 7; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`; });
  void pool.query(
    `INSERT INTO closing_lines(match_id, game, team1, team2, date, close1, close2) VALUES ${ph.join(',')}
     ON CONFLICT (match_id) DO UPDATE SET close1 = EXCLUDED.close1, close2 = EXCLUDED.close2`, vals,
  ).then(() => rows.forEach((m) => saved.add(k(m)))).catch((e) => console.warn('[closing] save failed:', (e as Error).message));
}

export interface ClosingLine { betId: string; closing: number; clv: number }

/** «Beat the close»: for the bet's pick, its odds against the closing price — Match Winner bets of the last 60 days. */
export function clvFor(b: HintBet & { odds: number }, m: { team1: string; team2: string; close1: number; close2: number }): ClosingLine | null {
  if (String(b.betType).trim() !== 'Match Winner' || !(b.odds > 1)) return null;
  const sel = normalizeTeam(b.selection || '');
  const close = sel === normalizeTeam(m.team1) ? m.close1 : sel === normalizeTeam(m.team2) ? m.close2 : null;
  if (!close || close <= 1) return null;
  return { betId: b.id, closing: Math.round(close * 100) / 100, clv: Math.round((b.odds / close - 1) * 1000) / 10 };
}

export async function closingLines(userId: number): Promise<ClosingLine[]> {
  const bets = await pool.query<HintBet & { odds: string }>(
    `SELECT id, team1, team2, selection, bet_type AS "betType", game, to_char(date, 'YYYY-MM-DD') AS date, format, odds
     FROM bets WHERE user_id = $1 AND date >= CURRENT_DATE - 60`, [userId],
  );
  if (!bets.rows.length) return [];
  const lines = await pool.query<{ team1: string; team2: string; close1: string; close2: string; date: string; game: string }>(
    `SELECT team1, team2, close1, close2, to_char(date, 'YYYY-MM-DD') AS date, game FROM closing_lines WHERE date >= CURRENT_DATE - 63`,
  );
  const out: ClosingLine[] = [];
  for (const b of bets.rows) {
    const l = lines.rows.find((x) => sameMatch(b, { ...x, score1: null, score2: null }));
    const r = l && clvFor({ ...b, odds: Number(b.odds) }, { team1: l.team1, team2: l.team2, close1: Number(l.close1), close2: Number(l.close2) });
    if (r) out.push(r);
  }
  return out;
}
