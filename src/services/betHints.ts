/**
 * «Підказка результату»: for a pending bet whose match has finished (series score known from Liquipedia),
 * say whether it looks like a win or a loss. Only for markets the series score decides:
 * Match Winner, Total Maps Over/Under N.5, Handicap ±N.5 — never expresses or map/round markets.
 * The user confirms the hint; nothing is settled automatically.
 */
import { pool } from '../db/client';
import { normalizeTeam } from '../utils/matchUtils';

export interface HintBet { id: string; team1: string | null; team2: string | null; selection: string | null; betType: string; game: string | null; date: string; format?: string | null }
export interface HintMatch { team1: string; team2: string; score1: number | null; score2: number | null; date: string; game: string }
export interface BetHint { betId: string; result: 'Win' | 'Loss'; score: string; match: string; date: string }

const gameKey = (g: string | null | undefined) => (/dota/i.test(g || '') ? 'dota2' : 'cs2');
const DAY = 86_400_000;

/** Same two teams (either order), match on the bet's day or up to 3 days later. */
export function sameMatch(b: HintBet, m: HintMatch): boolean {
  if (gameKey(b.game) !== gameKey(m.game)) return false;
  const bt = [normalizeTeam(b.team1 || ''), normalizeTeam(b.team2 || '')];
  const mt = [normalizeTeam(m.team1), normalizeTeam(m.team2)];
  if (!bt[0] || !bt[1] || !mt[0] || !mt[1]) return false;
  if (!((bt[0] === mt[0] && bt[1] === mt[1]) || (bt[0] === mt[1] && bt[1] === mt[0]))) return false;
  const d = (Date.parse(m.date) - Date.parse(b.date)) / DAY;
  return d >= 0 && d <= 3;
}

/** Win / Loss from the series score, or null when the market or the data does not decide it. */
export function resultFor(b: HintBet, m: HintMatch): 'Win' | 'Loss' | null {
  if (m.score1 == null || m.score2 == null || (m.score1 === 0 && m.score2 === 0)) return null;
  const type = String(b.betType || '').trim();
  if (/експрес|\|/i.test(type) || /x/i.test(b.format || '')) return null;
  const sel = normalizeTeam(b.selection || '');
  const mine = sel && sel === normalizeTeam(m.team1) ? m.score1 - m.score2 : sel && sel === normalizeTeam(m.team2) ? m.score2 - m.score1 : null;

  if (type === 'Match Winner') {
    if (mine == null || mine === 0) return null; // no pick, or a draw (BO2)
    return mine > 0 ? 'Win' : 'Loss';
  }
  const total = /^Total Maps (Over|Under) (\d+(?:\.5))$/i.exec(type);
  if (total) {
    const maps = m.score1 + m.score2, line = Number(total[2]);
    return (total[1].toLowerCase() === 'over' ? maps > line : maps < line) ? 'Win' : 'Loss';
  }
  const hcp = /^Handicap ([+-]\d+(?:\.5))$/i.exec(type);
  if (hcp && mine != null) return mine + Number(hcp[1]) > 0 ? 'Win' : 'Loss';
  return null;
}

/** Hints for the user's pending bets of the last 14 days. */
export async function betHints(userId: number): Promise<BetHint[]> {
  const bets = await pool.query<HintBet>(
    `SELECT id, team1, team2, selection, bet_type AS "betType", game, to_char(date, 'YYYY-MM-DD') AS date, format
     FROM bets WHERE user_id = $1 AND result = 'Pending' AND date >= CURRENT_DATE - 14`, [userId],
  );
  if (!bets.rows.length) return [];
  const matches = await pool.query<HintMatch>(
    `SELECT team1, team2, score1, score2, to_char(date, 'YYYY-MM-DD') AS date, game
     FROM matches_history WHERE status = 'finished' AND date >= CURRENT_DATE - 14`,
  );
  const out: BetHint[] = [];
  for (const b of bets.rows) {
    const m = matches.rows.find((x) => sameMatch(b, x));
    const r = m && resultFor(b, m);
    if (!m || !r) continue;
    // the score in the bet's own team order (the card shows «team1 — team2» of the bet)
    const same = normalizeTeam(b.team1 || '') === normalizeTeam(m.team1);
    out.push({ betId: b.id, result: r, score: same ? `${m.score1}:${m.score2}` : `${m.score2}:${m.score1}`, match: `${m.team1} vs ${m.team2}`, date: m.date });
  }
  return out;
}
