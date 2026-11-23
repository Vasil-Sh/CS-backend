/**
 * CS2 Matches API — uses createMatchesRouter factory (cache, SWR, rate limit, logo proxy).
 * Data: Liquipedia + OddsPapi (matchFeed) plus the admin's placeholder matches.
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchCs2Matches } from '../services/matchFeed';
import type { TipsGgMatch } from '../services/matchTypes';
import { cs2LiveScoresStore } from '../services/liveScoresStore';
import { isSameMatch } from '../utils/matchUtils.js';
import { join } from 'node:path';
import { getCustomMatches } from '../services/customMatchesService';

const CACHE_DIR = join(process.cwd(), '.cache');

async function fetchCs2MatchesAll(): Promise<TipsGgMatch[]> {
  const all = await fetchCs2Matches();
  // ── Merge custom/placeholder matches (skip one the feed already has: same teams + date) ──
  for (const cm of getCustomMatches()) if (!all.some((m) => m.date === cm.date && isSameMatch(m, cm))) all.push(cm);
  return all;
}

const router = createMatchesRouter({
  game: 'cs2',
  fetchFn: fetchCs2MatchesAll,
  liveScoresStore: cs2LiveScoresStore,
  cacheFile: join(CACHE_DIR, 'cs2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_cs2_matches',
});

export default router;
