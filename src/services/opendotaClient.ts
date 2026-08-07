/**
 * OpenDota API Client — alternative Dota 2 data source.
 *
 * Provides live matches and recent pro matches when tips.gg is blocked.
 * Rate limit: 60 requests/min (free tier). We stay well under this.
 *
 * Endpoints used:
 *   GET /api/live           — currently live pro matches
 *   GET /api/proMatches     — recent pro matches (100 per page, paginated)
 *   GET /api/teams/{id}     — team details (logo)
 */

import type { TipsGgMatch } from './tipsggScraper';
import { isOpen, recordSuccess, recordFailure } from './circuitBreaker';

const OPENDOTA_BASE = 'https://api.opendota.com/api';
const UA = 'MatchIQ/1.0';
const CIRCUIT_NAME = 'opendota_fetch';
const REQUEST_TIMEOUT = 10_000; // 10s per request

// ── Type definitions for OpenDota API responses ──

interface OpenDotaLiveMatch {
  match_id: number;
  activate_time: number;   // unix timestamp when match went live
  deactivate_time: number; // unix timestamp when match ended (0 if still live)
  league_id: number;
  lobby_id: string;
  game_time: number;       // seconds elapsed
  delay: number;           // spectator delay in seconds
  spectators: number;
  average_mmr: number;
  team_name_radiant: string;
  team_name_dire: string;
  team_id_radiant: number;
  team_id_dire: number;
  radiant_score: number;
  dire_score: number;
  radiant_lead: number;    // net worth lead (negative = dire leads)
  series_id: number;
  sort_score: number;
}

interface OpenDotaProMatch {
  match_id: number;
  duration: number;        // seconds
  start_time: number;      // unix timestamp
  radiant_team_id: number;
  radiant_name: string;
  dire_team_id: number;
  dire_name: string;
  leagueid: number;
  league_name: string;
  series_id: number;
  series_type: number;     // 0=BO1, 1=BO3, 2=BO5
  radiant_score: number;
  dire_score: number;
  radiant_win: boolean;
  version: number;
}

interface OpenDotaTeam {
  team_id: number;
  name: string;
  tag: string;
  logo_url: string | null;
}

// ── Helpers ──

function unixToIsoDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().split('T')[0];
}

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function seriesTypeToString(st: number): string {
  switch (st) {
    case 0: return 'BO1';
    case 1: return 'BO3';
    case 2: return 'BO5';
    default: return 'BO3';
  }
}

async function fetchOpenDota<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${OPENDOTA_BASE}${path}`, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

// ── Team logo cache (in-memory, short TTL) ──

const teamLogoCache = new Map<number, string | null>();
const LOGO_CACHE_TTL = 3600_000; // 1 hour

async function getTeamLogo(teamId: number): Promise<string | null> {
  if (teamId <= 0) return null;

  const cached = teamLogoCache.get(teamId);
  if (cached !== undefined) return cached;

  // Don't cache failures (try next time)
  // Use a temporary entry to avoid thundering herd
  teamLogoCache.set(teamId, null);

  const team = await fetchOpenDota<OpenDotaTeam>(`/teams/${teamId}`);
  const logo = team?.logo_url || null;
  teamLogoCache.set(teamId, logo);

  // Auto-evict stale entries
  setTimeout(() => teamLogoCache.delete(teamId), LOGO_CACHE_TTL);

  return logo;
}

// ── Public API ──

/**
 * Fetch currently live Dota 2 pro matches from OpenDota.
 * Filters out pub games (league_id = 0).
 */
export async function fetchLiveMatches(): Promise<TipsGgMatch[]> {
  if (isOpen(CIRCUIT_NAME)) {
    throw new Error(`Circuit breaker open for ${CIRCUIT_NAME}`);
  }

  const live = await fetchOpenDota<OpenDotaLiveMatch[]>('/live');
  if (!live) {
    recordFailure(CIRCUIT_NAME);
    return [];
  }

  // Filter: pro matches only (league_id > 0). Skip high-MMR pubs without team names.
  const proMatches = live.filter(m => {
    if (m.league_id > 0) return true;
    // Only allow high-MMR matches that have actual team names (not pub stacks)
    if (m.average_mmr >= 8000) {
      const hasRadiant = m.team_name_radiant && m.team_name_radiant.length > 0;
      const hasDire = m.team_name_dire && m.team_name_dire.length > 0;
      return hasRadiant && hasDire;
    }
    return false;
  });

  // Batch-fetch team logos for live matches
  const teamIds = new Set<number>();
  for (const m of proMatches) {
    if (m.team_id_radiant > 0) teamIds.add(m.team_id_radiant);
    if (m.team_id_dire > 0) teamIds.add(m.team_id_dire);
  }
  // Fetch logos in parallel (max ~10 teams = 10 requests)
  const logoPromises = [...teamIds].map(async (id) => ({ id, logo: await getTeamLogo(id) }));
  const logos = await Promise.all(logoPromises);
  const logoMap = new Map(logos.map(({ id, logo }) => [id, logo]));

  const matches: TipsGgMatch[] = proMatches.map(m => {
    const matchId = `od-${m.match_id}`;
    const now = Date.now();
    const startTime = m.activate_time * 1000;
    const isLive = m.deactivate_time === 0;

    return {
      id: matchId,
      date: unixToIsoDate(m.activate_time),
      link: `https://www.opendota.com/matches/${m.match_id}`,
      type: 'BO3', // live matches: series type is not available, default BO3
      score1: m.radiant_score,
      score2: m.dire_score,
      nameTeam1: m.team_name_radiant || `Team ${m.team_id_radiant}`,
      nameTeam2: m.team_name_dire || `Team ${m.team_id_dire}`,
      logoTeam1: logoMap.get(m.team_id_radiant) || null,
      logoTeam2: logoMap.get(m.team_id_dire) || null,
      tournament: '', // league name not available in /live
      stage: '',
      status: isLive ? 'live' : 'finished',
      tipsCount: 0,
      performer: null,
      startDate: unixToIso(m.activate_time),
      pred1: 50,
      pred2: 50,
      coeff1: null,
      coeff2: null,
    };
  });

  recordSuccess(CIRCUIT_NAME);
  return matches;
}

/**
 * Fetch recent pro matches from OpenDota.
 * Paginates back to get ~200 matches (2 pages of 100).
 * This covers finished matches from the last ~1-2 days.
 */
export async function fetchProMatches(maxPages = 2): Promise<TipsGgMatch[]> {
  if (isOpen(CIRCUIT_NAME)) return [];

  const allMatches: OpenDotaProMatch[] = [];
  let lessThanMatchId: number | null = null;

  for (let page = 0; page < maxPages; page++) {
    const path = lessThanMatchId
      ? `/proMatches?less_than_match_id=${lessThanMatchId}`
      : '/proMatches';

    const batch = await fetchOpenDota<OpenDotaProMatch[]>(path);
    if (!batch || batch.length === 0) break;

    allMatches.push(...batch);
    lessThanMatchId = batch[batch.length - 1].match_id;

    // Pause between pages to respect rate limits
    if (page < maxPages - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (allMatches.length === 0) {
    recordFailure(CIRCUIT_NAME);
    return [];
  }

  // Batch-fetch team logos (deduplicated)
  const teamIds = new Set<number>();
  for (const m of allMatches) {
    if (m.radiant_team_id > 0) teamIds.add(m.radiant_team_id);
    if (m.dire_team_id > 0) teamIds.add(m.dire_team_id);
  }
  const logoPromises = [...teamIds].map(async (id) => ({
    id,
    logo: await getTeamLogo(id),
  }));
  const logos = await Promise.all(logoPromises);
  const logoMap = new Map(logos.map(({ id, logo }) => [id, logo]));

  // Deduplicate by match_id
  const seen = new Set<number>();
  const matches: TipsGgMatch[] = [];

  for (const m of allMatches) {
    if (seen.has(m.match_id)) continue;
    seen.add(m.match_id);

    const startTime = m.start_time * 1000;
    const now = Date.now();
    const hoursAgo = (now - startTime) / (1000 * 60 * 60);
    const isFinished = m.duration > 0;

    // Skip matches older than 48h (keep cache manageable)
    if (hoursAgo > 48) continue;

    matches.push({
      id: `od-${m.match_id}`,
      date: unixToIsoDate(m.start_time),
      link: `https://www.opendota.com/matches/${m.match_id}`,
      type: seriesTypeToString(m.series_type),
      score1: m.radiant_score,
      score2: m.dire_score,
      nameTeam1: m.radiant_name || `Team ${m.radiant_team_id}`,
      nameTeam2: m.dire_name || `Team ${m.dire_team_id}`,
      logoTeam1: logoMap.get(m.radiant_team_id) || null,
      logoTeam2: logoMap.get(m.dire_team_id) || null,
      tournament: m.league_name?.trim() || '',
      stage: '',
      status: isFinished ? 'finished' : (startTime > now ? 'upcoming' : 'live'),
      tipsCount: 0,
      performer: null,
      startDate: unixToIso(m.start_time),
      pred1: 50,
      pred2: 50,
      coeff1: null,
      coeff2: null,
    });
  }

  recordSuccess(CIRCUIT_NAME);
  return matches;
}

/**
 * Fetch all Dota 2 matches: live + recent pro matches.
 * Returns a combined, deduplicated array.
 */
export async function fetchDota2FromOpenDota(): Promise<TipsGgMatch[]> {
  const [live, pro] = await Promise.all([
    fetchLiveMatches(),
    fetchProMatches(),
  ]);

  // Merge: live matches take priority (they have real-time scores)
  const map = new Map<string, TipsGgMatch>();

  // Add pro matches first (lower priority)
  for (const m of pro) {
    map.set(m.id, m);
  }

  // Overlay live matches (higher priority — real-time scores)
  for (const m of live) {
    map.set(m.id, m);
  }

  const merged = [...map.values()];

  console.log(
    `[opendota] Fetched ${merged.length} Dota2 matches ` +
    `(live: ${live.length}, pro: ${pro.length}, deduped: ${pro.length + live.length - merged.length})`,
  );

  return merged;
}
