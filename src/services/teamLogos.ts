/**
 * Team logos uploaded by an admin («Команди → Змінити логотип»).
 * They win over the logo packs and the feeds. The index (which spellings have one, and a version
 * for cache busting) is kept in memory so the logo URL can be built synchronously in the feed;
 * the image bytes are read from Postgres on request and cached.
 */
import { pool } from '../db/client';

export type LogoGame = 'cs2' | 'dota2';
export const normalizeLogoName = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const MAX_BYTES = 300 * 1024;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** game → norm → version (ms of the last change) */
const index: Record<LogoGame, Map<string, number>> = { cs2: new Map(), dota2: new Map() };
const bytes = new Map<string, { mime: string; data: Buffer }>();
let loaded = false;

export async function hydrateTeamLogos(): Promise<void> {
  try {
    const { rows } = await pool.query('SELECT game, norm, updated_at FROM team_logos');
    index.cs2.clear(); index.dota2.clear();
    for (const r of rows) if (r.game === 'cs2' || r.game === 'dota2') index[r.game as LogoGame].set(r.norm, new Date(r.updated_at).getTime());
    loaded = true;
    if (rows.length) console.log(`[teamLogos] ${rows.length} custom logos`);
  } catch (err) {
    console.warn('[teamLogos] load failed:', (err as Error).message);
  }
}
export const teamLogosLoaded = () => loaded;

/** URL of the admin's logo for this team, or null. `prefix` is the feed router: cs2 | dota2. */
export function customLogoUrl(teamName: string, prefix: string): string | null {
  const game: LogoGame = prefix.startsWith('dota') ? 'dota2' : 'cs2';
  const norm = normalizeLogoName(teamName);
  const v = norm ? index[game].get(norm) : undefined;
  return v ? `/api/v1/${game}-matches/logo/custom/${norm}?v=${v}` : null;
}

export async function readCustomLogo(game: LogoGame, norm: string): Promise<{ mime: string; data: Buffer } | null> {
  const k = `${game}:${norm}`;
  const hit = bytes.get(k);
  if (hit) return hit;
  const { rows } = await pool.query('SELECT mime, data FROM team_logos WHERE game = $1 AND norm = $2', [game, norm]);
  if (!rows[0]) return null;
  const v = { mime: rows[0].mime as string, data: rows[0].data as Buffer };
  if (bytes.size > 500) bytes.clear();
  bytes.set(k, v);
  return v;
}

/** Parse a data: URL from the admin (already resized there). */
export function parseLogoDataUrl(dataUrl: string): { mime: string; data: Buffer } {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || !MIMES.has(m[1])) throw new Error('Потрібне зображення PNG, JPEG або WebP');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw new Error('Порожній файл');
  if (data.length > MAX_BYTES) throw new Error('Файл завеликий — до 300 КБ');
  return { mime: m[1], data };
}

/** Save one logo for every spelling of the team (name, aliases, spellings from the feeds). */
export async function saveTeamLogo(input: { game: string; names: string[]; dataUrl: string; by: string }): Promise<{ game: LogoGame; names: string[]; url: string }> {
  const game: LogoGame | null = input.game === 'cs2' || input.game === 'dota2' ? input.game : null;
  if (!game) throw new Error('Невідома гра');
  const names = [...new Map(input.names.map((n) => String(n || '').trim().slice(0, 200)).filter(Boolean).map((n) => [normalizeLogoName(n), n] as const)).entries()].filter(([k]) => k);
  if (!names.length) throw new Error('Назва команди обов’язкова');
  const { mime, data } = parseLogoDataUrl(input.dataUrl);
  const now = new Date();
  for (const [norm, name] of names.slice(0, 20)) {
    await pool.query(
      `INSERT INTO team_logos(game, norm, name, mime, data, updated_by, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (game, norm) DO UPDATE SET name = EXCLUDED.name, mime = EXCLUDED.mime, data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [game, norm, name, mime, data, String(input.by || '').slice(0, 100), now],
    );
    index[game].set(norm, now.getTime());
    bytes.set(`${game}:${norm}`, { mime, data });
  }
  return { game, names: names.map(([, n]) => n), url: customLogoUrl(names[0][1], game)! };
}

export async function deleteTeamLogo(game: string, names: string[]): Promise<number> {
  if (game !== 'cs2' && game !== 'dota2') return 0;
  const norms = [...new Set(names.map(normalizeLogoName).filter(Boolean))];
  if (!norms.length) return 0;
  const { rowCount } = await pool.query('DELETE FROM team_logos WHERE game = $1 AND norm = ANY($2)', [game, norms]);
  for (const n of norms) { index[game].delete(n); bytes.delete(`${game}:${n}`); }
  return rowCount ?? 0;
}

export function listTeamLogos(): { game: LogoGame; norm: string; url: string }[] {
  return (['cs2', 'dota2'] as LogoGame[]).flatMap((g) => [...index[g].entries()].map(([norm, v]) => ({ game: g, norm, url: `/api/v1/${g}-matches/logo/custom/${norm}?v=${v}` })));
}
