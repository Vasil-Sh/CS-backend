import { describe, it, expect } from 'vitest';
import { addExtra, shortFor } from './matchFeed';

describe('two sources, one match', () => {
  it('«NAVI Junior» is short for «Natus Vincere Junior», «MOUZ» is not short for «MOUZ NXT»', () => {
    expect(shortFor('NAVI Junior', 'Natus Vincere Junior')).toBe(true);
    expect(shortFor('NIP', 'Ninjas in Pyjamas')).toBe(true);
    expect(shortFor('MOUZ', 'MOUZ NXT')).toBe(false);
    expect(shortFor('ENCE', 'Eternal Fire')).toBe(false);
  });
  it('the same-time match of another source with an abbreviated team is not added twice', () => {
    const at = '2026-11-26T09:00:00Z';
    const m = (id: string, a: string, b: string) => ({ id, nameTeam1: a, nameTeam2: b, startDate: at, status: 'upcoming' }) as never;
    const list = [m('lp-1', 'Natus Vincere Junior', 'WOPA Esports')];
    expect(addExtra(list, [m('ps-1', 'NAVI Junior', 'STATE')])).toBe(0);
    expect(list).toHaveLength(1);
  });
});
