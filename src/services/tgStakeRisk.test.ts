import { describe, expect, it } from 'vitest';
import { stakeRiskOf } from './tgHonesty';

describe('stakeRiskOf', () => {
  it('flags the big stake that ate the profit of many small wins', () => {
    const slips = Array.from({ length: 10 }, (_, i) => ({ postId: i + 1, stake: 100, result: 'Win', profit: 20 }));
    slips.push({ postId: 11, stake: 2000, result: 'Loss', profit: -2000 });
    const r = stakeRiskOf(slips, 91)!;
    expect(r.usual).toBe(100);
    expect(r.big.map((x) => x.postId)).toEqual([11]);
    expect(r.biggest.stake).toBe(2000);
    expect(r.worst?.profit).toBe(-2000);
    expect(r.total).toBe(-1800);
    expect(r.moneyWinrate).toBe(33);
    expect(r.warn).toBe(true);
  });
  it('no warning when the money is up; no «usual» under 5 slips', () => {
    const r = stakeRiskOf([{ postId: 1, stake: 100, result: 'Win', profit: 80 }, { postId: 2, stake: 100, result: 'Loss', profit: -100 }, { postId: 3, stake: 100, result: 'Win', profit: 90 }], 67)!;
    expect(r.warn).toBe(false);
    expect(r.usual).toBeNull();
    expect(r.big).toEqual([]);
    expect(stakeRiskOf([], 50)).toBeNull();
  });
});
