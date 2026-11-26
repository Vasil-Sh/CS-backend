/** Team names written short: «NAVI» for «Natus Vincere», «NIP» for «Ninjas in Pyjamas». Pure — used by the feed and the Telegram reader. */
export const tokens = (v: string) => v.toLowerCase().replace(/\b(e-?sports?|club|clan|team|gaming)\b/g, ' ').split(/[^a-z0-9а-яіїєґё]+/).filter(Boolean);
/** «NAVI Junior» is short for «Natus Vincere Junior», «NIP» for «Ninjas in Pyjamas»: every short word is the first letters
 *  of the next long words in order (na+vi), all long words used. One short word of ≥3 letters at least; no guessing beyond that. */
export function shortFor(short: string, long: string): boolean {
  const s = tokens(short), l = tokens(long);
  if (!s.length || l.length <= s.length || !s.some((w) => w.length >= 3)) return false;
  const go = (i: number, j: number): boolean => {
    if (i === s.length) return j === l.length;
    const w = s[i];
    // w = prefixes of l[j..k] glued together
    const fit = (pos: number, k: number): boolean => {
      if (pos === w.length) return go(i + 1, k);
      if (k >= l.length) return false;
      for (let n = Math.min(l[k].length, w.length - pos); n >= 1; n--) if (l[k].startsWith(w.slice(pos, pos + n)) && fit(pos + n, k + 1)) return true;
      return false;
    };
    return w === l[j] ? go(i + 1, j + 1) : fit(0, j);
  };
  return go(0, 0);
}

/** Short forms of a long team name worth looking for in a post: «Natus Vincere» → navi, nv; «Ninjas in Pyjamas» → nip. Only names of 2+ words. */
export function abbreviations(name: string): string[] {
  const w = tokens(name);
  if (w.length < 2) return [];
  const out = new Set<string>([w.map((x) => x[0]).join(''), w.map((x) => x.slice(0, 2)).join('')]);
  return [...out].filter((x) => x.length >= 3);
}
