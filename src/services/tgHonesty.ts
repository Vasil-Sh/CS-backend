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
