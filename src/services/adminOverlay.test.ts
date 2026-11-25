import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.fn(async () => {});
vi.mock('../db/client', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('./matchHistoryService', () => ({ upsertMatchHistory: (...a: unknown[]) => upsert(...(a as [])) }));

import { adminMatchesService } from './adminMatchesService';
import type { TipsGgMatch } from './matchTypes';

const m = (over: Partial<TipsGgMatch>): TipsGgMatch => ({ id: 'lp-1', date: '2026-11-25', nameTeam1: 'Team Spirit Academy', nameTeam2: 'Angry Birds', status: 'live', score1: null, score2: null, type: 'BO3', tournament: 'EPL', stage: '', startDate: '2026-11-25T16:00:00Z', logoTeam1: null, logoTeam2: null, ...over } as TipsGgMatch);
const override = { matchId: 'lp-1', game: 'dota2', status: 'finished', startDate: null, score1: 2, score2: 1, decidedBy: 'admin', updatedAt: '' };

describe('overlay: the admin score is temporary', () => {
  beforeEach(() => {
    upsert.mockClear();
    vi.spyOn(adminMatchesService, 'listOverrides').mockResolvedValue([override] as never);
    vi.spyOn(adminMatchesService, 'listManualMatches').mockResolvedValue([]);
  });

  it('stands while the source has no result — and goes to the history', async () => {
    const out = await adminMatchesService.overlayAdminMatches('dota2', [m({ status: 'live', score1: 0, score2: 0 })]);
    expect(out[0]).toMatchObject({ status: 'finished', score1: 2, score2: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ id: 'lp-1', score1: 2, score2: 1, status: 'finished' });
  });

  it('stands over a finished 0:0 (no score yet)', async () => {
    const out = await adminMatchesService.overlayAdminMatches('dota2', [m({ id: 'lp-1', status: 'finished', score1: null, score2: null })]);
    expect(out[0]).toMatchObject({ score1: 2, score2: 1 });
  });

  it('gives way to the source result once it has one — without asking', async () => {
    const out = await adminMatchesService.overlayAdminMatches('dota2', [m({ status: 'finished', score1: 2, score2: 0 })]);
    expect(out[0]).toMatchObject({ status: 'finished', score1: 2, score2: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
