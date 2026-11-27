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
