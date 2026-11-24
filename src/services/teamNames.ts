/** Team names the other sources (Liquipedia, Cito, OddsPapi) used in the last feed build, per game —
 *  so PandaScore learns only the aliases that actually join two sources' spellings. */
import { normalizeTeam } from '../utils/matchUtils';

const key = (v: string) => normalizeTeam(v.replace(/\b(e-?sports?|club|clan)\b/gi, ' '));
const seen: Record<'cs2' | 'dota2', Set<string>> = { cs2: new Set(), dota2: new Set() };

export function noteTeamNames(game: 'cs2' | 'dota2', names: string[]): void {
  const s = new Set<string>();
  for (const n of names) { const k = key(n); if (k) s.add(k); }
  if (s.size) seen[game] = s;
}

export const seenElsewhere = (game: 'cs2' | 'dota2', name: string) => seen[game].has(key(name));
export const seenCount = (game: 'cs2' | 'dota2') => seen[game].size;
