/**
 * Dota 2 Matches API — uses createMatchesRouter factory.
 * All logic (cache, SWR, rate limit, logo proxy) is in createMatchesRouter.
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchDota2Matches } from '../services/tipsggScraper';
import { fetchDota2FromOpenDota } from '../services/opendotaClient';
import type { TipsGgMatch } from '../services/tipsggScraper';
import { liveScoresStore } from '../services/liveScoresStore';
import { join } from 'node:path';

/**
 * Composite fetcher: tries tips.gg first (with 15s timeout), falls back to OpenDota.
 * OpenDota is fast (< 5s) and not behind Cloudflare — reliable when tips.gg is blocked.
 * Used by SWR refresh — ensures data even when tips.gg is Cloudflare-blocked.
 */
async function fetchDota2Composite(): Promise<TipsGgMatch[]> {
  try {
    const tipsgg = await Promise.race([
      fetchDota2Matches(),
      new Promise<TipsGgMatch[]>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 15_000),
      ),
    ]);
    if (tipsgg.length > 0) return tipsgg;
    console.warn('[dota2Matches] tips.gg returned 0 matches — falling back to OpenDota');
  } catch (e) {
    console.warn('[dota2Matches] tips.gg fetch failed:', (e as Error).message, '— falling back to OpenDota');
  }
  return fetchDota2FromOpenDota();
}

function ddmmyyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

const CACHE_DIR = join(process.cwd(), '.cache');

export default createMatchesRouter({
  game: 'dota2',
  fetchFn: fetchDota2Composite,
  liveScoresStore,
  cacheFile: join(CACHE_DIR, 'dota2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_dota2_matches',
  healthUrl: `https://tips.gg/dota2/matches/${ddmmyyyy()}/`,
});
