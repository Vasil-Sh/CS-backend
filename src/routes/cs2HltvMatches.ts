/**
 * HLTV CS2 Matches API — uses createMatchesRouter factory + extra endpoints.
 *
 * Source priority:
 *   1. api.cstest.pp.ua (deployed SC/HLTV parser, fast HTTP, 50+ matches)
 *   2. tips.gg /v1/cs2-matches (Puppeteer-based, our own, fallback)
 *
 * Extra endpoints:
 *   GET /ranking — HLTV world ranking (top 30)
 *   GET /maps/:teamId/:teamName — team map statistics
 *   GET /game/{matchUrl}/details — full game details (per-map scores, coefficients)
 */
import { Hono } from 'hono';
import { createMatchesRouter } from '../services/createMatchesRouter';
import { fetchCstestMatches } from '../services/hltv/cstestClient';
import { fetchCs2Matches, type TipsGgMatch, getBrowser } from '../services/tipsggScraper';
import {
  fetchHltvRanking,
  fetchHltvTeamMaps,
  fetchHltvGameDetails,
  fetchMatchScore,
  setBrowserFactory,
} from '../services/hltv/hltvScraper';
import { cs2LiveScoresStore } from '../services/liveScoresStore';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { HltvRankedTeam } from '../services/hltv/hltvTypes';

// Wire shared Puppeteer browser
setBrowserFactory(getBrowser);

function ddmmyyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

const CACHE_DIR = join(process.cwd(), '.cache');
const RANKING_CACHE_FILE = join(CACHE_DIR, 'hltv_ranking.json');
const RANKING_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Fetch: primary = cstest.pp.ua, fallback = tips.gg.
// Enriches finished matches with missing scores via Puppeteer (HLTV detail pages).
async function fetchFn(): Promise<TipsGgMatch[]> {
  try {
    const primary = await fetchCstestMatches();
    if (primary.length <= 10) {
      console.warn('[cs2-hltv] cstest.pp.ua returned only', primary.length, '— trying fallback');
      return fetchCs2Matches();
    }

    // ── Score enrichment: cstest doesn't visit match pages — fill in missing scores ──
    const needsScores = primary.filter(
      m => m.status === 'finished' && (m.score1 == null || m.score2 == null),
    );
    if (needsScores.length > 0) {
      const startTime = Date.now();
      const CONCURRENCY = 4;
      let enriched = 0;

      for (let i = 0; i < needsScores.length; i += CONCURRENCY) {
        const batch = needsScores.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (m) => {
            const score = await fetchMatchScore(m.link);
            return { id: m.id, score };
          }),
        );

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value.score) continue;
          const { id, score } = r.value;
          const match = primary.find(x => x.id === id);
          if (match) {
            match.score1 = score.score1;
            match.score2 = score.score2;
            match.type = score.type.toUpperCase();
            enriched++;
          }
        }

        if (i + CONCURRENCY < needsScores.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      console.log(
        `[cs2-hltv] Score enrichment: ${enriched}/${needsScores.length} ` +
        `(${Date.now() - startTime}ms)`,
      );
    }

    return primary;
  } catch (e) {
    console.warn('[cs2-hltv] cstest.pp.ua failed:', (e as Error).message, '— trying fallback');
  }

  // Fallback: our tips.gg scraper
  return fetchCs2Matches();
}

const matchesRouter = createMatchesRouter({
  game: 'cs2',
  fetchFn,
  liveScoresStore: cs2LiveScoresStore,
  cacheFile: join(CACHE_DIR, 'cs2_hltv_matches.json'),
  circuitBreakerName: 'hltv_scraper',
  healthUrl: `https://www.hltv.org/matches`,
});

// ── Extra routes (ranking, maps, game details) ──

const router = new Hono();

// Mount the matches router (/, /live-scores, /logo/*, /health)
router.route('/', matchesRouter);

// ── GET /ranking — HLTV world ranking (cached 6h) ──
router.get('/ranking', async (c) => {
  // Serve from cache if fresh
  try {
    if (existsSync(RANKING_CACHE_FILE)) {
      const raw = readFileSync(RANKING_CACHE_FILE, 'utf-8');
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < RANKING_CACHE_TTL) {
        return c.json(data);
      }
    }
  } catch { /* fetch fresh */ }

  try {
    const teams = await fetchHltvRanking();
    if (teams.length > 0) {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(RANKING_CACHE_FILE, JSON.stringify({ data: teams, ts: Date.now() }));
    }
    return c.json(teams);
  } catch (err) {
    // Serve stale cache on error
    try {
      if (existsSync(RANKING_CACHE_FILE)) {
        const { data } = JSON.parse(readFileSync(RANKING_CACHE_FILE, 'utf-8'));
        return c.json(data);
      }
    } catch { /* empty */ }
    throw err;
  }
});

// ── GET /maps/:teamId/:teamName — team map stats ──
router.get('/maps/:teamId/:teamName', async (c) => {
  const teamId = parseInt(c.req.param('teamId'), 10);
  const teamName = c.req.param('teamName');

  if (isNaN(teamId) || !teamName) {
    return c.json({ error: 'Missing teamId or teamName' }, 400);
  }

  try {
    const maps = await fetchHltvTeamMaps(teamId, teamName);
    return c.json(maps);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: 'Failed to fetch team maps', detail: message }, 502);
  }
});

// ── GET /game/*/details — full match details ──
router.get('/game/*/details', async (c) => {
  // Extract match URL from wildcard: /game/hltv.org/matches/123/team1-vs-team2/details
  // → reconstruct full URL
  const wildcard = c.req.param('*') || '';
  const matchPath = wildcard.replace(/\/details$/, '');
  const matchUrl = matchPath.startsWith('http') ? matchPath : `https://www.hltv.org/${matchPath}`;

  try {
    const details = await fetchHltvGameDetails(matchUrl);
    if (!details) {
      return c.json({ error: 'Failed to parse match details' }, 502);
    }
    return c.json(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: 'Failed to fetch match details', detail: message }, 502);
  }
});

export default router;
