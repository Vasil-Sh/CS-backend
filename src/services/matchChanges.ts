// What changed in a match and which source changed it — written by the 2-minute feed refresh and by admin edits,
// read by the admin match sheet («Історія змін»). Buffered: one INSERT every few seconds, not one per field.
import { pool } from '../db/client';

export interface MatchChange { game: string; matchId: string; field: string; oldValue: string | null; newValue: string | null; source: string }

/** Fields worth a line in the history, with how a value is written. */
const FIELDS: Record<string, (m: any) => string | null> = {
  start: (m) => (m.startDate ? new Date(m.startDate).toISOString() : null),
  status: (m) => m.status ?? null,
  score: (m) => (m.score1 == null && m.score2 == null ? null : `${m.score1 ?? '—'}:${m.score2 ?? '—'}`),
  odds: (m) => (m.coeff1 == null || m.coeff2 == null ? null : `${Number(m.coeff1).toFixed(2)} · ${Number(m.coeff2).toFixed(2)}`),
};

/** Which source a feed value comes from: the match id says who gave the schedule; odds are always OddsPapi; Dota scores OpenDota. */
export function sourceOf(game: string, id: string, field: string): string {
  if (field === 'odds') return 'oddspapi';
  if (field === 'score' && game === 'dota2') return 'liquipedia/opendota';
  return String(id).startsWith('op-') ? 'oddspapi' : String(id).startsWith('lp-') ? 'liquipedia' : 'feed';
}

/** The fields of `prev` that `next` changes, as history lines. */
export function diffMatch(game: string, prev: any, next: any, source?: string): MatchChange[] {
  const out: MatchChange[] = [];
  for (const [field, val] of Object.entries(FIELDS)) {
    const a = val(prev), b = val({ ...prev, ...next });
    if (a === b || b === null) continue;
    out.push({ game, matchId: String(prev.id), field, oldValue: a, newValue: b, source: source || sourceOf(game, prev.id, field) });
  }
  return out;
}

let buf: MatchChange[] = [];
let timer: NodeJS.Timeout | null = null;

export function recordChanges(changes: MatchChange[]): void {
  if (!changes.length) return;
  buf.push(...changes);
  if (buf.length > 500) buf = buf.slice(-500);
  timer ||= setTimeout(() => { timer = null; void flushChanges(); }, 3_000);
}

export async function flushChanges(): Promise<void> {
  const rows = buf; buf = [];
  if (!rows.length) return;
  const vals: unknown[] = [];
  const ph = rows.map((r, i) => { vals.push(r.game, r.matchId, r.field, r.oldValue, r.newValue, r.source.slice(0, 40)); const b = i * 6; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`; });
  await pool.query(`INSERT INTO match_changes(game, match_id, field, old_value, new_value, source) VALUES ${ph.join(',')}`, vals)
    .catch((e) => console.warn('[match-changes] insert failed:', (e as Error).message));
}

export async function listChanges(matchId: string, limit = 50): Promise<{ field: string; oldValue: string | null; newValue: string | null; source: string; at: string }[]> {
  const { rows } = await pool.query(
    `SELECT field, old_value, new_value, source, created_at FROM match_changes WHERE match_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [matchId, limit],
  );
  return rows.map((r: any) => ({ field: r.field, oldValue: r.old_value, newValue: r.new_value, source: r.source, at: new Date(r.created_at).toISOString() }));
}
