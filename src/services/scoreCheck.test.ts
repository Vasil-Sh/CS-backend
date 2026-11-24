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
