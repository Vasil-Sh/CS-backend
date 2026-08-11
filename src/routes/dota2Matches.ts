/**
 * Dota 2 Matches API — uses createMatchesRouter factory.
 * All logic (cache, SWR, rate limit, logo proxy) is in createMatchesRouter.
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchDota2Matches } from '../services/tipsggScraper';
import { liveScoresStore } from '../services/liveScoresStore';
import { join } from 'node:path';

function ddmmyyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

const CACHE_DIR = join(process.cwd(), '.cache');

export default createMatchesRouter({
  game: 'dota2',
  fetchFn: fetchDota2Matches,
  liveScoresStore,
  cacheFile: join(CACHE_DIR, 'dota2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_dota2_matches',
  healthUrl: `https://tips.gg/dota2/matches/${ddmmyyyy()}/`,
});
