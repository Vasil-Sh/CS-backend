/**
 * Durable copies of disk caches. Railway's disk is wiped on every deploy, so after a deploy the backend
 * used to rebuild these from the sources (extra requests, empty lists for a while). Now:
 *  - on start, files missing on disk (or older than the copy) are written back from Postgres;
 *  - every few minutes and on shutdown, files changed since the last copy are saved.
 * Paths are relative to .cache/; a trailing «/» tracks every file in that folder (one level).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pool } from '../db/client';

const ROOT = join(process.cwd(), '.cache');
export const TRACKED = ['cs2_matches.json', 'dota2_matches.json', 'hltv_logos.json', 'logos/tournaments/'];
const MAX_FILE = 4 * 1024 * 1024;
const SYNC_MS = 5 * 60_000;
const saved = new Map<string, number>(); // name → mtime of the copy in Postgres

/** The files we keep, as names relative to .cache/ */
export function trackedFiles(root = ROOT, tracked = TRACKED): string[] {
  const out: string[] = [];
  for (const t of tracked) {
    if (!t.endsWith('/')) { if (existsSync(join(root, t))) out.push(t); continue; }
    const dir = join(root, t);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) { try { if (statSync(join(dir, f)).isFile()) out.push(t + f); } catch { /* gone */ } }
  }
  return out;
}

/** Is a name one we track (and safe — no «..»)? */
export function isTracked(name: string, tracked = TRACKED): boolean {
  if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) return false;
  return tracked.some((t) => (t.endsWith('/') ? name.startsWith(t) && !name.slice(t.length).includes('/') : name === t));
}

export async function restoreDurableFiles(): Promise<void> {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query<{ name: string; data: Buffer; mtime_ms: string }>('SELECT name, data, mtime_ms FROM durable_files');
    let n = 0;
    for (const r of rows) {
      if (!isTracked(r.name)) continue;
      const path = join(ROOT, r.name), mt = Number(r.mtime_ms);
      saved.set(r.name, mt);
      let local = 0;
      try { local = statSync(path).mtimeMs; } catch { /* missing */ }
      if (local >= mt) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, r.data);
      utimesSync(path, new Date(mt), new Date(mt));
      n++;
    }
    console.log(`[durable] ${n} cache files restored from db (${rows.length} saved) in ${Date.now() - t0} ms`);
  } catch (e) {
    console.warn('[durable] restore failed:', (e as Error).message);
  }
}

let syncing = false;
export async function syncDurableFiles(): Promise<number> {
  if (syncing) return 0;
  syncing = true;
  let n = 0;
  try {
    for (const name of trackedFiles()) {
      const path = join(ROOT, name);
      let st; try { st = statSync(path); } catch { continue; }
      const mt = Math.floor(st.mtimeMs);
      if (st.size > MAX_FILE || saved.get(name) === mt) continue;
      await pool.query(
        `INSERT INTO durable_files(name, data, mtime_ms, updated_at) VALUES($1,$2,$3,now())
         ON CONFLICT(name) DO UPDATE SET data = EXCLUDED.data, mtime_ms = EXCLUDED.mtime_ms, updated_at = now()`,
        [name, readFileSync(path), mt],
      );
      saved.set(name, mt);
      n++;
    }
  } catch (e) {
    console.warn('[durable] save failed:', (e as Error).message);
  } finally { syncing = false; }
  return n;
}

export function startDurableSync(): void {
  const t = setInterval(() => { void syncDurableFiles(); }, SYNC_MS);
  t.unref?.();
}
