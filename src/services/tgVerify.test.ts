import { describe, it, expect } from 'vitest';
import { winnersFromScores, sameName, placedLive } from './tgVerify';
import { psMapWinners } from './pandascoreFeed';
import { abbreviations } from '../utils/teamAbbrev';

describe('our own check of the tips', () => {
  it('map winners from map scores: a map counts once it is won', () => {
    expect(winnersFromScores([{ score1: 13, score2: 7 }, { score1: 9, score2: 13 }, { score1: 6, score2: 4 }], false)).toEqual([1, 2]);
    expect(winnersFromScores([{ score1: 13, score2: 7 }, { score1: 16, score2: 14 }], true)).toEqual([1, 1]);
  });
  it('map winners from PandaScore games', () => {
    expect(psMapWinners({ id: 1, opponents: [{ opponent: { id: 10 } }, { opponent: { id: 20 } }], games: [{ position: 2, status: 'finished', winner: { id: 10 } }, { position: 1, status: 'finished', winner: { id: 20 } }, { position: 3, status: 'running', winner: null }] })).toEqual([2, 1]);
  });
  it('team names written short or in full are one team', () => {
    expect(sameName('NAVI', 'Natus Vincere')).toBe(true);
    expect(sameName('Team Liquid', 'Liquid')).toBe(true);
    expect(sameName('MOUZ', 'G2')).toBe(false);
    expect(abbreviations('Ninjas in Pyjamas')).toContain('nip');
    expect(abbreviations('Natus Vincere')).toContain('navi');
  });
  it('a tip posted after the start is live', () => {
    const feed = [{ id: 'm1', game: 'cs2' as const, team1: 'A', team2: 'B', start: '2026-11-26T10:00:00Z', status: 'live', score1: 1, score2: 0 }];
    expect(placedLive('m1', '2026-11-26T10:30:00Z', feed)).toBe(true);
    expect(placedLive('m1', '2026-11-26T09:30:00Z', feed)).toBe(false);
  });
});
