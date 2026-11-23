import { describe, expect, it } from 'vitest';
import { resultFor, sameMatch, type HintBet, type HintMatch } from './betHints';

const bet = (o: Partial<HintBet>): HintBet => ({ id: 'b', team1: 'Team Spirit', team2: 'Vitality', selection: 'Team Spirit', betType: 'Match Winner', game: 'CS2', date: '2026-11-22', ...o });
const m: HintMatch = { team1: 'Vitality', team2: 'Spirit', score1: 1, score2: 2, date: '2026-11-23', game: 'cs2' };

describe('bet result hints', () => {
  it('finds the match: same teams in any order and spelling, within 3 days after the bet', () => {
    expect(sameMatch(bet({}), m)).toBe(true);
    expect(sameMatch(bet({ date: '2026-11-19' }), m)).toBe(false);
    expect(sameMatch(bet({ date: '2026-11-24' }), m)).toBe(false);
    expect(sameMatch(bet({ game: 'Dota 2' }), m)).toBe(false);
    expect(sameMatch(bet({ team2: 'G2' }), m)).toBe(false);
  });
  it('match winner', () => {
    expect(resultFor(bet({}), m)).toBe('Win');
    expect(resultFor(bet({ selection: 'Vitality' }), m)).toBe('Loss');
    expect(resultFor(bet({ selection: '' }), m)).toBeNull();
    expect(resultFor(bet({}), { ...m, score1: 1, score2: 1 })).toBeNull(); // BO2 draw
  });
  it('total maps and handicap', () => {
    expect(resultFor(bet({ betType: 'Total Maps Over 2.5' }), m)).toBe('Win');
    expect(resultFor(bet({ betType: 'Total Maps Under 2.5' }), m)).toBe('Loss');
    expect(resultFor(bet({ betType: 'Handicap -1.5' }), m)).toBe('Loss'); // won 2:1, -1.5 not covered
    expect(resultFor(bet({ betType: 'Handicap +1.5', selection: 'Vitality' }), m)).toBe('Win'); // lost 1:2, +1.5 covers
  });
  it('no hint for other markets, expresses or an unknown score', () => {
    expect(resultFor(bet({ betType: 'MapWinner' }), m)).toBeNull();
    expect(resultFor(bet({ betType: 'Експрес' }), m)).toBeNull();
    expect(resultFor(bet({}), { ...m, score1: 0, score2: 0 })).toBeNull();
  });
});
