/**
 * How honest a channel is, 0–100: of its settled tips, the share that is not suspect.
 * Suspect: a result the channel claimed that our score disproves (a mismatch), a losing tip the channel deleted,
 * and — at half weight — a tip posted after the match had started that then won (it may have been posted already knowing the score).
 */
export function honestyOf(c: { settled: number; mismatches: number; deletedLost: number; liveWon: number }): number | null {
  if (c.settled < 1) return null;
  const bad = c.mismatches + c.deletedLost + c.liveWon * 0.5;
  return Math.max(0, Math.round(100 * (1 - bad / c.settled)));
}

/** «Відіграш»: the average stake right after a lost slip and right after a won one; chasing — 30%+ more after a loss (3+ of each). */
export function chaseOf(slips: { stake: number; result: string }[]): { afterLoss: number; afterWin: number; nLoss: number; nWin: number; rise: number; chasing: boolean } | null {
  const L: number[] = [], W: number[] = [];
  for (let i = 1; i < slips.length; i++) { const prev = slips[i - 1].result; if (prev === 'Loss') L.push(slips[i].stake); else if (prev === 'Win') W.push(slips[i].stake); }
  if (L.length < 3 || W.length < 3) return null;
  const avg = (a: number[]) => Math.round((a.reduce((x, v) => x + v, 0) / a.length) * 100) / 100;
  const afterLoss = avg(L), afterWin = avg(W), rise = afterWin ? Math.round((afterLoss / afterWin - 1) * 100) : 0;
  return { afterLoss, afterWin, nLoss: L.length, nWin: W.length, rise, chasing: rise >= 30 };
}

export interface RiskSlip { postId: number; stake: number; result: string; profit: number }
/** «Великі ставки» and «вінрейт у грошах» of a channel's slips (one currency):
 *  usual — the median stake (5+ slips); big — the slips staked 5× the usual or more; biggest — the largest stake; worst — the biggest loss;
 *  moneyWinrate — the share of the money staked that won; warn — a high winrate (55%+) while the money is in the red. */
export function stakeRiskOf(slips: RiskSlip[], winrate: number | null) {
  const settled = slips.filter((x) => x.result === 'Win' || x.result === 'Loss');
  if (!settled.length) return null;
  const s = settled.map((x) => x.stake).sort((a, b) => a - b), m = Math.floor(s.length / 2);
  const usual = s.length >= 5 ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
  const big = usual ? settled.filter((x) => x.stake >= usual * 5) : [];
  const biggest = settled.reduce((a, x) => (x.stake > a.stake ? x : a));
  const worst = settled.reduce((a, x) => (x.profit < a.profit ? x : a));
  const staked = settled.reduce((a, x) => a + x.stake, 0), wonStake = settled.filter((x) => x.result === 'Win').reduce((a, x) => a + x.stake, 0);
  const total = Math.round(settled.reduce((a, x) => a + x.profit, 0) * 100) / 100;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    usual: usual != null ? r2(usual) : null, total,
    big: big.map((x) => ({ ...x, profit: r2(x.profit) })),
    biggest: { ...biggest, profit: r2(biggest.profit) }, worst: worst.profit < 0 ? { ...worst, profit: r2(worst.profit) } : null,
    moneyWinrate: staked > 0 ? Math.round((wonStake / staked) * 100) : null,
    // many tips won, the money lost: one or a few big stakes took it
    warn: winrate != null && winrate >= 55 && total < 0,
  };
}
