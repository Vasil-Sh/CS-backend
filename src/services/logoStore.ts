/**
 * Local Logo Store — serves team logos from local directories.
 *
 * CS2:  ../hltv_logos/  (2706 files, {rank}_{Team}.ext format)
 * Dota2: .cache/logos/dota2_local/  (1259 files, {rank}_{Team}.ext format)
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Where the logo packs (cs2_logos.zip, dota2_logos.zip in the backend root) are unpacked on start. */
export const LOGO_CACHE_DIR = join(process.cwd(), '.cache', 'logos');
const firstExisting = (dirs: string[]) => dirs.find((d) => existsSync(d)) || dirs[0];
// CS2: the unpacked pack, or an older ../hltv_logos next to the backend (local dev)
const CS2_DIRS = [join(LOGO_CACHE_DIR, 'hltv_logos'), join(process.cwd(), '..', 'hltv_logos')];
const DOTA2_DIRS = [join(LOGO_CACHE_DIR, 'dota2'), join(LOGO_CACHE_DIR, 'dota2_local')];
let LOCAL_LOGO_DIR = firstExisting(CS2_DIRS);
let DOTA2_LOGO_DIR = firstExisting(DOTA2_DIRS);

/**
 * Unpack the team-logo packs shipped with the backend (pure Node — works on Linux/Railway,
 * the old PowerShell Expand-Archive only ran on Windows). Skips a pack already unpacked.
 */
export async function extractLogoPacks(): Promise<void> {
  const packs = [
    { zip: 'cs2_logos.zip', dir: 'hltv_logos' },
    { zip: 'dota2_logos.zip', dir: 'dota2' },
  ];
  const { default: AdmZip } = await import('adm-zip');
  for (const p of packs) {
    const zipPath = join(process.cwd(), p.zip);
    const target = join(LOGO_CACHE_DIR, p.dir);
    if (!existsSync(zipPath)) { console.log(`[logoStore] ${p.zip} not found — skipping`); continue; }
    try {
      if (existsSync(target) && readdirSync(target).length > 10) { console.log(`[logoStore] ${p.dir}: ${readdirSync(target).length} logos ready`); continue; }
      new AdmZip(zipPath).extractAllTo(LOGO_CACHE_DIR, true);
      console.log(`[logoStore] ${p.zip} unpacked: ${readdirSync(target).length} logos`);
    } catch (err) {
      console.warn(`[logoStore] ${p.zip} unpack failed:`, (err as Error).message);
    }
  }
  LOCAL_LOGO_DIR = firstExisting(CS2_DIRS);
  DOTA2_LOGO_DIR = firstExisting(DOTA2_DIRS);
}

/**
 * Normalize team name for matching:
 * "FaZe Clan" → "fazeclan", "Team Spirit" → "teamspirit"
 */
export function normalizeTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract team name from HLTV ranking filename: "13_FaZe.png" → "faze"
 * Also maps known display names for common teams.
 */
function extractTeamFromFilename(filename: string): string | null {
  // Format: {rank}_{TeamName}.png or {rank}_{Team Name}.png
  const noExt = filename.replace(/\.(png|svg|webp|jpg)$/i, '');
  const underscoreIdx = noExt.indexOf('_');
  if (underscoreIdx === -1) return null;

  const namePart = noExt.substring(underscoreIdx + 1);
  // Common mappings: HLTV ranking names → display names
  const mappings: Record<string, string> = {
    'spirit': 'team spirit',
    'vitality': 'team vitality',
    'faze': 'faze clan',
    'g2': 'g2 esports',
    'liquid': 'team liquid',
    'furia': 'furia esports',
    'mouz': 'mouz',
    'natus_vincere': 'natus vincere',
    'natusvincere': 'natus vincere',
    'themongolz': 'the mongolz',
    'mongolz': 'the mongolz',
    'ninjas_in_pyjamas': 'ninjas in pyjamas',
    'ninjasinpyjamas': 'ninjas in pyjamas',
    'paiN': 'pain gaming',
    'pain': 'pain gaming',
    'heroic': 'heroic',
    'virtuspro': 'virtus.pro',
    'virtus_pro': 'virtus.pro',
    '100_thieves': '100 thieves',
    '100thieves': '100 thieves',
    '3dmax': '3dmax',
    'og': 'og',
    'fnatic': 'fnatic',
    'ence': 'ence',
    'mibr': 'mibr',
    'astralis': 'astralis',
    'faze_clan': 'faze clan',
    'team_spirit': 'team spirit',
    'team_liquid': 'team liquid',
    'team_vitality': 'team vitality',
    'g2_esports': 'g2 esports',
    'los_kogutos': 'los kogutos',
    'ex_rustec': 'ex-rustec',
    'black_phoenix': 'black phoenix',
    'new_vision': 'new vision',
    'just_players': 'just players',
    'fire_flux_esports': 'fire flux esports',
    'sportsbetexpert': 'sportsbet expert',
    'inner_circle_prospect': 'inner circle prospect',
    'havu_gaming': 'havu gaming',
    'bc_game_esports': 'bc.game esports',
    'vitality_academy': 'vitality academy',
    'team_spirit_academy': 'team spirit academy',
    'eac_rising': 'eac rising',
    'ex_eternal_fire_academy': 'ex eternal fire academy',
    'sangal_alters': 'sangal alters',
    'vp_prodigy': 'vp.prodigy',
    'oddik_academy': 'oddik academy',
    'ex_guara': 'ex-guara',
    'meia_noite': 'meia noite',
    'red_feet': 'red feet',
    'marsborne': 'marsborne',
    'fluxo_w7m': 'fluxo w7m',
    'walczaki': 'walczaki',
    'butterfly': 'butterfly',
    'lazer_cats': 'lazer cats',
    'sinqu': 'sinqu',
    'jijiehao': 'jijiehao',
    'inox_division': 'inox division',
    'sinners_esports': 'sinners esports',
    'cybershoke_esports': 'cybershoke esports',
    'aimclub': 'aimclub',
    'sashi_esport': 'sashi esport',
    'rune_eaters': 'rune eaters',
    'young_tigeres': 'young tigeRES',
    'sparta': 'sparta',
    'megoshort': 'megoshort',
    'dark_moon': 'dark moon',
    'arch': 'arch',
    'mtx': 'mtx',
    'mellren': 'mellren',
    'shinden': 'shinden',
    'jumbo_team': 'jumbo team',
    'team_voca': 'team voca',
    'bestia': 'bestia',
    'nrg': 'nrg',
    'alka': 'alka',
    'wraith_pcific': 'wraith pcific',
    'teletubisie': 'teletubisie',
    'passion_academy': 'passion academy',
    '6666': '6666',
    'atputies': 'atputies',
  };

  // Convert underscores to spaces, then lower
  const withSpaces = namePart.replace(/_/g, ' ').toLowerCase().trim();
  if (mappings[withSpaces]) return mappings[withSpaces];
  return withSpaces;
}

export interface LogoStore {
  /** Map: normalized team name → filename on disk */
  byName: Map<string, string>;
  /** Set of all available filenames */
  files: Set<string>;
}

let _store: LogoStore | null = null;

/**
 * Build the local logo store by scanning .cache/logos/local/
 */
export function buildLocalLogoStore(): LogoStore {
  if (_store) return _store;

  const byName = new Map<string, string>();
  const files = new Set<string>();

  try {
    if (!existsSync(LOCAL_LOGO_DIR)) return { byName, files };

    const entries = readdirSync(LOCAL_LOGO_DIR);
    for (const entry of entries) {
      if (!/\.(png|svg|webp|jpg)$/i.test(entry)) continue;
      files.add(entry);

      const teamName = extractTeamFromFilename(entry);
      if (teamName) {
        const norm = normalizeTeamName(teamName);
        if (norm) {
          // Only set if not already present (first match wins)
          if (!byName.has(norm)) {
            byName.set(norm, entry);
          }
        }
      }
    }

    console.log(`[logoStore] Loaded ${byName.size} team logos from ${files.size} files`);
  } catch (err) {
    console.warn('[logoStore] Failed to scan local logos:', (err as Error).message);
  }

  _store = { byName, files };
  return _store;
}

// ═══ Local tips.gg logos (bulk-downloaded) ═══

let _tipsggLocalStore: Map<string, string> | null = null;

/**
 * Build store for local Dota2 logos (.cache/logos/dota2_local/).
 * Files: {rank}_{Team}.ext (e.g., "0001_Team_Spirit.png")
 */
export function buildDota2LocalStore(): Map<string, string> {
  if (_tipsggLocalStore) return _tipsggLocalStore;

  _tipsggLocalStore = new Map();

  try {
    if (!existsSync(DOTA2_LOGO_DIR)) return _tipsggLocalStore;

    const entries = readdirSync(DOTA2_LOGO_DIR);
    for (const entry of entries) {
      if (!/\.(png|svg|webp|jpg)$/i.test(entry)) continue;

      const noExt = entry.replace(/\.(png|svg|webp|jpg)$/i, '');
      const underscoreIdx = noExt.indexOf('_');
      const namePart = underscoreIdx >= 0 ? noExt.substring(underscoreIdx + 1) : noExt;
      const norm = normalizeTeamName(namePart.replace(/_/g, ' '));
      if (!norm) continue;

      if (!_tipsggLocalStore.has(norm)) {
        _tipsggLocalStore.set(norm, entry);
      }
    }

    console.log(`[logoStore] Loaded ${_tipsggLocalStore.size} Dota2 logos`);
  } catch (err) {
    console.warn('[logoStore] Failed to scan Dota2 logos:', (err as Error).message);
  }

  return _tipsggLocalStore;
}

/**
 * Look up a team logo from the local Dota2 store.
 * Returns filename (e.g., "0005_Tundra.png") or null.
 */
export function lookupDota2LocalLogo(teamName: string): string | null {
  const store = buildDota2LocalStore();
  if (store.size === 0) return null;

  const norm = normalizeTeamName(teamName);
  if (!norm) return null;
  if (store.has(norm)) return store.get(norm)!;

  // Fuzzy substring
  for (const [key, path] of store) {
    if (key.length < 2) continue;
    if (norm.includes(key) || key.includes(norm)) return path;
  }

  return null;
}

/**
 * Get the directory for serving Dota2 local logos.
 */
export function getDota2LogoDir(): string {
  return DOTA2_LOGO_DIR;
}

/**
 * Look up a team logo filename from the local store.
 * Returns filename or null.
 */
export function lookupLocalLogo(teamName: string): string | null {
  const store = buildLocalLogoStore();
  if (store.byName.size === 0) return null;

  // 1. Normalized exact match (common short names first: «Navi» is Natus Vincere, not Na`Vi Junior)
  const raw = normalizeTeamName(teamName);
  if (!raw) return null;
  const norm = SHORT_NAMES[raw] || raw;
  if (store.byName.has(norm)) return store.byName.get(norm)!;

  // 2. Exact filename match (just in case)
  const asFile = `${norm}.png`;
  if (store.files.has(asFile)) return asFile;

  // 3. Fuzzy substring match — many files have short names (e.g. "SINNERS")
  //    but the display name includes suffixes ("SINNERS Esports").
  //    Check if stored key is contained in the lookup name, or vice versa.
  //    Guard: skip keys shorter than 2 chars — non-ASCII team names (e.g. "Þór")
  //    normalize down to a single letter and would otherwise match every name
  //    containing that letter (Royal Foxes, CTRL, …).
  //    Several can match ("navi" ⊂ "navijunior", …): take the best-ranked file (lowest numeric prefix).
  let best: string | null = null;
  let bestRank = Infinity;
  for (const [key, filename] of store.byName) {
    if (key.length < 2) continue;
    if (norm.includes(key) || key.includes(norm)) {
      const rank = parseInt(filename, 10);
      const r = Number.isFinite(rank) ? rank : 99999;
      if (r < bestRank) { best = filename; bestRank = r; }
    }
  }

  return best;
}

/** Short / common spellings → the name the logo pack uses (normalized). */
const SHORT_NAMES: Record<string, string> = {
  navi: 'natusvincere',
  natusvincere: 'natusvincere',
  vp: 'virtuspro',
  nip: 'ninjasinpyjamas',
  col: 'complexity',
  eg: 'evilgeniuses',
};

/**
 * Look up a team's HLTV world ranking position from the local logo store.
 * Local logo filenames encode the rank as a numeric prefix ("009_G2.png" → 9).
 * Returns null if the team has no local logo (no-name / outside top ranking).
 */
export function lookupLocalLogoRank(teamName: string): number | null {
  const filename = lookupLocalLogo(teamName);
  if (!filename) return null;
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  const rank = parseInt(match[1], 10);
  return Number.isFinite(rank) ? rank : null;
}

/**
 * Look up a team's Dota 2 ranking position from the local Dota2 logo store.
 * Filenames are "{rank}_{Team}.ext" ("0001_Team_Spirit.png" → 1).
 */
export function lookupDota2LocalLogoRank(teamName: string): number | null {
  const filename = lookupDota2LocalLogo(teamName);
  if (!filename) return null;
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  const rank = parseInt(match[1], 10);
  return Number.isFinite(rank) ? rank : null;
}

// ═══ tips.gg CDN team logo map — scraped from /csgo/teams/ and /dota2/teams/ ═══

interface TipsggTeamEntry {
  name: string;
  game: string;
  cdnUrl: string;
}

let _tipsggMap: Map<string, string> | null = null;
let _tipsggLoaded = false;

/**
 * Eagerly load tips.gg team logo map (called at startup).
 */
export function loadTipsggLogos(): void {
  loadTipsggLogoMap();
}

const TIPSGG_LOGOS_FILE = join(process.cwd(), '.cache', 'tipsgg_team_logos.json');

/**
 * Load the tips.gg team logo map (name → CDN URL) from scraped JSON.
 * Called lazily on first lookup. Returns null if file not found.
 */
function loadTipsggLogoMap(): Map<string, string> | null {
  if (_tipsggLoaded) return _tipsggMap;
  _tipsggLoaded = true;

  try {
    if (!existsSync(TIPSGG_LOGOS_FILE)) {
      console.log('[logoStore] tipsgg_team_logos.json not found — run scripts/scrape-team-logos.ts');
      return null;
    }

    const raw = readFileSync(TIPSGG_LOGOS_FILE, 'utf-8');
    const data = JSON.parse(raw) as Record<string, TipsggTeamEntry[]>;

    _tipsggMap = new Map();
    for (const entries of Object.values(data)) {
      for (const entry of entries) {
        if (!entry.name || !entry.cdnUrl) continue;
        // Skip malformed entries (e.g. "Marsborne –  Team")
        if (entry.name.includes('–') && entry.name.length < 5) continue;
        const norm = normalizeTeamName(entry.name);
        if (norm && !_tipsggMap.has(norm)) {
          _tipsggMap.set(norm, entry.cdnUrl);
        }
        // Also index by game for disambiguation: "cs2:teamspirit" → CS2 logo
        const gameKey = `${entry.game}:${norm}`;
        if (!_tipsggMap.has(gameKey)) {
          _tipsggMap.set(gameKey, entry.cdnUrl);
        }
      }
    }

    console.log(`[logoStore] Loaded ${_tipsggMap.size} tips.gg CDN logo mappings`);
    return _tipsggMap;
  } catch (err) {
    console.warn('[logoStore] Failed to load tips.gg logos:', (err as Error).message);
    return null;
  }
}

/**
 * Look up a team logo CDN URL from the tips.gg team pages.
 * Falls back to generic slug-based URL if exact match not found.
 *
 * @param teamName  Display name, e.g. "Team Spirit"
 * @param game      "cs2" | "dota2" — for disambiguation
 * @returns CDN URL or null
 */
export function lookupTipsggLogo(teamName: string, game: string): string | null {
  const map = loadTipsggLogoMap();
  if (!map) return null;

  const norm = normalizeTeamName(teamName);

  // 1. Game-prefixed lookup (most accurate)
  const gameKey = `${game}:${norm}`;
  if (map.has(gameKey)) return map.get(gameKey)!;

  // 2. Generic name lookup
  if (map.has(norm)) return map.get(norm)!;

  // 3. Fuzzy substring match
  for (const [key, url] of map) {
    // Skip game-prefixed keys for fuzzy (they have the ':' separator)
    if (key.includes(':')) continue;
    // Skip 1-char keys — they match every name containing that letter.
    if (key.length < 2) continue;
    if (norm.includes(key) || key.includes(norm)) return url;
  }

  return null;
}

/**
 * Get the local logo directory for serving static files.
 */
export function getLocalLogoDir(): string {
  return LOCAL_LOGO_DIR;
}

// ═══ Team catalog (every team in the logo packs) ═══

export interface CatalogTeam { game: 'cs2' | 'dota2'; name: string; rank: number | null; logo: string }
let _catalog: CatalogTeam[] | null = null;

/** Split "0037_T1.png" → { rank: 37, name: "T1" }; underscores become spaces. */
export function parseLogoFile(file: string): { rank: number | null; name: string } | null {
  if (!/\.(png|svg|webp|jpg)$/i.test(file)) return null;
  const noExt = file.replace(/\.(png|svg|webp|jpg)$/i, '');
  const m = noExt.match(/^(\d+)_(.+)$/);
  const name = (m ? m[2] : noExt).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return { rank: m ? parseInt(m[1], 10) : null, name };
}

/**
 * Every team from both logo packs, one entry per team (the best-ranked file wins when
 * the pack has the same team twice). Cached once the packs are unpacked.
 */
export function logoCatalog(): CatalogTeam[] {
  if (_catalog) return _catalog;
  const out: CatalogTeam[] = [];
  const scan = (dir: string, game: 'cs2' | 'dota2', route: string) => {
    if (!existsSync(dir)) return 0;
    const best = new Map<string, CatalogTeam>();
    for (const file of readdirSync(dir)) {
      const p = parseLogoFile(file);
      if (!p) continue;
      const key = normalizeTeamName(p.name) || p.name.toLowerCase();
      const prev = best.get(key);
      if (prev && (prev.rank ?? Infinity) <= (p.rank ?? Infinity)) continue;
      best.set(key, { game, name: p.name, rank: p.rank, logo: `/api/v1/${game}-matches/logo/${route}/${encodeURIComponent(file)}` });
    }
    out.push(...best.values());
    return best.size;
  };
  const cs = scan(LOCAL_LOGO_DIR, 'cs2', 'local');
  const dota = scan(DOTA2_LOGO_DIR, 'dota2', 'dota2local');
  out.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));
  if (cs + dota > 0) _catalog = out; // packs may still be unpacking — retry next time
  return out;
}
