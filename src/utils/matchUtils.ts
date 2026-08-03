/** Shared match utilities — used by both warmup (index.ts) and runtime (cs2Matches.ts). */

interface MatchTeamNames {
  date: string;
  nameTeam1: string;
  nameTeam2: string;
}

/**
 * Normalize a team name for fuzzy matching: lowercase, strip suffixes like
 * "esports"/"gaming", remove non-alphanumeric chars.
 * "UNiTY esports" and "UNiTY" both → "unity"
 */
export function normalizeTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(esports|gaming|team|academy|acad)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Check if two matches are likely the same: same date + fuzzy team name match.
 * Handles swapped teams (home/away order doesn't matter).
 */
export function isSameMatch(a: MatchTeamNames, b: MatchTeamNames): boolean {
  if (a.date !== b.date) return false;
  const a1 = normalizeTeam(a.nameTeam1);
  const a2 = normalizeTeam(a.nameTeam2);
  const b1 = normalizeTeam(b.nameTeam1);
  const b2 = normalizeTeam(b.nameTeam2);
  return (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1);
}
