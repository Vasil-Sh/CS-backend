import { describe, expect, it } from 'vitest';
import { median, tgPriceOf } from './tgMarket';

describe('Ринок Telegram', () => {
  it('takes the median price on each team, one price a channel (its last)', () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const p = tgPriceOf({ nameTeam1: 'NAVI', nameTeam2: 'PARIVISION' }, [
      { pick: 'PARIVISION', odds: 1.9, handle: 'a' }, { pick: 'parivision', odds: 1.6, handle: 'a' }, // a's last tip counts
      { pick: 'PARIVISION', odds: 1.7, handle: 'b' }, { pick: 'NAVI', odds: 2.2, handle: 'c' }, { pick: 'Spirit', odds: 3, handle: 'd' },
    ], same);
    expect(p).toEqual({ c1: 2.2, c2: 1.65, channels: 3 });
    expect(median([])).toBeNull(); expect(median([1.5, 1.7, 2.1])).toBe(1.7);
  });
});
