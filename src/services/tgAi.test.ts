import { describe, it, expect } from 'vitest';
import { aiLine } from './tgAi';
import { parseTgPost } from './tgPostParser';

const at = '2026-08-04T14:05:00Z';
describe('the model answer → the parser', () => {
  it('a match winner on a match we do not have', () => {
    const line = aiLine({ isTip: true, game: 'dota2', team1: 'OG', team2: 'BB Team', market: 'match_winner', pick: 'BB Team', odds: 1.37 });
    expect(parseTgPost(line, at, [])).toMatchObject({ kind: 'bet', match: { team1: 'OG', team2: 'BB Team', game: 'dota2' }, market: 'Match Winner', pick: 'BB Team', odds: 1.37 });
  });
  it('a map bet, a total, a handicap, news', () => {
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'Iberian Soul', team2: 'Nemiga Gaming', market: 'map_winner', map: 1, pick: 'Nemiga Gaming', odds: 1.58 }), at, [])).toMatchObject({ kind: 'unknown', reason: 'Ставки на окрему карту поки не рахуємо', odds: 1.58 });
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'NAVI', team2: 'G2', market: 'total_maps', line: 2.5, over: true, odds: 1.9 }), at, [])).toMatchObject({ kind: 'bet', market: 'Total Maps Over 2.5', odds: 1.9 });
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'MOUZ', team2: 'G2', market: 'handicap', pick: 'MOUZ', line: -1.5, odds: 2.4 }), at, [])).toMatchObject({ kind: 'bet', market: 'Handicap -1.5', pick: 'MOUZ' });
    expect(aiLine({ isTip: false })).toBe('');
  });
});
