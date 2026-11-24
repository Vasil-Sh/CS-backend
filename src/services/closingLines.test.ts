import { describe, expect, it } from 'vitest';
import { clvFor } from './closingLines';

const bet = (o: Partial<Parameters<typeof clvFor>[0]> = {}) => ({ id: 'b1', team1: 'NAVI', team2: 'FaZe', selection: 'NAVI', betType: 'Match Winner', game: 'CS2', date: '2026-11-24', odds: 1.95, ...o });
const line = { team1: 'Natus Vincere', team2: 'FaZe Clan', close1: 1.8, close2: 2.05 };

describe('closing line value', () => {
  it('compares the pick\'s odds with its closing price', () => {
    expect(clvFor(bet(), { ...line, team1: 'NAVI', team2: 'FaZe' })).toEqual({ betId: 'b1', closing: 1.8, clv: 8.3 });
    expect(clvFor(bet({ selection: 'FaZe', odds: 1.9 }), { ...line, team1: 'NAVI', team2: 'FaZe' })).toEqual({ betId: 'b1', closing: 2.05, clv: -7.3 });
  });
  it('says nothing for other markets or an unknown pick', () => {
    expect(clvFor(bet({ betType: 'Total Maps Over 2.5' }), { ...line, team1: 'NAVI', team2: 'FaZe' })).toBeNull();
    expect(clvFor(bet({ selection: 'G2' }), { ...line, team1: 'NAVI', team2: 'FaZe' })).toBeNull();
  });
});
