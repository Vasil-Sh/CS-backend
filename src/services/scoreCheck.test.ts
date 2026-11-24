import { describe, it, expect, beforeEach } from 'vitest';
import { checkScores, scoreIssues, __resetScoreCheck, CLOSE_AFTER_MS, type Report } from './scoreCheck';
import type { TipsGgMatch } from './matchTypes';

const NOW = Date.parse('2026-11-24T20:00:00Z');
const match = (over: Partial<TipsGgMatch> = {}): TipsGgMatch => ({ id: 'lp-1', date: '2026-11-24', link: '', type: 'BO3', score1: null, score2: null, nameTeam1: 'Spirit', nameTeam2: 'FaZe', logoTeam1: null, logoTeam2: null, tournament: 'PGL', stage: '', status: 'live', tipsCount: 0, performer: null, startDate: '2026-11-24T15:00:00Z', pred1: null, pred2: null, coeff1: null, coeff2: null, positionTeam1: null, positionTeam2: null, tournamentLogo: null, ...over });
const r = (source: Report['source'], s1: number, s2: number, status: Report['status'] = 'finished'): Report => ({ source, status, s1, s2 });

describe('checkScores', () => {
  beforeEach(() => __resetScoreCheck());

  it('two sources agreeing close the match only after 2 h', () => {
    const m = match();
    checkScores('cs2', [m], new Map([[m, [r('pandascore', 2, 1), r('cito', 2, 1)]]]), NOW);
    expect(m.status).toBe('live');
    const m2 = match();
    checkScores('cs2', [m2], new Map([[m2, [r('pandascore', 2, 1), r('cito', 2, 1)]]]), NOW + CLOSE_AFTER_MS);
    expect(m2).toMatchObject({ status: 'finished', score1: 2, score2: 1, closedBy: 'cito+pandascore' });
  });

  it('one source, or two that disagree, never close it', () => {
    const a = match(), b = match({ id: 'lp-2' });
    checkScores('cs2', [a, b], new Map([[a, [r('pandascore', 2, 1)]], [b, [r('pandascore', 2, 1), r('cito', 1, 2)]]]), NOW);
    checkScores('cs2', [a, b], new Map([[a, [r('pandascore', 2, 1)]], [b, [r('pandascore', 2, 1), r('cito', 1, 2)]]]), NOW + 3 * CLOSE_AFTER_MS);
    expect([a.status, b.status]).toEqual(['live', 'live']);
  });

  it('a finished score that differs from another source is listed as a conflict', async () => {
    const m = match({ status: 'finished', score1: 2, score2: 0 });
    expect(checkScores('cs2', [m], new Map([[m, [r('pandascore', 2, 1)]]]), NOW)).toEqual({ conflicts: 1, closed: 0 });
    const list = await scoreIssues();
    expect(list[0]).toMatchObject({ kind: 'conflict', ours: '2:0', theirs: [{ source: 'pandascore', score: '2:1' }] });
  });
});

describe('sameResult (rounds vs maps)', () => {
  it('13:8 in rounds = 1:0 in maps; 9:13 = 0:1; 2:1 ≠ 2:0', async () => {
    const { sameResult } = await import('./scoreCheck');
    expect(sameResult(13, 8, 1, 0)).toBe(true);
    expect(sameResult(9, 13, 0, 1)).toBe(true);
    expect(sameResult(13, 8, 0, 1)).toBe(false);
    expect(sameResult(2, 1, 2, 0)).toBe(false);
  });
  it('a BO1 in rounds is not a conflict, and an old false one is cleared', async () => {
    __resetScoreCheck();
    const m = match({ status: 'finished', score1: 2, score2: 0 });
    checkScores('cs2', [m], new Map([[m, [r('cito', 1, 0)]]]), NOW);
    expect((await scoreIssues())).toHaveLength(1);
    const m2 = match({ status: 'finished', score1: 13, score2: 8 });
    checkScores('cs2', [m2], new Map([[m2, [r('cito', 1, 0)]]]), NOW);
    expect(await scoreIssues()).toHaveLength(0);
  });
});

describe('a closed match later finished by Liquipedia', () => {
  it('same result → leaves the list; another → becomes a conflict', async () => {
    __resetScoreCheck();
    const a = match({ id: 'lp-a' }), b = match({ id: 'lp-b' });
    const rep = (m: TipsGgMatch) => new Map([[m, [r('pandascore', 2, 1), r('cito', 2, 1)]]]);
    checkScores('cs2', [a, b], new Map([...rep(a), ...rep(b)]), NOW);
    const a2 = match({ id: 'lp-a' }), b2 = match({ id: 'lp-b' });
    checkScores('cs2', [a2, b2], new Map([...rep(a2), ...rep(b2)]), NOW + CLOSE_AFTER_MS);
    expect((await scoreIssues()).map((x) => `${x.kind}:${x.id}`).sort()).toEqual(['closed:lp-a', 'closed:lp-b']);
    const a3 = match({ id: 'lp-a', status: 'finished', score1: 2, score2: 1 }), b3 = match({ id: 'lp-b', status: 'finished', score1: 0, score2: 2 });
    checkScores('cs2', [a3, b3], new Map([...rep(a3), ...rep(b3)]), NOW + CLOSE_AFTER_MS + 60_000);
    expect((await scoreIssues()).map((x) => `${x.kind}:${x.id}`)).toEqual(['conflict:lp-b']);
  });
});
