import { describe, it, expect } from 'vitest';
import { mergeSameTimeDuplicates } from './matchUtils';

const m = (id: string, t1: string, t2: string, start: string, extra: Record<string, unknown> = {}) =>
  ({ id, nameTeam1: t1, nameTeam2: t2, startDate: start, status: 'upcoming', score1: null, score2: null, coeff1: null, coeff2: null, logoTeam1: null, logoTeam2: null, ...extra });

describe('mergeSameTimeDuplicates', () => {
  it('PVISION / PARIVISION vs FaZe at the same time → one match, the ticker copy, with the odds of the other', () => {
    const list = [
      m('lp-cs2-2026-11-25-pvision-vs-faze-clan', 'PVISION', 'FaZe Clan', '2026-11-25T07:00:00Z'),
      m('lp-cs2-2026-11-25-parivision-vs-faze-clan', 'PARIVISION', 'FaZe Clan', '2026-11-25T07:00:00Z', { fromPage: true, coeff1: 1.8, coeff2: 2.0 }),
    ];
    const out = mergeSameTimeDuplicates(list);
    expect(out.map((x) => x.id)).toEqual(['lp-cs2-2026-11-25-pvision-vs-faze-clan']);
    expect([out[0].coeff1, out[0].coeff2]).toEqual([1.8, 2.0]);
  });
  it('swapped teams from PandaScore: Liquipedia stays, odds turned round', () => {
    const out = mergeSameTimeDuplicates([
      m('ps-1', 'FaZe', 'G2', '2026-11-25T10:00:00Z', { coeff1: 1.5, coeff2: 2.6 }),
      m('lp-x', 'G2 Esports', 'FaZe Clan', '2026-11-25T11:30:00Z'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['lp-x']);
    expect([out[0].coeff1, out[0].coeff2]).toEqual([2.6, 1.5]);
  });
  it('a team with two matches hours apart, and manual matches, are left alone', () => {
    const list = [
      m('lp-a', 'Vitality', 'MOUZ', '2026-11-25T10:00:00Z'),
      m('lp-b', 'Vitality', 'NAVI', '2026-11-25T14:00:00Z'),
      m('manual-1', 'Vitality', 'MOUZ', '2026-11-25T10:00:00Z'),
    ];
    expect(mergeSameTimeDuplicates(list)).toHaveLength(3);
  });
  it('a finished score is not copied onto a live copy', () => {
    const out = mergeSameTimeDuplicates([
      m('lp-a', 'Spirit', 'Tundra', '2026-11-25T10:00:00Z', { status: 'live' }),
      m('ps-2', 'Team Spirit', 'Tundra', '2026-11-25T10:05:00Z', { status: 'finished', score1: 2, score2: 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect([out[0].status, out[0].score1]).toEqual(['live', null]);
  });
});
