/**
 * Local Logo Store — serves team logos from a local directory.
 *
 * Expects logos in: .cache/logos/local/*.png
 * File naming: {rank}_{TeamName}.png (e.g., "13_FaZe.png", "3_Spirit.png")
 *
 * Builds a normalized-name → filename map for fast lookups.
 * If no local logos exist, falls back gracefully (no error).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const LOCAL_LOGO_DIR = join(process.cwd(), '.cache', 'logos', 'local');

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

/**
 * Look up a team logo filename from the local store.
 * Returns filename or null.
 */
export function lookupLocalLogo(teamName: string): string | null {
  const store = buildLocalLogoStore();
  if (store.byName.size === 0) return null;

  // 1. Normalized match
  const norm = normalizeTeamName(teamName);
  if (store.byName.has(norm)) return store.byName.get(norm)!;

  // 2. Exact filename match (just in case)
  const asFile = `${norm}.png`;
  if (store.files.has(asFile)) return asFile;

  return null;
}

/**
 * Get the local logo directory for serving static files.
 */
export function getLocalLogoDir(): string {
  return LOCAL_LOGO_DIR;
}
