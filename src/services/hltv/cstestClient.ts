/**
 * cstest.pp.ua HTTP Client — fetches HLTV CS2 matches from deployed SC API.
 *
 * api.cstest.pp.ua is the production deployment of petrynyak/SC.
 * Returns 50+ matches with scores, logos, and isLive flag.
 *
 * This is the PRIMARY data source (fast HTTP, no Puppeteer).
 * Our internal hltvScraper.ts + tips.gg serve as fallbacks.
 */

import type { TipsGgMatch } from '../tipsggScraper';

const CSTEST_BASE = 'https://api.cstest.pp.ua';

interface CstestGame {
  id: number;
  date: string;
  link: string;
  type: string;
  score1: number;
  score2: number;
  stars: number;
  nameTeam1: string;
  nameTeam2: string;
  lastChangeDateTeam1: string | null;
  lastChangeDateTeam2: string | null;
  positionTeam1: number | null;
  positionTeam2: number | null;
  logoTeam1: string | null;
  logoTeam2: string | null;
  predictionPercentTeam1: number | null;
  predictionPercentTeam2: number | null;
  bettingCoefficientTeam1: number | null;
  bettingCoefficientTeam2: number | null;
  isLive: boolean;
}

/**
 * Convert cstest.pp.ua Game to TipsGgMatch (unified format).
 */
function cstestToTipsGgMatch(g: CstestGame): TipsGgMatch {
  const scores = g.isLive || (g.score1 > 0 || g.score2 > 0);
  const finished = !g.isLive && scores;
  const status: 'upcoming' | 'live' | 'finished' = finished
    ? 'finished'
    : g.isLive
      ? 'live'
      : 'upcoming';

  return {
    id: String(g.id),
    date: g.date.split('T')[0],
    link: g.link.startsWith('http') ? g.link : `https://www.hltv.org${g.link}`,
    type: g.type.toUpperCase(),
    score1: g.score1 || null,
    score2: g.score2 || null,
    nameTeam1: g.nameTeam1,
    nameTeam2: g.nameTeam2,
    logoTeam1: g.logoTeam1,
    logoTeam2: g.logoTeam2,
    tournament: '',
    stage: '',
    status,
    tipsCount: 0,
    performer: null,
    startDate: g.date,
    pred1: g.predictionPercentTeam1 ?? 50,
    pred2: g.predictionPercentTeam2 ?? 50,
    coeff1: g.bettingCoefficientTeam1 ?? null,
    coeff2: g.bettingCoefficientTeam2 ?? null,
  };
}

/**
 * Fetch CS2 matches from api.cstest.pp.ua (deployed SC/HLTV parser).
 * Returns unified TipsGgMatch format for compatibility with createMatchesRouter.
 */
export async function fetchCstestMatches(): Promise<TipsGgMatch[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${CSTEST_BASE}/api/Game/TodaysAndUpcoming`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`cstest.pp.ua returned ${response.status}`);
    }

    const raw = (await response.json()) as CstestGame[];
    if (!Array.isArray(raw)) {
      console.warn('[cstest] Expected array, got', typeof raw);
      return [];
    }

    const matches = raw.map(cstestToTipsGgMatch);
    const liveCount = matches.filter(m => m.status === 'live').length;
    const finishedCount = matches.filter(m => m.status === 'finished').length;

    console.log(
      `[cstest] Fetched ${matches.length} matches ` +
      `(${liveCount} live, ${finishedCount} finished)`,
    );

    return matches;
  } finally {
    clearTimeout(timeout);
  }
}
