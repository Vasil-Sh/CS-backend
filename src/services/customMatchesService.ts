/**
 * Custom Matches Service — stores user-submitted match lists as placeholder
 * matches that get merged into the CS2 match feed and auto-enriched when
 * their start time arrives.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TipsGgMatch } from './tipsggScraper';

const CACHE_DIR = join(process.cwd(), '.cache');
const CUSTOM_FILE = join(CACHE_DIR, 'cs2_custom_matches.json');

interface CustomCacheEntry {
  data: TipsGgMatch[];
  updatedAt: string;
}

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/** Read custom matches from disk */
export function getCustomMatches(): TipsGgMatch[] {
  try {
    if (!existsSync(CUSTOM_FILE)) return [];
    const raw = readFileSync(CUSTOM_FILE, 'utf-8');
    const entry: CustomCacheEntry = JSON.parse(raw);
    return entry.data || [];
  } catch {
    return [];
  }
}

/** Save custom matches to disk */
export function saveCustomMatches(matches: TipsGgMatch[]): void {
  ensureDir();
  const entry: CustomCacheEntry = {
    data: matches,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(CUSTOM_FILE, JSON.stringify(entry, null, 2), 'utf-8');
}

/** Clear all custom matches */
export function clearCustomMatches(): void {
  saveCustomMatches([]);
}

/**
 * Generate a stable slug for a match: team1-vs-team2 (lowercase, normalized).
 */
function makeSlug(team1: string, team2: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${norm(team1)}-vs-${norm(team2)}`;
}

/**
 * Parse a raw text match list.
 *
 * Expected format (one match per line):
 *   TournamentNameHH:MMbo3Team1Team2[odds1][odds2]
 *
 * Example:
 *   Esports World Cup 2026 Open Qualifier12:00bo3K27SAW1.293.15
 *   Esports World Cup 2026 Open Qualifier12:00bo3HEROICASTRAL
 *
 * Also supports date headers:
 *   Sunday - 2026-08-09
 *
 * And placeholder rounds:
 *   Esports World Cup 2026 Open Qualifier15:00bo3Esports World Cup 2026 Open Qualifier - Round of 16 #1
 */
export function parseMatchText(text: string, defaultDate: string): TipsGgMatch[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const matches: TipsGgMatch[] = [];
  let currentDate = defaultDate;

  // Date header pattern: "Sunday - 2026-08-09" or "Monday - 2026-08-10"
  const dateHeaderRe = /^[A-Z][a-z]+day\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/i;

  for (const line of lines) {
    // Check for date header
    const dateMatch = line.match(dateHeaderRe);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }

    // Try to parse match line
    const parsed = parseMatchLine(line, currentDate);
    if (parsed) {
      matches.push(parsed);
    }
  }

  return matches;
}

/**
 * Parse a single match line.
 * Format: TournamentNameHH:MMboXTeam1Team2[odds1][odds2]
 */
function parseMatchLine(line: string, date: string): TipsGgMatch | null {
  // Step 1: Extract time + format
  // Pattern: digits:digits followed by bo1/bo2/bo3/bo5
  const timeFormatRe = /^(.+?)(\d{1,2}:\d{2})(bo[1235])(.+)$/i;
  const m = line.match(timeFormatRe);
  if (!m) return null;

  const tournament = m[1].trim();
  const time = m[2];
  const format = m[3].toUpperCase();
  let rest = m[4].trim();

  // Step 2: Extract odds from the end (two decimal numbers)
  // e.g., "...1.293.15" → odds1=1.29, odds2=3.15
  let coeff1: number | null = null;
  let coeff2: number | null = null;

  const oddsRe = /(\d+\.\d{1,3})\s*(\d+\.\d{1,3})$/;
  const oddsMatch = rest.match(oddsRe);
  if (oddsMatch) {
    coeff1 = parseFloat(oddsMatch[1]);
    coeff2 = parseFloat(oddsMatch[2]);
    rest = rest.slice(0, oddsMatch.index).trim();
  }

  // Step 3: The remainder is Team1 + Team2.
  // If the remainder is empty or is clearly a placeholder (contains "#", "Round of", "Winner"),
  // treat the entire original line as a placeholder.
  let team1 = '';
  let team2 = '';
  let isPlaceholder = false;

  if (!rest || /#\d|round\s*(of|of)\s*\d|winner|tbd|tba/i.test(rest)) {
    isPlaceholder = true;
    // For placeholders like "Esports World Cup 2026 Open Qualifier - Round of 16 #1"
    // The entire line after the format is the placeholder description
    team1 = 'TBD';
    team2 = rest || 'TBD';
  } else {
    // Try to split Team1Team2
    const split = splitTeamNames(rest);
    team1 = split.team1;
    team2 = split.team2;
  }

  if (!team1 || !team2) return null;

  const link = `https://tips.gg/csgo/match/${makeSlug(team1, team2)}/`;
  const startDate = `${date}T${time}:00`;

  const match: TipsGgMatch = {
    id: `custom:${makeSlug(team1, team2)}`,
    date,
    link,
    type: format,
    score1: null,
    score2: null,
    nameTeam1: team1,
    nameTeam2: team2,
    logoTeam1: null,
    logoTeam2: null,
    tournament,
    stage: '',
    status: 'upcoming',
    tipsCount: 0,
    performer: null,
    startDate,
    pred1: coeff1 ? Math.round((1 / coeff1) * 100) : 50,
    pred2: coeff2 ? Math.round((1 / coeff2) * 100) : 50,
    coeff1,
    coeff2,
  };

  return match;
}

/**
 * Smart split of concatenated team names like "K27SAW" → "K27", "SAW"
 * or "SINNERSEYEBALLERS" → "SINNERS", "EYEBALLERS".
 *
 * Strategy: try common separators and casing patterns.
 */
function splitTeamNames(raw: string): { team1: string; team2: string } {
  // Known team names for matching (longest first to avoid partial matches)
  const knownTeams = [
    '100 Thieves', '9INE', 'Acend', 'ASTRA', 'ASTRAL', 'BC.Game', 'Betclic',
    'BIG', 'Cloud9', 'DENDELE', 'EchoGen', 'Eternal Fire', 'EYEBALLERS',
    'FaZe', 'Fluxo', 'Fnatic', 'FOKUS', 'G2', 'GenOne', 'HEROIC',
    'HOTU', 'Iberian Soul', 'INFINITE', 'Inner Circle', 'JiJieHao',
    'K27', 'Liquid', 'MOUZ', 'NAVI', 'Nexus', 'NRG', 'OG',
    'Phantom', 'Prestige', 'Sashi', 'SAW', 'SINNERS', 'Spirit',
    'UNiTY', 'Virtus.pro', 'VP', 'Vitality', '1win', 'Team Liquid',
    'Team Spirit', 'Team Vitality',
  ];

  // Sort by length descending for greedy matching
  const sorted = [...knownTeams].sort((a, b) => b.length - a.length);

  // Try greedy split: find two known team names that exactly cover the string
  const lower = raw.toLowerCase();
  for (const t1 of sorted) {
    const lt1 = t1.toLowerCase();
    if (!lower.startsWith(lt1)) continue;
    const remaining = lower.slice(lt1.length);
    for (const t2 of sorted) {
      if (t2 === t1) continue;
      if (remaining === t2.toLowerCase()) {
        return { team1: t1, team2: t2 };
      }
    }
  }

  // Fallback: try casing-based split (uppercase letter starts new team)
  // "K27SAW" → ["K27", "SAW"]
  // Look for patterns like: [digits][uppercase] or [lowercase][uppercase]
  const casingSplit = splitByCasing(raw);
  if (casingSplit && casingSplit.team1 && casingSplit.team2) {
    return casingSplit;
  }

  // Last resort: split in half
  const mid = Math.floor(raw.length / 2);
  // Try to split at a word boundary (uppercase letter)
  for (let i = mid; i < raw.length; i++) {
    if (raw[i] === raw[i].toUpperCase() && raw[i] !== raw[i].toLowerCase()) {
      return { team1: raw.slice(0, i), team2: raw.slice(i) };
    }
  }

  return { team1: raw.slice(0, mid), team2: raw.slice(mid) };
}

/**
 * Split by camelCase / PascalCase transitions.
 * "K27SAW" → { team1: "K27", team2: "SAW" }
 * "SINNERSEYEBALLERS" is ambiguous — needs known team list.
 */
function splitByCasing(raw: string): { team1: string; team2: string } | null {
  // Find transition points: lowercase/digit → uppercase, digit → letter
  const transitions: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1];
    const curr = raw[i];
    // lowercase → uppercase (camelCase)
    if (prev !== prev.toUpperCase() && curr === curr.toUpperCase() && curr !== curr.toLowerCase()) {
      transitions.push(i);
    }
    // digit → uppercase letter
    else if (/[0-9]/.test(prev) && curr === curr.toUpperCase() && curr !== curr.toLowerCase()) {
      transitions.push(i);
    }
    // uppercase → uppercase followed by lowercase (e.g., "SAWnatic")
    else if (
      i > 1 &&
      raw[i - 2] === raw[i - 2].toUpperCase() &&
      prev === prev.toUpperCase() &&
      prev !== prev.toLowerCase() &&
      curr === curr.toLowerCase()
    ) {
      transitions.push(i - 1);
    }
  }

  // Use the middle transition point
  if (transitions.length === 0) return null;

  // Find the transition closest to the middle
  const mid = Math.floor(raw.length / 2);
  let best = transitions[0];
  let bestDist = Math.abs(best - mid);
  for (const t of transitions) {
    const dist = Math.abs(t - mid);
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }

  const team1 = raw.slice(0, best);
  const team2 = raw.slice(best);

  if (team1.length < 2 || team2.length < 2) return null;

  return { team1, team2 };
}
