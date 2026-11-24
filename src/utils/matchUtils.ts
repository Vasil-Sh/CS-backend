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

/** Feed match fields the duplicate merge reads and fills. */
interface FeedMatch {
  id: string;
  startDate?: string;
  nameTeam1: string;
  nameTeam2: string;
  fromPage?: boolean;
  [key: string]: any;
}

const sourceRank = (m: FeedMatch): number => {
  const id = String(m.id);
  if (id.startsWith('lp-')) return m.fromPage ? 1 : 0;
  if (id.startsWith('ps-')) return 2;
  if (id.startsWith('ct-')) return 3;
  if (id.startsWith('op-')) return 4;
  return -1; // manual and others: never merged away
};
const key = (v: string) => (isTbd(v) ? '' : normalizeTeam(String(v || '').replace(/\b(e-?sports?|club|clan)\b/gi, ' ')));
const PAIRED = [['coeff1', 'coeff2'], ['openCoeff1', 'openCoeff2'], ['closeCoeff1', 'closeCoeff2'], ['bestCoeff1', 'bestCoeff2'], ['bestBook1', 'bestBook2'], ['score1', 'score2'], ['logoTeam1', 'logoTeam2'], ['positionTeam1', 'positionTeam2'], ['pred1', 'pred2']] as const;
const SINGLE = ['oddsFixtureId', 'tournament', 'stage', 'tier', 'tournamentLogo', 'tournamentPage', 'matchPage', 'maps', 'performer'] as const;

/**
 * The same match from two sources (or two Liquipedia pages) under different names — «PVISION» / «PARIVISION»:
 * a team cannot play two matches at once, so one shared team within 20 min means the same match
 * (both teams within 6 h too). The better source stays (Liquipedia ticker → tournament page → PandaScore → Cito → OddsPapi)
 * and takes what only the other copy had — odds above all. Manual matches are never touched.
 */
export function mergeSameTimeDuplicates<T extends FeedMatch>(list: T[]): T[] {
  const feed = list.filter((m) => sourceRank(m) >= 0 && m.startDate && !isNaN(Date.parse(m.startDate)));
  if (feed.length < 2) return list;
  const drop = new Set<T>();
  const sorted = [...feed].sort((a, z) => Date.parse(a.startDate!) - Date.parse(z.startDate!));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (drop.has(a)) continue;
    const ta = Date.parse(a.startDate!), a1 = key(a.nameTeam1), a2 = key(a.nameTeam2);
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const dt = Date.parse(b.startDate!) - ta;
      if (dt > 6 * 3_600_000) break;
      if (drop.has(b) || a.id === b.id) continue;
      const b1 = key(b.nameTeam1), b2 = key(b.nameTeam2);
      const both = !!(a1 && a2) && ((a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1));
      const one = dt <= 20 * 60_000 && !!(a1 && a2 && b1 && b2) && (a1 === b1 || a2 === b2 || a1 === b2 || a2 === b1);
      if (!both && !one) continue;
      const [keep, lose] = sourceRank(b) < sourceRank(a) ? [b, a] : [a, b];
      const swapped = key(keep.nameTeam1) === key(lose.nameTeam2) || key(keep.nameTeam2) === key(lose.nameTeam1);
      const k = keep as any, l = lose as any;
      for (const [x, y] of PAIRED) {
        if (x === 'score1' && k.status !== l.status) continue; // a score only from a copy in the same state («finished» is never guessed)
        if (k[x] == null && l[swapped ? y : x] != null) k[x] = l[swapped ? y : x];
        if (k[y] == null && l[swapped ? x : y] != null) k[y] = l[swapped ? x : y];
      }
      for (const f of SINGLE) if ((k[f] == null || k[f] === '') && l[f] != null && l[f] !== '') k[f] = l[f];
      drop.add(lose);
      if (lose === a) break;
    }
  }
  return drop.size ? list.filter((m) => !drop.has(m)) : list;
}

/** An opponent not decided yet: «TBD», «TBA», the page's «TBDTBDTBD» (full, short and icon name run together), empty. */
export function isTbd(name: string | null | undefined): boolean {
  const v = String(name || '').replace(/\s+/g, '').toLowerCase();
  return !v || /^(tbd|tba)+$/.test(v) || v === 'tobedetermined' || v === 'tobeannounced';
}
