/**
 * Telegram channel / group avatar by @username, for ad placements and the admin.
 * The public preview page t.me/<name> carries the photo in <meta property="og:image">;
 * we read it, download the picture once and keep it (memory + disk) for a day.
 * No photo, a private chat or an unknown name → null (callers show initials).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const DIR = join(process.cwd(), '.cache', 'tg-avatars');
const TTL_MS = 24 * 3600_000;
const MISS_TTL_MS = 3600_000;
const MAX_BYTES = 1_500_000;
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<{ body: Buffer; type: string } | null>>();

export const cleanHandle = (h: string) => String(h || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
export const validHandle = (h: string) => /^[A-Za-z0-9_]{4,64}$/.test(h);

/** og:image from the t.me page; the generic Telegram logo means «no photo». */
export function ogImageOf(html: string): string | null {
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, '&');
  if (!/^https:\/\//i.test(url) || /telegram\.org\/img\/t_logo/i.test(url)) return null;
  return url;
}

async function fetchFresh(handle: string): Promise<{ body: Buffer; type: string } | null> {
  const page = await fetch(`https://t.me/${handle}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MatchIQ/1.0)', 'accept-language': 'en' }, signal: AbortSignal.timeout(8000) });
  if (!page.ok) return null;
  const img = ogImageOf(await page.text());
  if (!img) return null;
  const res = await fetch(img, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length || body.length > MAX_BYTES) return null;
  return { body, type };
}

export async function telegramAvatar(raw: string): Promise<{ body: Buffer; type: string } | null> {
  const handle = cleanHandle(raw).toLowerCase();
  if (!validHandle(handle)) return null;
  const file = join(DIR, `${handle}.img`), meta = join(DIR, `${handle}.type`);
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TTL_MS) return { body: readFileSync(file), type: readFileSync(meta, 'utf8') || 'image/jpeg' };
  } catch { /* fall through to a fresh fetch */ }
  const missAt = misses.get(handle);
  if (missAt && Date.now() - missAt < MISS_TTL_MS) return null;
  let p = inflight.get(handle);
  if (!p) {
    p = fetchFresh(handle).catch((e) => { console.warn(`[tg-avatar] ${handle}:`, (e as Error).message); return null; });
    inflight.set(handle, p);
  }
  const got = await p.finally(() => inflight.delete(handle));
  if (!got) { misses.set(handle, Date.now()); return null; }
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(file, got.body); writeFileSync(meta, got.type); } catch { /* memory only */ }
  misses.delete(handle);
  return got;
}
