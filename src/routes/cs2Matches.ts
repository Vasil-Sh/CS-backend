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
 * Composite CS2 fetch: merge cstest (HLTV) + tips.gg for max coverage.
 * cstest = 50+ HLTV matches (fast, 1-2s)
 * tips.gg = 30+ CS2 matches (slow, 30-80s, Puppeteer)
 *
 * Merged → dedup by slug → serve all.
 * tips.gg enriches with tournament names & coefficients that HLTV lacks.
 */
async function fetchCs2MatchesAll(): Promise<TipsGgMatch[]> {
  const results = await Promise.allSettled([
    fetchCstestMatches(),
    fetchCs2Matches(),
  ]);

  const cstest = results[0].status === 'fulfilled' ? results[0].value : [];
  const tipsgg = results[1].status === 'fulfilled' ? results[1].value : [];

  if (cstest.length === 0 && tipsgg.length === 0) {
    throw new Error('Both CS2 data sources returned 0 matches');
  }

  // Build dedup map: cstest first (better logo/score data), tips.gg enriches
  const merged = new Map<string, TipsGgMatch>();
  for (const m of cstest) merged.set(m.id, m);

  // Overlay tips.gg matches — enrich tournament/stage/coefficients from tips.gg
  for (const tm of tipsgg) {
    const existing = merged.get(tm.id);
    if (existing) {
      // Enrich with tips.gg data where cstest lacks it
      if (!existing.tournament && tm.tournament) existing.tournament = tm.tournament;
      if (!existing.stage && tm.stage) existing.stage = tm.stage;
      if (existing.coeff1 == null && tm.coeff1 != null) existing.coeff1 = tm.coeff1;
      if (existing.coeff2 == null && tm.coeff2 != null) existing.coeff2 = tm.coeff2;
      if (existing.tipsCount === 0 && tm.tipsCount > 0) existing.tipsCount = tm.tipsCount;
    } else {
      merged.set(tm.id, tm);
    }
  }

  const all = [...merged.values()];
  console.log(
    `[cs2Matches] Merged: ${all.length} total ` +
    `(cstest: ${cstest.length}, tips.gg: ${tipsgg.length}, ` +
    `enriched: ${all.length - cstest.length} from tips.gg only)`,
  );

  return all;
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
