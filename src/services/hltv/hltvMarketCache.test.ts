import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { TipsGgMatch } from '../tipsggScraper';

const mocks = vi.hoisted(() => ({
  newPage: vi.fn(), write: vi.fn(), rename: vi.fn(),
}));
vi.mock('../tipsggScraper', () => ({ getBrowser: async () => ({ newPage: mocks.newPage }) }));
vi.mock('node:fs', () => ({
  existsSync: () => false, readFileSync: vi.fn(), mkdirSync: vi.fn(),
  writeFileSync: mocks.write, renameSync: mocks.rename,
}));
const match = {
  nameTeam1: 'FaZe', nameTeam2: 'ASTRAL',
  link: 'https://www.hltv.org/matches/2399610/faze-vs-astral',
  status: 'upcoming', startDate: '2026-10-20T11:00:00Z',
  pred1: null, pred2: null, coeff1: null, coeff2: null,
} as TipsGgMatch;
function page(html: string, status = 200) {
  return {
    goto: vi.fn().mockResolvedValue({ ok: () => status === 200, status: () => status }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(html),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
describe('background HLTV market cache', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('returns immediately, deduplicates work and overlays cached values on the next response', async () => {
    const listing = page('<div class="match-wrapper"></div>');
    const detail = page('<div class="teamsBox"><span class="teamName">FaZe</span><span class="teamName">ASTRAL</span></div><span class="pick-a-winner-team-percentage team-1">92.1%</span><span class="pick-a-winner-team-percentage team-2">7.9%</span>');
    mocks.newPage.mockResolvedValueOnce(listing).mockResolvedValueOnce(detail);
    const { withHltvMarkets } = await import('./hltvMarketCache');
    expect(withHltvMarkets([match])[0].pred1).toBeNull();
    withHltvMarkets([match]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(withHltvMarkets([match])[0].pred1).toBe(92.1);
    expect(mocks.newPage).toHaveBeenCalledTimes(2);
    expect(detail.close).toHaveBeenCalled();
    expect(mocks.rename).toHaveBeenCalled();
  });
  it('stops on 403, closes the page and leaves missing data null', async () => {
    const denied = page('', 403);
    mocks.newPage.mockResolvedValue(denied);
    const { withHltvMarkets } = await import('./hltvMarketCache');
    withHltvMarkets([match]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(withHltvMarkets([match])[0].coeff1).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    withHltvMarkets([match]);
    expect(mocks.newPage).toHaveBeenCalledTimes(1);
    expect(denied.close).toHaveBeenCalled();
  });
  it('expires values instead of presenting stale percentages as current', async () => {
    mocks.newPage.mockResolvedValueOnce(page(''))
      .mockResolvedValueOnce(page('<div class="teamsBox"><span class="teamName">FaZe</span><span class="teamName">ASTRAL</span></div><span class="pick-a-winner-team-percentage team-1">90%</span><span class="pick-a-winner-team-percentage team-2">10%</span>'));
    const { withHltvMarkets } = await import('./hltvMarketCache');
    withHltvMarkets([match]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(withHltvMarkets([match])[0].pred1).toBe(90);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    mocks.newPage.mockResolvedValue(page('', 403));
    expect(withHltvMarkets([match])[0].pred1).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
  });
});
