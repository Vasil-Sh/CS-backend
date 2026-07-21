/**
 * CS2 Matches API — uses createMatchesRouter factory.
 * All logic (cache, SWR, rate limit, logo proxy) is in createMatchesRouter.
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchCs2Matches } from '../services/tipsggScraper';
import { cs2LiveScoresStore } from '../services/liveScoresStore';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache');

export default createMatchesRouter({
  game: 'cs2',
  fetchFn: fetchCs2Matches,
  liveScoresStore: cs2LiveScoresStore,
  cacheFile: join(CACHE_DIR, 'cs2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_cs2_matches',
});
