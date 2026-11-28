import { describe, expect, it } from 'vitest';
import { addPolymarket, eventToMatch, gameOfSport, mergePolyMatches, parseTitle, priceToOdds } from './polymarketFeed';
import type { TipsGgMatch } from './matchTypes';

describe('polymarket', () => {
  it('reads the title', () => {
    expect(parseTitle('Counter-Strike: SPARTA vs Rune Eaters (BO3) - CCT Europe Series #6 Group Stage')).toEqual({ team1: 'SPARTA', team2: 'Rune Eaters', bo: 3, tournament: 'CCT Europe Series #6 Group Stage' });
    expect(parseTitle('Dota 2: BetBoom Team vs GamerLegion (BO2) - 1win Essence Group A')?.team2).toBe('GamerLegion');
    expect(parseTitle('Will it rain?')).toBeNull();
  });
  it('knows the games and turns prices into odds', () => {
    expect(gameOfSport('cs2')).toBe('cs2'); expect(gameOfSport('CSGO')).toBe('cs2'); expect(gameOfSport('dota2')).toBe('dota2'); expect(gameOfSport('lol')).toBeNull();
    expect(priceToOdds('0.62')).toBe(1.61); expect(priceToOdds(0.995)).toBeNull();
  });
  it('takes the moneyline prices in the title order', () => {
    const ev = { id: 7, title: 'Dota 2: Enjoy vs Yakult Brothers (BO3) - Games of the Future Group C', startTime: '2026-11-28T15:00:00Z',
      markets: [{ sportsMarketType: 'child_moneyline', outcomes: '["Enjoy","Yakult Brothers"]', outcomePrices: '["0.5","0.5"]' },
        { sportsMarketType: 'moneyline', outcomes: '["Yakult Brothers","Enjoy"]', outcomePrices: '["0.47","0.53"]' }] };
    const m = eventToMatch(ev, 'dota2', Date.parse('2026-11-28T10:00:00Z'))!;
    expect(m).toMatchObject({ team1: 'Enjoy', team2: 'Yakult Brothers', c1: 1.89, c2: 2.13, bo: 3 });
  });
  it('keeps the last price before the start as the closing line', () => {
    const t0 = Date.parse('2026-11-28T10:00:00Z');
    const m = { id: '1', game: 'cs2' as const, team1: 'A', team2: 'B', start: '2026-11-28T12:00:00Z', tournament: '', bo: 3, c1: 1.5, c2: 2.6, close1: null, close2: null, closed: false };
    const a = mergePolyMatches([], [m], t0);
    expect(a[0].close1).toBe(1.5);
    const b = mergePolyMatches(a, [{ ...m, c1: 1.1, c2: 7 }], Date.parse('2026-11-28T13:00:00Z')); // live: the close stays
    expect(b[0].close1).toBe(1.5); expect(b[0].c1).toBe(1.1);
    const c = mergePolyMatches(b, [], Date.parse('2026-11-28T20:00:00Z')); // gone from the list: kept, closed
    expect(c[0].closed).toBe(true);
  });
  it('puts the prices on our match, swapped when the teams are', () => {
    const ours = [{ nameTeam1: 'Rune Eaters', nameTeam2: 'SPARTA', startDate: '2026-11-28T12:30:00Z' } as TipsGgMatch];
    const n = addPolymarket(ours, [{ id: '1', game: 'cs2', team1: 'SPARTA', team2: 'Rune Eaters', start: '2026-11-28T12:00:00Z', tournament: '', bo: 3, c1: 1.4, c2: 3.2, close1: 1.45, close2: 3.0, closed: false }], (a, b) => a === b, 'cs2');
    expect(n).toBe(1); expect(ours[0].pmCoeff1).toBe(3.2); expect(ours[0].pmClose2).toBe(1.45);
  });
});
