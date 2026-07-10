/**
 * Tips.GG Dota 2 Match Scraper
 *
 * Fetches the tips.gg Dota 2 match listing page, extracts JSON-LD
 * structured data and score info, returns typed match objects.
 *
 * Works without login — tips.gg serves public data in <script type="application/ld+json">.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isOpen, recordSuccess, recordFailure } from './circuitBreaker';

const execFileAsync = promisify(execFile);

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
  const parts = desc.split('.').map(s => s.trim());
  const stagePart = parts.find(p => /group|playoff|final|stage/i.test(p));
  return stagePart || '';
}

function parseEventStatus(statusUrl: string): 'upcoming' | 'live' | 'finished' {
  if (statusUrl.includes('EventScheduled')) return 'upcoming';
  if (statusUrl.includes('EventRescheduled')) return 'upcoming';
  if (statusUrl.includes('EventPostponed')) return 'upcoming';
  if (statusUrl.includes('EventCancelled')) return 'finished';
  return 'upcoming';
}

/**
 * Extract scores from the raw HTML near each match.
 *
 * tips.gg score markup:
 *   <span class="score normal">1</span>
 *   <span class="score normal">1</span>
 */
function extractScoresFromHtml(
  html: string,
  matchUrl: string,
): { score1: number | null; score2: number | null; status: 'upcoming' | 'live' | 'finished' } {
  // Find the match URL in HTML
  const urlIndex = html.indexOf(matchUrl);
  if (urlIndex === -1) {
    return { score1: null, score2: null, status: 'upcoming' };
  }

  // Status is on the parent <div class="element match finished"> — BEFORE the URL.
  // Score spans and <span class="status finished"> are AFTER the URL.
  const chunkStart = Math.max(0, urlIndex - 600);
  const chunkEnd = Math.min(html.length, urlIndex + 2500);
  const chunk = html.substring(chunkStart, chunkEnd);

  // Match score elements: <span class="score ...">DIGIT</span>
  const scoreRegex = /class="score[^"]*">(\d{1,2})<\/span>/gi;
  const scores = [...chunk.matchAll(scoreRegex)].map(m => parseInt(m[1], 10));

  // Status detection — look for:
  //   <span class="status finished">Today</span>     → finished
  //   <span class="status live">LIVE</span>           → live
  //   class="match live" or match finished in parent div
  const hasFinished = /class="[^"]*status\s[^"]*finished|class="[^"]*match\s[^"]*finished/i.test(chunk);
  const hasLive = !hasFinished && /class="[^"]*status\s[^"]*live|class="[^"]*match\s[^"]*live|Starting|In \d+ min/i.test(chunk);

  if (scores.length >= 2) {
    // If scores are 0-0 and there's a finished marker, it hasn't started yet
    // so keep it as upcoming (not finished)
    const allZero = scores[0] === 0 && scores[1] === 0;
    return {
      score1: scores[0],
      score2: scores[1],
      status: !allZero && hasFinished ? 'finished'
        : hasLive ? 'live'
        : allZero && !hasLive ? 'upcoming'
        : 'live',
    };
  }

  return { score1: null, score2: null, status: 'upcoming' };
}

/**
 * Extract tips count from HTML near the match URL.
 */
function extractTipsCount(html: string, matchUrl: string): number {
  const urlIndex = html.indexOf(matchUrl);
  if (urlIndex === -1) return 0;

  const chunk = html.substring(Math.max(0, urlIndex - 500), urlIndex + 500);

  // Pattern: "7 tips" or similar
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

      const { score1, score2, status } = extractScoresFromHtml(html, ld.url);
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
        status: status !== 'upcoming' ? status : parseEventStatus(ld.eventStatus),
        tipsCount,
        performer: ld.performer?.name || null,
        startDate: ld.startDate,
        pred1,
        pred2: 100 - pred1,
        coeff1: null,
        coeff2: null,
      });
    } catch {
      // Skip malformed
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

  return {
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
    status: status !== 'upcoming' ? status : parseEventStatus(ld.eventStatus),
    tipsCount: 0,
    performer: ld.performer?.name || null,
    startDate: ld.startDate,
    pred1,
    pred2: 100 - pred1,
    coeff1: null,
    coeff2: null,
  };
}

/**
 * Fetch predictions page → extract Bookmakers Analysis coefficients.
 * Raw HTML: <span class="avg-odd">16.20</span>
 * team-first = team1, team-second = team2 (skip team-draw).
 */
async function fetchCoefficientsFromPredictions(link: string, retries = 1): Promise<{ coeff1: number; coeff2: number } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const predUrl = link.endsWith('/') ? link + 'predictions/' : link + '/predictions/';
      const html = await fetchHtml(`${TIPSGG_BASE}${predUrl}`);

      const baIdx = html.indexOf('class="bookmakers-analysis-counters"');
      if (baIdx === -1) return null;

      const chunk = html.substring(baIdx, baIdx + 1000);
      const firstMatch = chunk.match(/team-first[\s\S]*?avg-odd">([\d.]+)<\/span>/i);
      const secondMatch = chunk.match(/team-second[\s\S]*?avg-odd">([\d.]+)<\/span>/i);

      if (firstMatch && secondMatch) {
        return { coeff1: parseFloat(firstMatch[1]), coeff2: parseFloat(secondMatch[1]) };
      }
      return null;
    } catch {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, (attempt + 1) * 500));
    }
  }
  return null;
}

async function enrichCoefficients(matches: TipsGgMatch[]): Promise<void> {
  const CONCURRENCY = 3;
  const BATCH_PAUSE_MS = 800; // pause between batches to avoid rate limiting
  const toFetch = matches.filter(m => m.status !== 'finished');
  let successCount = 0;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (m) => {
      try {
        const result = await fetchCoefficientsFromPredictions(m.link);
        if (result) {
          m.coeff1 = result.coeff1;
          m.coeff2 = result.coeff2;
          m.pred1 = Math.round((1 / result.coeff1) * 100);
          m.pred2 = Math.round((1 / result.coeff2) * 100);
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
      if (data && data['@type'] === 'SportsEvent' && data.sport === 'Dota 2') {
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

    // Skip placeholders and default images
    if (!src || src.startsWith('data:') || src.includes('default') || src.endsWith('.svg')) continue;

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

// ── HTTP fetch via curl (bypasses Cloudflare TLS fingerprinting) ──

const CURL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

async function fetchHtml(url: string, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
      const { stdout } = await execFileAsync('curl', [
        '-s', '-L', // silent, follow redirects
        '--max-time', '15',
        '-H', `User-Agent: ${CURL_UA}`,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: en-US,en;q=0.9,uk;q=0.8',
        url,
      ], { maxBuffer: 5 * 1024 * 1024, timeout: 20000 });
      if (stdout.length < 500) {
        throw new Error(`Empty/too-short response (${stdout.length} bytes)`);
      }
      return stdout;
    } catch (err: any) {
      // curl returns non-zero exit code on HTTP errors but still outputs HTML
      if (err.stdout && err.stdout.length > 1000) return err.stdout;
      if (attempt === retries) {
        throw new Error(`curl failed for ${url}: ${err.message}`);
      }
    }
  }
  throw new Error(`curl failed for ${url} after ${retries} retries`);
}
