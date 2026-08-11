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
import { normalizeTeam, isSameMatch } from '../utils/matchUtils.js';
import { join } from 'node:path';
import {
  getCustomMatches,
  saveCustomMatches,
  clearCustomMatches,
  parseMatchText,
} from '../services/customMatchesService';

function ddmmyyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

const CACHE_DIR = join(process.cwd(), '.cache');

/**
 * Composite CS2 fetch: merge cstest (HLTV) + tips.gg for max coverage.
 * Slug-based dedup + fuzzy dedup by date/team names (handles Liquid vs Team Liquid).
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

  // Build dedup: cstest first (better logo/score data), tips.gg enriches
  const merged = new Map<string, TipsGgMatch>();
  for (const m of cstest) merged.set(m.id, m);

  let fuzzyDeduped = 0;
  let enriched = 0;

  for (const tm of tipsgg) {
    // Try exact slug match first
    const existing = merged.get(tm.id);
    if (existing) {
      if (!existing.tournament && tm.tournament) { existing.tournament = tm.tournament; enriched++; }
      if (!existing.stage && tm.stage) existing.stage = tm.stage;
      if (existing.coeff1 == null && tm.coeff1 != null) existing.coeff1 = tm.coeff1;
      if (existing.coeff2 == null && tm.coeff2 != null) existing.coeff2 = tm.coeff2;
      if (existing.tipsCount === 0 && tm.tipsCount > 0) existing.tipsCount = tm.tipsCount;
      continue;
    }

    // Fuzzy dedup: same date + normalized team names → same match, different slug
    const fuzzyDupe = [...merged.values()].find((m) => isSameMatch(m, tm));
    if (fuzzyDupe) {
      if (!fuzzyDupe.tournament && tm.tournament) { fuzzyDupe.tournament = tm.tournament; enriched++; }
      if (!fuzzyDupe.stage && tm.stage) fuzzyDupe.stage = tm.stage;
      if (fuzzyDupe.coeff1 == null && tm.coeff1 != null) fuzzyDupe.coeff1 = tm.coeff1;
      if (fuzzyDupe.coeff2 == null && tm.coeff2 != null) fuzzyDupe.coeff2 = tm.coeff2;
      if (fuzzyDupe.tipsCount === 0 && tm.tipsCount > 0) fuzzyDupe.tipsCount = tm.tipsCount;
      fuzzyDeduped++;
      continue;
    }

    merged.set(tm.id, tm);
  }

  const all = [...merged.values()];

  // ── Merge custom/placeholder matches ──
  const customMatches = getCustomMatches();
  if (customMatches.length > 0) {
    for (const cm of customMatches) {
      // Dedup: check if a "real" match with same teams+date already exists
      const alreadyExists = all.some(
        (m) => m.date === cm.date && isSameMatch(m, cm),
      );
      if (!alreadyExists) {
        all.push(cm);
      }
    }
    console.log(`[cs2Matches] Custom matches: ${customMatches.length} (after dedup in ${all.length} total)`);
  }

  const parts = [`cstest: ${cstest.length}`, `tips.gg: ${tipsgg.length}`];
  if (enriched > 0) parts.push(`enriched: ${enriched}`);
  if (fuzzyDeduped > 0) parts.push(`fuzzyDeduped: ${fuzzyDeduped}`);
  console.log(`[cs2Matches] Merged: ${all.length} total (${parts.join(', ')})`);

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
