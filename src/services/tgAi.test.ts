import { describe, it, expect } from 'vitest';
import { aiLine, answerProblem, currencyCode } from './tgAi';
import { parseTgPost } from './tgPostParser';

const at = '2026-08-04T14:05:00Z';
describe('the model answer → the parser', () => {
  it('a match winner on a match we do not have', () => {
    const line = aiLine({ isTip: true, game: 'dota2', team1: 'OG', team2: 'BB Team', market: 'match_winner', pick: 'BB Team', odds: 1.37 });
    expect(parseTgPost(line, at, [])).toMatchObject({ kind: 'bet', match: { team1: 'OG', team2: 'BB Team', game: 'dota2' }, market: 'Match Winner', pick: 'BB Team', odds: 1.37 });
  });
  it('a map bet, a total, a handicap, news', () => {
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'Iberian Soul', team2: 'Nemiga Gaming', market: 'map_winner', map: 1, pick: 'Nemiga Gaming', odds: 1.58 }), at, [])).toMatchObject({ kind: 'bet', market: 'Map 1 Winner', pick: 'Nemiga Gaming', match: { team1: 'Iberian Soul' }, odds: 1.58 });
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'GOSH', team2: 'Chinggis Warriors', market: 'handicap', pick: 'Chinggis Warriors (+1.5)', line: 1.5, odds: 2.26 }), at, [])).toMatchObject({ kind: 'bet', market: 'Handicap +1.5', pick: 'Chinggis Warriors' });
    expect(parseTgPost('Ninjas in Pyjamas против Team Liquid\nВторая карта - победитель Ninjas in Pyjamas 1.52', at, [])).toMatchObject({ kind: 'bet', market: 'Map 2 Winner', pick: 'Ninjas in Pyjamas', odds: 1.52 });
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'NAVI', team2: 'G2', market: 'total_maps', line: 2.5, over: true, odds: 1.9 }), at, [])).toMatchObject({ kind: 'bet', market: 'Total Maps Over 2.5', odds: 1.9 });
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'MOUZ', team2: 'G2', market: 'handicap', pick: 'MOUZ', line: -1.5, odds: 2.4 }), at, [])).toMatchObject({ kind: 'bet', market: 'Handicap -1.5', pick: 'MOUZ' });
    expect(aiLine({ isTip: false })).toBe('');
    const resp = (o: object) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
    expect(answerProblem(resp({ isTip: true, team1: 'Lynn Vision', team2: 'PARIVISIONValueError: Invalid game format … use valid json', market: 'map_winner', pick: 'Lynn Vision' }))).toBe('зіпсована назва команди у відповіді');
    expect(answerProblem(resp({ isTip: true, team1: 'Heroic', team2: 'FaZe' }))).toBe('прогноз без ринку');
    expect(answerProblem(resp({ isTip: true, team1: 'Heroic', team2: 'FaZe', market: 'map_winner', map: 3, pick: 'Heroic' }))).toBe('');
    expect(parseTgPost(aiLine({ isTip: true, game: 'cs2', team1: 'M80', team2: 'Eternal Fire', market: 'map_winner', map: 1, pick: 'M80', odds: 1.9 }), at, [])).toMatchObject({ kind: 'bet', market: 'Map 1 Winner', pick: 'M80' });
    expect([currencyCode('₴'), currencyCode('грн'), currencyCode('₽'), currencyCode('USDT'), currencyCode('$')]).toEqual(['UAH', 'UAH', 'RUB', 'USDT', 'USD']);
  });
});
