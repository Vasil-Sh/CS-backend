/**
 * Dota 2 Matches API — uses createMatchesRouter factory.
 * All logic (cache, SWR, rate limit, logo proxy) is in createMatchesRouter.
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchDota2Matches } from '../services/matchFeed';
import { liveScoresStore } from '../services/liveScoresStore';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache');

export default createMatchesRouter({
  game: 'dota2',
  fetchFn: fetchDota2Matches,
  liveScoresStore,
  cacheFile: join(CACHE_DIR, 'dota2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_dota2_matches',
});
