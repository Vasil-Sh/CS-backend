/**
 * CS2 Matches API — uses createMatchesRouter factory.
 * All logic (cache, SWR, rate limit, logo proxy) is in createMatchesRouter.
 *
 * Data sources (tried in order):
 *   1. api.cstest.pp.ua (deployed HLTV parser, fastest — HTTP JSON, 1-2s)
 *   2. tips.gg (fallback — Puppeteer scraper, 30-80s)
 */
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchCs2Matches, type TipsGgMatch } from '../services/tipsggScraper';
import { cstestLiveScoresStore } from '../services/hltv/cstestClient';
import { fetchCstestMatches } from '../services/hltv/cstestClient';
import { join } from 'node:path';

function ddmmyyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

const CACHE_DIR = join(process.cwd(), '.cache');

/**
 * Composite CS2 fetch: try cstest (fast HLTV API) first, fallback to tips.gg.
 */
async function fetchCs2MatchesAll(): Promise<TipsGgMatch[]> {
  try {
    const cstest = await fetchCstestMatches();
    if (cstest.length > 0) return cstest;
    console.warn('[cs2Matches] cstest returned 0 matches — falling back to tips.gg');
  } catch (err) {
    console.warn('[cs2Matches] cstest failed:', (err as Error).message, '— falling back to tips.gg');
  }
  return fetchCs2Matches();
}

const router = createMatchesRouter({
  game: 'cs2',
  fetchFn: fetchCs2MatchesAll,
  liveScoresStore: cstestLiveScoresStore,
  cacheFile: join(CACHE_DIR, 'cs2_matches.json'),
  circuitBreakerName: 'tipsgg_fetch_cs2_matches',
  healthUrl: `https://tips.gg/csgo/matches/${ddmmyyyy()}/`,
});

// ── GET /live-scores/metrics — parser health & latency ──
router.get('/live-scores/metrics', (c) => {
  return c.json({
    ...cstestLiveScoresStore.getMetrics(),
    storeAge: Date.now() - (cstestLiveScoresStore.getResponse().lastUpdate || 0),
    liveCount: cstestLiveScoresStore.getLiveCount(),
  });
});

export default router;
