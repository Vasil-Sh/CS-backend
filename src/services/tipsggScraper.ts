/**
 * Tips.GG Dota 2 Match Scraper
 *
 * Fetches the tips.gg Dota 2 match listing page, extracts JSON-LD
 * structured data and score info, returns typed match objects.
 *
 * Works without login — tips.gg serves public data in <script type="application/ld+json">.
 */

import { z } from 'zod';
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

  // Date-based fallback: if startDate is in the past, match is likely live
  if (startDate) {
    try {
      const start = new Date(startDate).getTime();
      const now = Date.now();
      // Match started more than 2h ago → probably finished (Dota2 BO3: ~2h avg, BO5: ~3h)
      if (start < now - 2 * 60 * 60 * 1000) return 'finished';
      // Match started but within last 2h → likely live
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
 * Extract scores and status from the raw HTML near each match.
 * Uses JSON-LD block as anchor — it's always immediately after the
 * <div class="element match finished  visible"> parent.
 */
function extractScoresFromHtml(
  html: string,
  rawMatchUrl: string,
): { score1: number | null; score2: number | null; status: 'upcoming' | 'live' | 'finished' } {
  // Strategy: find the JSON-LD script block for this match URL,
  // then look BACKWARDS to find the parent <div class="element match ...">
  const slug = slugFromUrl(rawMatchUrl);
  if (!slug) return { score1: null, score2: null, status: 'upcoming' };

  // Find the JSON-LD block containing this match's slug
  const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  let targetScriptStart = -1;
  let targetScriptEnd = -1;

  while ((ldMatch = ldRegex.exec(html)) !== null) {
    if (ldMatch[1].includes(slug)) {
      targetScriptStart = ldMatch.index;
      targetScriptEnd = ldMatch.index + ldMatch[0].length;
      break;
    }
  }

  if (targetScriptStart === -1) {
    return { score1: null, score2: null, status: 'upcoming' };
  }

  // Find parent status class — tips.gg: <div class="element match finished  visible">
  // Search backward from the script to find the class with "match" in it
  const beforeForDiv = html.substring(0, targetScriptStart);
  const divMatch = beforeForDiv.match(/class="[^"]*match\s+(\w+)/g);
  let statusWord = '';
  if (divMatch) {
    // Take the LAST match (closest to the script)
    const lastClass = divMatch[divMatch.length - 1];
    const statusMatch = lastClass.match(/match\s+(\w+)/);
    statusWord = statusMatch?.[1] || '';
  }

  // Also search for "live" or "finished" anywhere in nearby class attributes
  if (!statusWord) {
    const nearDivs = beforeForDiv.match(/class="([^"]*\b(live|finished)\b[^"]*)"/gi);
    if (nearDivs) {
      const last = nearDivs[nearDivs.length - 1];
      if (/finished/i.test(last)) statusWord = 'finished';
      else if (/live/i.test(last)) statusWord = 'live';
    }
  }

  const hasFinished = statusWord === 'finished';
  const hasLive = statusWord === 'live';

  // Look FORWARD for scores — stop at the next match element boundary
  const afterEndBoundary = html.indexOf('<div class="element match', targetScriptEnd);
  const afterEnd = afterEndBoundary > targetScriptEnd
    ? afterEndBoundary
    : Math.min(html.length, targetScriptEnd + 3000);
  const after = html.substring(targetScriptEnd, afterEnd);

  // Also search BEFORE the script (scores are between parent div and JSON-LD)
  const beforeChunk = html.substring(Math.max(0, targetScriptStart - 1200), targetScriptStart);
  const scoreRegex = /class="score[^"]*">(\d{1,2})<\/span>/gi;
  const afterScores = [...after.matchAll(scoreRegex)];
  const beforeScores = [...beforeChunk.matchAll(scoreRegex)];
  const allScores = [...beforeScores, ...afterScores].map(m => parseInt(m[1], 10));

  // Compute total scores: team1 = even indices, team2 = odd indices
  let score1 = 0, score2 = 0;
  for (let i = 0; i < allScores.length; i++) {
    if (i % 2 === 0) score1 += allScores[i];
    else score2 += allScores[i];
  }

  if (allScores.length >= 1) {
    const allZero = score1 === 0 && score2 === 0;
    return {
      score1,
      score2,
      status: hasFinished ? 'finished'
        : hasLive ? 'live'
        : allZero ? 'upcoming'
        : 'live',
    };
  }

  // No scores found (upcoming match or broken HTML) — still use the status from parent div
  return {
    score1: null,
    score2: null,
    status: hasFinished ? 'finished' : hasLive ? 'live' : 'upcoming',
  };
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
async function parseMatchesFromHtml(html: string): Promise<TipsGgMatch[]> {
  const logoMap = buildLogoMap(html);
  const jsonLdMatches = extractJsonLd(html);
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
      if (status !== 'finished') {
        const matchType = parseMatchType(description);
        const s1 = score1 ?? 0, s2 = score2 ?? 0;
        const winnerScore = Math.max(s1, s2);
        if ((matchType === 'BO3' && winnerScore >= 2) ||
            (matchType === 'BO5' && winnerScore >= 3) ||
            (matchType === 'BO2' && (s1 + s2) >= 2 && winnerScore >= 2) ||
            (matchType === 'BO1' && (s1 + s2) >= 1 && Math.abs(s1 - s2) >= 1)) {
          status = 'finished';
        }
      }

      // Date-based safety override: if HTML says "live" but match started >2.5h ago, it's probably finished
      // (tips.gg sometimes doesn't update the class in time)
      if (status === 'live') {
        try {
          const start = new Date(ld.startDate).getTime();
          if (Date.now() - start > 2.5 * 60 * 60 * 1000) {
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
 * Fetch and parse today's + tomorrow's Dota 2 matches from tips.gg.
 */
export async function fetchDota2Matches(): Promise<TipsGgMatch[]> {
  const CIRCUIT_NAME = 'tipsgg_fetchDota2Matches';
  if (isOpen(CIRCUIT_NAME)) {
    throw new Error(`Circuit breaker open for ${CIRCUIT_NAME}`);
  }

  const startTime = Date.now();
  const today = formatDateDdMmYyyy(new Date());
  const tomorrow = formatDateDdMmYyyy(new Date(Date.now() + 86400000));

  const [todayHtml, tomorrowHtml] = await Promise.allSettled([
    fetchHtml(`${TIPSGG_BASE}/dota2/matches/${today}/`),
    fetchHtml(`${TIPSGG_BASE}/dota2/matches/${tomorrow}/`),
  ]);

  const htmlTime = Date.now();

  const todayMatches = todayHtml.status === 'fulfilled'
    ? await parseMatchesFromHtml(todayHtml.value)
    : [];
  const tomorrowMatches = tomorrowHtml.status === 'fulfilled'
    ? await parseMatchesFromHtml(tomorrowHtml.value)
    : [];

  const parseTime = Date.now();

  // Merge & dedup by id
  const seen = new Set<string>();
  const all: TipsGgMatch[] = [];
  for (const m of [...todayMatches, ...tomorrowMatches]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      all.push(m);
    }
  }

  // If both today and tomorrow failed, try yesterday — live matches may still be there
  if (all.length === 0 && todayHtml.status === 'rejected' && tomorrowHtml.status === 'rejected') {
    const yesterday = formatDateDdMmYyyy(new Date(Date.now() - 86400000));
    try {
      const yesterdayHtml = await fetchHtml(`${TIPSGG_BASE}/dota2/matches/${yesterday}/`);
      const yesterdayMatches = await parseMatchesFromHtml(yesterdayHtml);
      for (const m of yesterdayMatches) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          all.push(m);
        }
      }
      console.log(`[tipsgg] Fallback: ${yesterdayMatches.length} matches from yesterday (${yesterday})`);
    } catch {
      // Silently fail — yesterday is best-effort
    }
  }

  // Batch-fetch predictions pages for real coefficients
  await enrichCoefficients(all);

  const totalTime = Date.now();
  const withCoeffs = all.filter(m => m.coeff1 != null).length;

  console.log(
    `[tipsgg] Done: ${all.length} matches ` +
    `(${todayMatches.length} today, ${tomorrowMatches.length} tomorrow) | ` +
    `coeffs: ${withCoeffs}/${all.length} | ` +
    `html: ${htmlTime - startTime}ms parse: ${parseTime - htmlTime}ms ` +
    `coeffs: ${totalTime - parseTime}ms total: ${totalTime - startTime}ms`
  );

  recordSuccess(CIRCUIT_NAME);
  return all;
}

/**
 * Fetch a single match page for detailed info.
 */
export async function fetchDota2MatchDetail(matchUrl: string): Promise<TipsGgMatch | null> {
  const fullUrl = matchUrl.startsWith('http') ? matchUrl : `${TIPSGG_BASE}${matchUrl}`;

  const html = await fetchHtml(fullUrl);
  const logoMap = buildLogoMap(html);
  const jsonLdMatches = extractJsonLd(html);

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

/**
 * Fetch predictions page → extract Bookmakers Analysis coefficients.
 * Raw HTML: <span class="avg-odd">16.20</span>
 * team-first = team1, team-second = team2 (skip team-draw).
 */
async function fetchCoefficientsFromPredictions(link: string, retries = 2): Promise<{ coeff1: number; coeff2: number } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const predPath = link.endsWith('/') ? link + 'predictions/' : link + '/predictions/';
      const html = await fetchHtml(`${TIPSGG_BASE}${predPath}`);

      // Find bookmakers analysis section (relaxed class match)
      const baIdx = html.indexOf('bookmakers-analysis');
      if (baIdx === -1) {
        // No coefficients section — page simply has no odds
        // Log a sample URL once to help debug
        if (!link.includes('debugged-predictions')) {
          console.warn(`[tipsgg] No bookmakers-analysis for ${link} — predictions page may have changed layout`);
        }
        return null;
      }

      const chunk = html.substring(baIdx, Math.min(html.length, baIdx + 2000));

      // Try named team patterns first
      const firstNamed = chunk.match(/team-first[\s\S]*?avg-odd">([\d.]+)<\/span>/i);
      const secondNamed = chunk.match(/team-second[\s\S]*?avg-odd">([\d.]+)<\/span>/i);
      if (firstNamed && secondNamed) {
        return { coeff1: parseFloat(firstNamed[1]), coeff2: parseFloat(secondNamed[1]) };
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
        return { coeff1: nonDrawOdds[0], coeff2: nonDrawOdds[1] };
      }

      // No odds matched — retry with backoff if attempts remain
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 500));
      } else {
        // Log diagnostic: found bookmakers-analysis but couldn't extract any odds
        const odc = (html.match(/avg-odd/gi) || []).length;
        const bam = (html.match(/bookmakers-analysis/gi) || []).length;
        console.warn(`[tipsgg] Coefficients extraction failed for ${link} — bookmakers-analyses: ${bam}, avg-odd spans: ${odc}`);
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
  const CONCURRENCY = 2;
  const BATCH_PAUSE_MS = 1200;
  const PER_MATCH_TIMEOUT_MS = 30000; // 30s hard cap per match
  const toFetch = matches.filter(m => m.status !== 'finished');
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

function extractJsonLd(html: string): JsonLdSportsEvent[] {
  const results: JsonLdSportsEvent[] = [];
  const regex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      // Match both 'SportsEvent' and 'Event' types (tips.gg may vary)
      // Allow case-insensitive sport match, and also match when sport is missing
      const isSportsEvent = data['@type'] === 'SportsEvent' || data['@type'] === 'Event';
      const isDota = !data.sport || /dota\s*2/i.test(data.sport);
      if (data && isSportsEvent && isDota && Array.isArray(data.competitor) && data.competitor.length >= 2) {
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
function buildLogoMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match any <img> tag — try src, data-src, and content attributes
  const imgRegex = /<img[^>]+>/gi;
  let m: RegExpExecArray | null;

  while ((m = imgRegex.exec(html)) !== null) {
    const tag = m[0];

    const altM = /alt="([^"]+)"\s/i.exec(tag);
    if (!altM) continue;
    // Only match "X – Dota 2 Team" pattern in alt
    if (!/\s[-–—]\sDota\s2\sTeam$/i.test(altM[1].trim())) continue;

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

    const teamName = altM[1].replace(/\s*[-–—]\s*Dota 2\s*Team$/i, '').trim();
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
  // 1. Exact map match
  if (logoMap.has(teamName)) return logoMap.get(teamName) ?? null;

  // 2. Case-insensitive map match
  for (const [key, url] of logoMap) {
    if (key.toLowerCase() === teamName.toLowerCase()) return url;
  }

  // 3. Known CDN filename overrides (slug-based)
  const slug = teamUrl.replace(/\/$/, '').split('/').pop() || '';
  const overrideSlug = LOGO_OVERRIDES[slug];
  if (overrideSlug) return `https://files.tips.gg/static/image/teams/${overrideSlug}.png`;

  // 4. Slug-derived URL
  if (slug) return `https://files.tips.gg/static/image/teams/${slug}.png`;

  return null;
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

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return _browser;
}

async function fetchHtml(url: string, retries = 2): Promise<string> {
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
      // Extra wait for dynamic content
      await new Promise(r => setTimeout(r, 2000));
      const html = await page.content();
      if (html.length < 2000) {
        throw new Error(`Empty/too-short response (${html.length} bytes)`);
      }
      return html;
    } catch (err: any) {
      if (attempt === retries) {
        const msg = err.message || 'unknown';
        throw new Error(`Puppeteer failed for ${url}: ${msg}`);
      }
    } finally {
      if (page) await page.close().catch(() => {});
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
