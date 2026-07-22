/**
 * Tips.GG Match Scraper (Dota 2 & CS2)
 *
 * Fetches tips.gg match listing pages, extracts JSON-LD
 * structured data and score info, returns typed match objects.
 *
 * Works without login — tips.gg serves public data in <script type="application/ld+json">.
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import { getCachedCoefficients, setCachedCoefficients } from './coefficientsCache';
import { isOpen, recordSuccess, recordFailure } from './circuitBreaker';

const TIPSGG_BASE = 'https://tips.gg';

export interface TipsGgMatch {
  id: string;
  date: string;
  link: string;
  type: string; // e.g. "BO2"
  score1: number | null;
  score2: number | null;
  nameTeam1: string;
  nameTeam2: string;
  logoTeam1: string | null;
  logoTeam2: string | null;
  tournament: string;
  tournamentLogo: string | null; // tips.gg tournament logo from organizer URL
  stage: string;
  status: 'upcoming' | 'live' | 'finished';
  tipsCount: number;
  performer: string | null; // predicted winner
  startDate: string; // ISO 8601
  pred1: number; // tipster prediction % (0-100)
  pred2: number;
  coeff1: number | null; // real bookmaker coefficient from predictions page
  coeff2: number | null;
}

interface JsonLdSportsEvent {
  '@type': 'SportsEvent';
  name: string;
  description: string;
  startDate: string;
  endDate?: string;
  url: string;
  sport: string;
  eventStatus: string;
  competitor: Array<{
    '@type': 'SportsTeam';
    name: string;
    url: string;
    logo: string;
  }>;
  performer?: {
    '@type': 'SportsTeam';
    name: string;
  };
  organizer?: {
    '@type': 'SportsOrganization';
    name: string;
    url?: string;
  };
}

function parseIsoDate(dateStr: string): string {
  try {
    // "2026-07-10T12:04:58+0300" → "2026-07-10"
    return dateStr.split('T')[0];
  } catch {
    return '';
  }
}

function parseMatchType(desc: string): string {
  const m = desc.match(/BO(\d+)/i);
  return m ? `BO${m[1]}` : 'BO3';
}

function parseStage(desc: string): string {
  // "BO2 Match. Group A. France. Dota 2 Premier."
  // Also handles: "BO3 Match. Quarterfinal. Dota 2." etc.
  const parts = desc.split('.').map(s => s.trim());
  const stagePart = parts.find(p =>
    /group|playoff|final|stage|quarter|semi|grand|lower.?bracket|upper.?bracket|decider|tiebreaker/i.test(p)
  );
  return stagePart || '';
}

function parseEventStatus(statusUrl: string, startDate?: string): 'upcoming' | 'live' | 'finished' {
  if (statusUrl.includes('EventCancelled')) return 'upcoming';
  if (statusUrl.includes('EventPostponed')) return 'upcoming';
  if (statusUrl.includes('EventScheduled')) return 'upcoming';
  if (statusUrl.includes('EventRescheduled')) return 'upcoming';

  // Date-based fallback: only determine upcoming vs live.
  // Finished status must come from scores (BO3=2 wins, BO5=3 wins).
  // The 2h+ heuristic was incorrectly marking matches as finished
  // when they might still be in-progress (e.g. BO3 0:1 after 2h).
  if (startDate) {
    try {
      const start = new Date(startDate).getTime();
      const now = Date.now();
      // Match started but not yet 4h → live
      // (4h covers Dota2 BO5 longest case; BO3 typically 2-3h)
      if (start < now) return 'live';
    } catch { /* ignore */ }
  }

  return 'upcoming';
}

/**
 * Normalize match URL from JSON-LD to absolute form for HTML search.
 * JSON-LD has relative paths like "/matches/dota2/..."
 * HTML has absolute paths like "https://tips.gg/matches/dota2/..."
 */
function normalizeMatchUrl(url: string): string {
  if (url.startsWith('http')) return url;
  return `${TIPSGG_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Extract scores and status from the HTML near each match.
 * Uses Cheerio to parse the DOM — robust against HTML layout changes.
 * Selectors based on tips.gg real DOM (verified 2026-07-20):
 *   Container: div.element.match (with status class: finished/live/upcoming)
 *   Match URL: a.match-link[href]
 *   Scores: div.scores > span.score (text content = score value)
 */
function extractScoresFromHtml(
  html: string,
  rawMatchUrl: string,
): { score1: number | null; score2: number | null; status: 'upcoming' | 'live' | 'finished' } {
  const slug = slugFromUrl(rawMatchUrl);
  if (!slug) return { score1: null, score2: null, status: 'upcoming' };

  const $ = cheerio.load(html);

  // Find the match container with the matching slug in its href
  const $match = $(`.element.match:has(a.match-link[href*="${slug}"])`).first();
  if ($match.length === 0) {
    return { score1: null, score2: null, status: 'upcoming' };
  }

  // Extract status from CSS classes on the container
  let status: 'upcoming' | 'live' | 'finished' = 'upcoming';
  if ($match.hasClass('finished')) status = 'finished';
  else if ($match.hasClass('live')) status = 'live';

  // Extract scores from .scores .score spans
  const scores: number[] = [];
  $match.find('.scores .score').each((_, el) => {
    const val = parseInt($(el).text().trim(), 10);
    if (!isNaN(val)) scores.push(val);
  });

  // team1 = even indices, team2 = odd indices (map-level cumulative)
  let score1 = 0, score2 = 0;
  for (let i = 0; i < scores.length; i++) {
    if (i % 2 === 0) score1 += scores[i];
    else score2 += scores[i];
  }

  // Score-based status inference: if tips.gg shows score elements but hasn't
  // updated the CSS class yet (lag between match start and DOM update),
  // infer status from scores. parseMatchesFromHtml will apply format-specific
  // finished detection (BO3=2, BO5=3, etc.)
  if (scores.length >= 1) {
    const allZero = score1 === 0 && score2 === 0;
    return {
      score1,
      score2,
      status: status !== 'upcoming' ? status
        : allZero ? 'upcoming'  // 0-0 with score elements → hasn't started yet
        : 'live',               // non-zero scores → live (finished decided upstream)
    };
  }

  return { score1: null, score2: null, status };
}

/**
 * Extract tips count from HTML near the match URL.
 */
function extractTipsCount(html: string, rawMatchUrl: string): number {
  const absoluteUrl = normalizeMatchUrl(rawMatchUrl);
  const hrefMarker = `href="${absoluteUrl}"`;
  const urlIndex = html.indexOf(hrefMarker);
  if (urlIndex === -1) return 0;

  const chunk = html.substring(Math.max(0, urlIndex - 500), urlIndex + 500);
  const tipsMatch = chunk.match(/(\d+)\s+tips?/i);
  return tipsMatch ? parseInt(tipsMatch[1]) : 0;
}

/**
 * Parse match listing HTML into TipsGgMatch array.
 */
async function parseMatchesFromHtml(html: string, game: 'dota2' | 'cs2' = 'dota2'): Promise<TipsGgMatch[]> {
  const logoMap = buildLogoMap(html, game);
  const jsonLdMatches = extractJsonLd(html, game);
  const matches: TipsGgMatch[] = [];

  for (const ld of jsonLdMatches) {
    try {
      const competitor1 = ld.competitor?.[0];
      const competitor2 = ld.competitor?.[1];
      if (!competitor1 || !competitor2) continue;

      const description = ld.description || '';
      const dateKey = parseIsoDate(ld.startDate);

      const { score1, score2, status: htmlStatus } = extractScoresFromHtml(html, ld.url);
      // Trust HTML status detection — time-based fallback is unreliable (delays, finished matches)
      let status: 'upcoming' | 'live' | 'finished' = htmlStatus !== 'upcoming' ? htmlStatus : parseEventStatus(ld.eventStatus, ld.startDate);

      // Score-based override: if match format is decided by map count, force finished
      const matchType = parseMatchType(description);
      const s1 = score1 ?? 0, s2 = score2 ?? 0;
      const winnerScore = Math.max(s1, s2);
      const isScoreDecided =
        (matchType === 'BO3' && winnerScore >= 2) ||
        (matchType === 'BO5' && winnerScore >= 3) ||
        (matchType === 'BO2' && (s1 + s2) >= 2 && winnerScore >= 2) ||
        (matchType === 'BO1' && (s1 + s2) >= 1 && Math.abs(s1 - s2) >= 1);
      const hasScores = (s1 + s2) > 0;

      if (isScoreDecided) {
        status = 'finished';
      }

      // Date-based safety override: if HTML says "live" but match started >2.5h ago, it's probably finished.
      // BUT: only if scores confirm it (score decided) OR there are no scores (stale HTML).
      // If scores show an undecided match (e.g. BO3 1:1), keep "live" regardless of time.
      if (status === 'live') {
        try {
          const start = new Date(ld.startDate).getTime();
          if (Date.now() - start > 2.5 * 60 * 60 * 1000 && (!hasScores || isScoreDecided)) {
            status = 'finished';
          }
        } catch { /* ignore */ }
      }
      const tipsCount = extractTipsCount(html, ld.url);
      const logo1 = getTeamLogo(competitor1.name, competitor1.url, logoMap);
      const logo2 = getTeamLogo(competitor2.name, competitor2.url, logoMap);

      const pred1 = ld.performer?.name === competitor1.name ? 55
        : ld.performer?.name === competitor2.name ? 45
        : 50;

      // Tournament logo: extract slug from organizer URL
      // e.g. https://tips.gg/tournament/dota2-european-pro-league-masters-i/
      //   → https://files.tips.gg/static/image/tournaments/dota2-european-pro-league-masters-i.png
      let tournamentLogo: string | null = null;
      const organizerUrl = ld.organizer?.url || '';
      if (organizerUrl) {
        const parts = organizerUrl.replace(/\/$/, '').split('/');
        const slug = parts[parts.length - 1];
        if (slug && slug !== 'tournament') {
          tournamentLogo = `https://files.tips.gg/static/image/tournaments/${slug}.png`;
        }
      }

      matches.push({
        id: slugFromUrl(ld.url),
        date: dateKey,
        link: ld.url,
        type: parseMatchType(description),
        score1,
        score2,
        nameTeam1: competitor1.name,
        nameTeam2: competitor2.name,
        logoTeam1: logo1,
        logoTeam2: logo2,
        tournament: ld.organizer?.name || '',
        tournamentLogo,
        stage: parseStage(description),
        status: status !== 'upcoming' ? status : parseEventStatus(ld.eventStatus, ld.startDate),
        tipsCount,
        performer: ld.performer?.name || null,
        startDate: ld.startDate,
        pred1,
        pred2: 100 - pred1,
        coeff1: null,
        coeff2: null,
      });
    } catch (err) {
      // Log malformed entries for debugging
      console.warn('[tipsgg] Skipped malformed match:', (err as Error).message);
    }
  }

  return matches;
}

/**
 * Fetch and parse 7 days of matches from tips.gg for a given game.
 */
async function fetchTipsGgMatches(game: 'dota2' | 'cs2'): Promise<TipsGgMatch[]> {
  const gamePath = game === 'dota2' ? 'dota2' : 'csgo';
  const gameTag = game === 'dota2' ? 'dota2' : 'cs2';
  const CIRCUIT_NAME = `tipsgg_fetch_${gamePath}_matches`;
  if (isOpen(CIRCUIT_NAME)) {
    throw new Error(`Circuit breaker open for ${CIRCUIT_NAME}`);
  }

  const startTime = Date.now();
  const today = formatDateDdMmYyyy(new Date());

  // Build 7 dates: today + next 6 days
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(formatDateDdMmYyyy(new Date(Date.now() + i * 86400000)));
  }

  // Fetch all 7 days with concurrency limit of 3 (avoid overwhelming tips.gg)
  const CONCURRENCY = 5;
  const results: { date: string; html: string | null }[] = [];
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (date) => {
        const url = `${TIPSGG_BASE}/${gamePath}/matches/${date}/`;
        return { date, html: await fetchHtml(url) };
      }),
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ date: '', html: null });
    }
  }

  const htmlTime = Date.now();

  // Parse each day's HTML
  const seen = new Set<string>();
  const all: TipsGgMatch[] = [];
  const dayCounts: string[] = [];
  for (const { date, html } of results) {
    if (!html) continue;
    const dayMatches = await parseMatchesFromHtml(html, game);
    dayCounts.push(`${dayMatches.length} ${date}`);
    for (const m of dayMatches) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        all.push(m);
      }
    }
  }

  // If all 7 days returned nothing, try the main listing page as last resort
  if (all.length === 0) {
    try {
      const mainHtml = await fetchHtml(`${TIPSGG_BASE}/${gamePath}/matches/`);
      const mainMatches = await parseMatchesFromHtml(mainHtml, game);
      for (const m of mainMatches) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          all.push(m);
        }
      }
      console.log(`[tipsgg:${gameTag}] Fallback: ${mainMatches.length} matches from main listing`);
    } catch {
      // Silently fail — fallback is best-effort
    }
  }

  // Batch-fetch predictions pages for real coefficients
  const coeffsStart = Date.now();
  await enrichCoefficients(all);

  const totalTime = Date.now();
  const withCoeffs = all.filter(m => m.coeff1 != null).length;

  console.log(
    `[tipsgg:${gameTag}] Done: ${all.length} matches ` +
    `(${dayCounts.join(', ')}) | ` +
    `coeffs: ${withCoeffs}/${all.length} | ` +
    `html: ${htmlTime - startTime}ms ` +
    `coeffs: ${totalTime - coeffsStart}ms total: ${totalTime - startTime}ms`
  );

  recordSuccess(CIRCUIT_NAME);
  return all;
}

/** Fetch Dota 2 matches from tips.gg. */
export async function fetchDota2Matches(): Promise<TipsGgMatch[]> {
  return fetchTipsGgMatches('dota2');
}

/** Fetch CS2 matches from tips.gg. */
export async function fetchCs2Matches(): Promise<TipsGgMatch[]> {
  return fetchTipsGgMatches('cs2');
}

/**
 * Fetch a single match page for detailed info.
 */
export async function fetchMatchDetail(matchUrl: string, game: 'dota2' | 'cs2' = 'dota2'): Promise<TipsGgMatch | null> {
  const fullUrl = matchUrl.startsWith('http') ? matchUrl : `${TIPSGG_BASE}${matchUrl}`;

  const html = await fetchHtml(fullUrl);
  const logoMap = buildLogoMap(html, game);
  const jsonLdMatches = extractJsonLd(html, game);

  if (jsonLdMatches.length === 0) return null;

  const ld = jsonLdMatches[0];
  const competitor1 = ld.competitor?.[0];
  const competitor2 = ld.competitor?.[1];
  if (!competitor1 || !competitor2) return null;

  const description = ld.description || '';
  const dateKey = parseIsoDate(ld.startDate);
  const { score1, score2, status } = extractScoresFromHtml(html, ld.url);

  const pred1 = ld.performer?.name === competitor1.name ? 55
    : ld.performer?.name === competitor2.name ? 45 : 50;

  const match: TipsGgMatch = {
    id: slugFromUrl(ld.url),
    date: dateKey,
    link: ld.url,
    type: parseMatchType(description),
    score1,
    score2,
    nameTeam1: competitor1.name,
    nameTeam2: competitor2.name,
    logoTeam1: getTeamLogo(competitor1.name, competitor1.url, logoMap),
    logoTeam2: getTeamLogo(competitor2.name, competitor2.url, logoMap),
    tournament: ld.organizer?.name || '',
    tournamentLogo: null, // detail endpoint doesn't extract organizer URL
    stage: parseStage(description),
    status: status !== 'upcoming' ? status : parseEventStatus(ld.eventStatus, ld.startDate),
    tipsCount: 0,
    performer: ld.performer?.name || null,
    startDate: ld.startDate,
    pred1,
    pred2: 100 - pred1,
    coeff1: null,
    coeff2: null,
  };

  // Try to enrich with real coefficients (best-effort, don't fail on error)
  try {
    const coeffs = await fetchCoefficientsFromPredictions(ld.url);
    if (coeffs) {
      match.coeff1 = coeffs.coeff1;
      match.coeff2 = coeffs.coeff2;
      const imp1 = 1 / coeffs.coeff1;
      const imp2 = 1 / coeffs.coeff2;
      const total = imp1 + imp2;
      if (total > 0) {
        match.pred1 = Math.round((imp1 / total) * 100);
        match.pred2 = Math.round((imp2 / total) * 100);
      }
    }
  } catch {
    // best-effort
  }

  return match;
}

// Backward-compatible alias
export const fetchDota2MatchDetail = fetchMatchDetail;

/**
 * Fetch predictions page → extract Bookmakers Analysis coefficients.
 * Raw HTML: <span class="avg-odd">16.20</span>
 * team-first = team1, team-second = team2 (skip team-draw).
 */
async function fetchCoefficientsFromPredictions(link: string, retries = 2): Promise<{ coeff1: number; coeff2: number } | null> {
  const slug = slugFromUrl(link);

  // Check file cache first — coefficients change slowly (~20 min TTL)
  const cached = getCachedCoefficients(slug);
  if (cached) return cached;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const predPath = link.endsWith('/') ? link + 'predictions/' : link + '/predictions/';
      const html = await fetchHtml(`${TIPSGG_BASE}${predPath}`);

      // Find bookmakers analysis counters section
      // New tips.gg structure (2026-07): <div class="bookmakers-analysis-counters">
      // containing <div class="team team-first"> / <div class="team team-second">
      // with <span class="avg-odd">N.NN</span> inside.
      // NOTE: Must search for the HTML element, not the string — CSS selectors match first.
      let baIdx = html.indexOf('<div class="bookmakers-analysis-counters">');
      if (baIdx === -1) baIdx = html.indexOf('class="bookmakers-analysis-counters"');
      if (baIdx === -1) {
        // No coefficients section — page simply has no odds
        return null;
      }

      const chunk = html.substring(baIdx, Math.min(html.length, baIdx + 3000));

      // Try named team patterns first
      const firstNamed = chunk.match(/team-first[\s\S]*?avg-odd">([\d.]+)<\/span>/i);
      const secondNamed = chunk.match(/team-second[\s\S]*?avg-odd">([\d.]+)<\/span>/i);
      if (firstNamed && secondNamed) {
        const result = { coeff1: parseFloat(firstNamed[1]), coeff2: parseFloat(secondNamed[1]) };
        setCachedCoefficients(slug, result.coeff1, result.coeff2);
        return result;
      }

      // Fallback: grab all avg-odd values, skip team-draw
      const allOdds = [...chunk.matchAll(/avg-odd">([\d.]+)<\/span>/gi)];
      const nonDrawOdds: number[] = [];
      for (let i = 0; i < allOdds.length && nonDrawOdds.length < 2; i++) {
        const posBefore = allOdds[i].index!;
        const snippet = chunk.substring(Math.max(0, posBefore - 100), posBefore);
        if (!/team-draw/i.test(snippet)) {
          nonDrawOdds.push(parseFloat(allOdds[i][1]));
        }
      }

      if (nonDrawOdds.length >= 2) {
        const result = { coeff1: nonDrawOdds[0], coeff2: nonDrawOdds[1] };
        setCachedCoefficients(slug, result.coeff1, result.coeff2);
        return result;
      }

      // No odds matched — retry with backoff if attempts remain
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 500));
      } else {
        // Log diagnostic: found bookmakers-analysis-counters but couldn't extract odds
        const odc = (html.match(/avg-odd/gi) || []).length;
        const bam = (html.match(/bookmakers-analysis-counters/gi) || []).length;
        console.warn(`[tipsgg] Coefficients extraction failed for ${link} — bookmakers-counters: ${bam}, avg-odd spans: ${odc}`);
        return null;
      }
    } catch {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, (attempt + 1) * 500));
    }
  }
  return null;
}

async function enrichCoefficients(matches: TipsGgMatch[]): Promise<void> {
  const CONCURRENCY = 4;
  const BATCH_PAUSE_MS = 200; // 200ms between batches — enough to not overwhelm tips.gg
  const PER_MATCH_TIMEOUT_MS = 25000; // 25s hard cap per match
  const now = Date.now();
  const MAX_FUTURE_MS = 12 * 60 * 60 * 1000; // 12h — skip matches starting too far into the future
  const toFetch = matches.filter(m => {
    if (m.status === 'finished') return false;
    // Skip matches starting more than 12h from now (predictions page may not exist yet)
    try {
      const start = new Date(m.startDate).getTime();
      if (start - now > MAX_FUTURE_MS) return false;
    } catch { /* include if date is unparseable */ }
    return true;
  });
  let successCount = 0;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (m) => {
      try {
        const result = await Promise.race([
          fetchCoefficientsFromPredictions(m.link),
          new Promise<null>(resolve => setTimeout(() => resolve(null), PER_MATCH_TIMEOUT_MS)),
        ]);
        if (result) {
          m.coeff1 = result.coeff1;
          m.coeff2 = result.coeff2;
          // Derive normalized predictions from real bookmaker coefficients
          // Implied probability: 1/coeff, then normalize to sum 100% (remove overround)
          const imp1 = 1 / result.coeff1;
          const imp2 = 1 / result.coeff2;
          const total = imp1 + imp2;
          if (total > 0) {
            m.pred1 = Math.round((imp1 / total) * 100);
            m.pred2 = Math.round((imp2 / total) * 100);
          }
          return true;
        }
      } catch { /* skip */ }
      return false;
    }));
    successCount += results.filter(r => r.status === 'fulfilled' && r.value).length;

    if (i + CONCURRENCY < toFetch.length) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  if (successCount > 0 || toFetch.length > 0) {
    console.log(`[tipsgg] Coefficients: ${successCount}/${toFetch.length} enriched`);
  }
}

// ── Helpers ──

function extractJsonLd(html: string, game: 'dota2' | 'cs2' = 'dota2'): JsonLdSportsEvent[] {
  const results: JsonLdSportsEvent[] = [];
  const regex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  const sportPattern = game === 'cs2'
    ? /cs2|csgo|counter[- ]?strike/i
    : /dota\s*2/i;

  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      // Match both 'SportsEvent' and 'Event' types (tips.gg may vary)
      // Allow case-insensitive sport match, and also match when sport is missing
      const isSportsEvent = data['@type'] === 'SportsEvent' || data['@type'] === 'Event';
      const isCorrectSport = !data.sport || sportPattern.test(data.sport);
      if (data && isSportsEvent && isCorrectSport && Array.isArray(data.competitor) && data.competitor.length >= 2) {
        results.push(data as JsonLdSportsEvent);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return results;
}

/**
 * Build a map of team name → actual logo URL by parsing <img> tags in HTML.
 */
function buildLogoMap(html: string, game: 'dota2' | 'cs2' = 'dota2'): Map<string, string> {
  const map = new Map<string, string>();
  // Match any <img> tag — try src, data-src, and content attributes
  const imgRegex = /<img[^>]+>/gi;
  let m: RegExpExecArray | null;

  const sportPattern = game === 'cs2'
    ? /\s[-–—]\s(Counter-Strike|CS2|CSGO)\s/i
    : /\s[-–—]\sDota\s2\s/i;

  while ((m = imgRegex.exec(html)) !== null) {
    const tag = m[0];

    const altM = /alt="([^"]+)"\s/i.exec(tag);
    if (!altM) continue;
    // Only match teams for the correct game
    if (!sportPattern.test(altM[1].trim())) continue;

    // Try data-src first (lazy loading), then src
    let src = '';
    const ds = /data-src="([^"]+)"/i.exec(tag);
    if (ds) src = ds[1];
    if (!src) {
      const s = /src="([^"]+)"/i.exec(tag);
      if (s) src = s[1];
    }

    // Skip placeholders and default images (keep SVGs — some teams have SVG logos)
    if (!src || src.startsWith('data:') || src.includes('default')) continue;

    const teamName = altM[1]
      .replace(/\s*[-–—]\s*(Dota 2|Counter-Strike|CS2|CSGO)\s*(Team)?$/i, '')
      .trim();
    if (teamName && !map.has(teamName)) {
      map.set(teamName, src);
    }
  }

  return map;
}

/** Known CDN filename overrides — slug → real filename on files.tips.gg */
const LOGO_OVERRIDES: Record<string, string> = {
  'nigma-galaxy-dota2': 'nigma-galaxy-dota2-dota2',
  'playtime-dota2': 'PlayTime-dota2',
  'nemiga-gaming-dota2': 'nemiga-gaming-2020-dota2',
  'gamerlegion-dota2': 'Gamerlegion-cs21',
  'betboom-team-dota2': 'betboom-dota2',
  'team-spirit-dota2': 'team-spirit-2021-dota2',
  'psg-lgd-gaming-dota2': 'psg-lgd-gaming-dota2',
  'team-syntax-dota2': 'Team-Syntax-dota2',
};

/** Get team logo from map, overrides, or slug-derived URL */
function getTeamLogo(teamName: string, teamUrl: string, logoMap: Map<string, string>): string | null {
  // 1. Exact map match (from HTML <img> data-src — always correct when present)
  if (logoMap.has(teamName)) return logoMap.get(teamName) ?? null;

  // 2. Case-insensitive map match
  for (const [key, url] of logoMap) {
    if (key.toLowerCase() === teamName.toLowerCase()) return url;
  }

  // 3. Known CDN filename overrides (slug-based)
  const slug = teamUrl.replace(/\/$/, '').split('/').pop() || '';
  const overrideSlug = LOGO_OVERRIDES[slug];
  if (overrideSlug) return `https://files.tips.gg/static/image/teams/${overrideSlug}.png`;

  // 4. Try multiple possible CDN filenames (CDN naming is unpredictable)
  //    e.g. slug="m80" → try m80-csgo.png, m80.png, m80-cs2.png, etc.
  const candidates = [slug];
  if (!slug.endsWith('-csgo')) candidates.push(`${slug}-csgo`);
  if (!slug.endsWith('-cs2')) candidates.push(`${slug}-cs2`);
  if (!slug.endsWith('-dota2')) candidates.push(`${slug}-dota2`);

  // Also try removing the last segment if it looks like a game suffix
  const withoutGame = slug.replace(/-(csgo|cs2|dota2)$/i, '');
  if (withoutGame !== slug) {
    candidates.push(withoutGame);
    candidates.push(`${withoutGame}-csgo`);
    candidates.push(`${withoutGame}-dota2`);
  }

  // Return the first candidate — the logo proxy will fallback through alternatives on 502
  return `https://files.tips.gg/static/image/teams/${candidates[0]}.png`;
}

/**
 * Extract unique slug from match URL.
 * "/matches/dota2/10-07-2026/rune-eaters-vs-gamerlegion/10-00/" → "rune-eaters-vs-gamerlegion"
 */
function slugFromUrl(url: string): string {
  const parts = url.replace(/\/$/, '').split('/');
  // URL format: /matches/dota2/DD-MM-YYYY/SLUG/HH-MM/
  // The slug is at index parts.length - 2
  return parts[parts.length - 2] || parts[parts.length - 1] || url;
}

function formatDateDdMmYyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// ── HTTP fetch via Puppeteer (bypasses Cloudflare JS challenge) ──

import puppeteer, { type Browser, type Page } from 'puppeteer';

const PUPPETEER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

let _browser: Browser | null = null;
let _browserAge = 0; // ms since launch — rotate periodically to avoid memory leaks
const MAX_BROWSER_AGE = 15 * 60 * 1000; // 15 min — rotate to prevent memory creep

/** Get or create a shared browser instance. Pages are ephemeral; browser is long-lived. */
export async function getBrowser(): Promise<Browser> {
  const now = Date.now();
  // Rotate periodically to prevent memory creep from leaked contexts
  if (_browser && (now - _browserAge) < MAX_BROWSER_AGE) {
    try {
      if (_browser.connected) return _browser;
    } catch {
      // Browser process died (e.g. external kill) — recreate below
      _browser = null;
    }
  }
  // Close old browser if any
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--headless=new',
      '--window-position=-32000,-32000',
    ],
  });
  _browserAge = now;
  return _browser;
}

export async function fetchHtml(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let page: Page | null = null;
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setUserAgent(PUPPETEER_UA);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,uk;q=0.8',
      });
      // Navigate and wait for content (Cloudflare challenge resolves automatically)
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      // Wait for JSON-LD to appear (reliable content-ready signal) — fallback to timeout
      try {
        await page.waitForSelector('script[type="application/ld+json"]', { timeout: 8000 });
      } catch { /* no JSON-LD detected — page may have loaded differently, proceed anyway */ }
      const html = await page.content();
      if (html.length < 2000) {
        throw new Error(`Empty/too-short response (${html.length} bytes)`);
      }
      // Detect Cloudflare challenge page — if so, close page and retry
      if (html.includes('_cf_chl_opt') || html.includes('Just a moment') || html.includes('cf-browser-verify')) {
        await page.close().catch(() => {});
        throw new Error('Cloudflare challenge detected — retrying');
      }
      // Validate that actual match content is present
      if (!html.includes('class="element match') && !html.includes('application/ld+json')) {
        await page.close().catch(() => {});
        throw new Error(`Page loaded but no match data found (${html.length} bytes)`);
      }
      return html;
    } catch (err: any) {
      if (page) await page.close().catch(() => {});
      if (attempt === retries) {
        const msg = err.message || 'unknown';
        throw new Error(`Puppeteer failed for ${url}: ${msg}`);
      }
    }
  }
  throw new Error(`Puppeteer failed for ${url} after ${retries} retries`);
}

/** Clean up browser on process exit */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
