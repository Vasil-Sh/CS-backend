/**
 * Score validation — prevents impossible values from polluting the cache.
 */

/**
 * Validate a pair of match scores. Returns null if valid, or an error string.
 */
export function validateScores(
  score1: number | null | undefined,
  score2: number | null | undefined,
  matchType: string,
): string | null {
  if (score1 == null || score2 == null) return null; // null = no data yet, fine

  // Negative scores are impossible
  if (score1 < 0 || score2 < 0) {
    return `Negative scores (${score1}-${score2}) — rejecting`;
  }

  // If any score > 5, these are per-map round scores — fine (they'll be fixed later)
  if (score1 > 5 || score2 > 5) return null;

  // Series scores — validate against format maximum
  const isBo5 = /bo5/i.test(matchType);
  const isBo3 = /bo3/i.test(matchType);
  const isBo1 = /bo1/i.test(matchType);
  const isBo2 = /bo2/i.test(matchType);

  const maxScore = isBo5 ? 3 : isBo3 ? 2 : isBo2 ? 2 : isBo1 ? 1 : 5;

  if (score1 > maxScore) {
    return `score1=${score1} exceeds format maximum ${maxScore} (${matchType}) — rejecting`;
  }
  if (score2 > maxScore) {
    return `score2=${score2} exceeds format maximum ${maxScore} (${matchType}) — rejecting`;
  }

  // Both teams can't have maximum score simultaneously (e.g., 2-2 in BO3)
  if (score1 === maxScore && score2 === maxScore && !isBo2) {
    return `Impossible result ${score1}-${score2} in ${matchType} — rejecting`;
  }

  return null;
}

/**
 * Returns true if a finished match's score looks suspicious and should be backfilled
 * from the detail page. This catches matches where the listing page shows only
 * map 1 scores (e.g. 1-0 in BO3) instead of the full series score.
 */
export function needsScoreBackfill(
  score1: number | null | undefined,
  score2: number | null | undefined,
  matchType: string,
): boolean {
  if (score1 == null || score2 == null) return true; // null — always backfill
  if (score1 < 0 || score2 < 0) return true; // invalid — backfill

  const isBo3Plus = /bo[3-9]/i.test(matchType);
  if (!isBo3Plus) return false; // BO1/BO2 — single-game scores are fine

  const maxScore = Math.max(score1, score2);
  // In BO3+, max score < 2 means only 1 map played → suspicious
  if (maxScore < 2) return true;

  // If both scores are per-map round scores (>5), also suspicious
  if (score1 > 5 || score2 > 5) return true;

  return false;
}
