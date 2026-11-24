import { describe, it, expect } from 'vitest';
import { citoToMatch, citoEveryMs } from './citoFeed';
import { addCito } from './matchFeed';
import type { TipsGgMatch } from './matchTypes';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ours = (t1: string, t2: string, start: string, extra: Partial<TipsGgMatch> = {}): TipsGgMatch =>
  ({ id: `lp-${t1}-${t2}`, date: start.slice(0, 10), link: '', type: 'BO3', score1: null, score2: null, nameTeam1: t1, nameTeam2: t2, logoTeam1: null, logoTeam2: null, tournament: '', stage: '', status: 'upcoming', tipsCount: 0, performer: null, startDate: start, pred1: null, pred2: null, coeff1: null, coeff2: null, positionTeam1: null, positionTeam2: null, tournamentLogo: null, ...extra });
const cito = (id: string, t1: string, t2: string, startsAt: string, more: Record<string, unknown> = {}) =>
  citoToMatch({ id, team1Name: t1, team2Name: t2, startsAt, bestOf: 3, eventName: 'CCT Europe', status: 'upcoming', ...more }, NOW)!;

describe('citoToMatch', () => {
  it('maps fields and the series length', () => {
    const m = cito('77', 'Vitality', 'MOUZ', '2026-11-25T15:00:00Z', { bestOf: 1 });
    expect(m).toMatchObject({ id: 'ct-77', type: 'BO1', status: 'upcoming', tournament: 'CCT Europe', score1: null });
  });
  it('drops TBD and cancelled matches', () => {
    expect(citoToMatch({ id: '1', team1Name: 'TBD', team2Name: 'NAVI', startsAt: '2026-11-25T15:00:00Z' }, NOW)).toBeNull();
    expect(citoToMatch({ id: '2', team1Name: 'G2', team2Name: 'NAVI', startsAt: '2026-11-25T15:00:00Z', status: 'cancelled' }, NOW)).toBeNull();
  });
  it('a started match is live, a completed one keeps its score', () => {
    expect(cito('3', 'G2', 'FaZe', '2026-11-24T11:00:00Z').status).toBe('live');
    const f = cito('4', 'G2', 'FaZe', '2026-11-24T08:00:00Z', { status: 'completed', team1Score: 2, team2Score: 1 });
    expect([f.status, f.score1, f.score2]).toEqual(['finished', 2, 1]);
  });
});

describe('addCito', () => {
  it('skips the same match (swapped teams, other start) and adds a new one', () => {
    const list = [ours('Team Spirit', 'NAVI', '2026-11-25T15:00:00Z')];
    const n = addCito(list, [cito('1', 'NAVI', 'Spirit', '2026-11-25T16:30:00Z'), cito('2', 'Aurora', 'HEROIC', '2026-11-25T18:00:00Z')]);
    expect(n).toBe(1);
    expect(list.map((m) => m.id)).toEqual(['lp-Team Spirit-NAVI', 'ct-2']);
  });
  it('one team at the same time is the same match (other spelling of the other team)', () => {
    const list = [ours('NAVI', 'FaZe', '2026-11-25T15:00:00Z')];
    expect(addCito(list, [cito('1', 'Natus Vincere', 'FaZe Clan', '2026-11-25T15:10:00Z')])).toBe(0);
  });
  it('fills a missing final score the right way round', () => {
    const m = ours('G2', 'FaZe', '2026-11-24T08:00:00Z', { status: 'finished' });
    addCito([m], [cito('4', 'FaZe', 'G2', '2026-11-24T08:00:00Z', { status: 'completed', team1Score: 2, team2Score: 0 })]);
    expect([m.score1, m.score2]).toEqual([0, 2]);
  });
});

describe('citoEveryMs', () => {
  it('spreads the month and keeps a floor', () => {
    const mid = Date.parse('2026-11-16T00:00:00Z'); // 15 days left
    expect(citoEveryMs(500, 2 / 3, 90 * 60_000, mid)).toBe(90 * 60_000); // 1.1 h by budget → the 1.5 h floor
    expect(citoEveryMs(200, 2 / 3, 90 * 60_000, mid) / 3_600_000).toBeCloseTo(15 * 24 / Math.floor(185 * 2 / 3), 1);
    expect(citoEveryMs(10, 2 / 3, 1, mid)).toBe(Infinity);
  });
});
