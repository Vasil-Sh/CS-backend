/**
 * «Матчі за 7 днів» on the admin dashboard: what the feed collected, how many finished without a score,
 * how many had odds, and how long a score took to appear after the match finished (from «Історія змін»).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/client';

const last = new Map<string, string>(); // id → state already written (skip unchanged rows)

/** Upsert the feed's matches of the last `days` days (only rows whose state changed since the last write). */
export function trackFeed(game: 'cs2' | 'dota2', matches: any[], days = 2): Promise<void> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = matches.filter((m) => m?.id && m.date >= since).map((m) => ({
    id: String(m.id), date: String(m.date).slice(0, 10), status: String(m.status || 'upcoming'),
    score: m.score1 != null && m.score2 != null && m.score1 + m.score2 > 0, odds: m.coeff1 != null && m.coeff2 != null,
  })).filter((r) => last.get(r.id) !== `${r.status}|${r.score}|${r.odds}`);
  if (!rows.length) return Promise.resolve();
  const vals: unknown[] = [];
  const ph = rows.map((r, i) => { vals.push(r.id, game, r.date, r.status, r.score, r.odds); const b = i * 6; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`; });
  return pool.query(
    `INSERT INTO feed_matches(id, game, date, status, has_score, has_odds) VALUES ${ph.join(',')}
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, has_score = feed_matches.has_score OR EXCLUDED.has_score,
       has_odds = feed_matches.has_odds OR EXCLUDED.has_odds, date = EXCLUDED.date, updated_at = now()`, vals,
  ).then(() => rows.forEach((r) => last.set(r.id, `${r.status}|${r.score}|${r.odds}`)))
    .then(() => {}, (e) => console.warn('[feed-stats] save failed:', (e as Error).message));
}

/** The feed's own cache files: everything the app is showing right now (also when the 2-minute refresh sleeps). */
async function trackCaches(): Promise<void> {
  for (const game of ['cs2', 'dota2'] as const) {
    const f = join(process.cwd(), '.cache', `${game}_matches.json`);
    if (!existsSync(f)) continue;
    try { await trackFeed(game, JSON.parse(readFileSync(f, 'utf-8')).data || [], 7); } catch { /* unreadable cache */ }
  }
}

export interface WeekReport {
  from: string; to: string;
  /** First day the feed was tracked (the report is partial before a full week has passed). */
  since: string | null;
  total: number; cs2: number; dota2: number;
  finished: number; noScore: number; withOdds: number;
  /** Minutes from «finished» to the score, over matches whose score came later; null when none did. */
  scoreDelayMin: number | null; lateScores: number;
  days: { day: string; total: number; noScore: number; withOdds: number }[];
}

export async function weekReport(): Promise<WeekReport> {
  // the 2-minute refresh writes only while the app has visitors — take what the caches hold now as well
  await trackCaches();
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }));
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS day, game, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE status = 'finished')::int AS fin,
            COUNT(*) FILTER (WHERE status = 'finished' AND NOT has_score)::int AS noscore,
            COUNT(*) FILTER (WHERE has_odds)::int AS odds
     FROM feed_matches WHERE date >= $1::date AND date <= $2::date GROUP BY 1, 2`, [days[0], days[6]],
  );
  // score delay: a match marked finished without a score whose score arrived later (both lines in «Історія змін»)
  const delay = await pool.query(
    `WITH f AS (SELECT match_id, MIN(created_at) AS at FROM match_changes WHERE field = 'status' AND new_value = 'finished' AND created_at > now() - INTERVAL '7 days' GROUP BY 1),
          s AS (SELECT c.match_id, MIN(c.created_at) AS at FROM match_changes c JOIN f ON f.match_id = c.match_id
                WHERE c.field = 'score' AND c.created_at > f.at + INTERVAL '1 minute' GROUP BY 1)
     SELECT COUNT(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.at - f.at)) / 60) AS med
     FROM s JOIN f USING (match_id)`,
  ).catch(() => ({ rows: [{ n: 0, med: null }] }));
  const first = await pool.query(`SELECT to_char(MIN(first_seen) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS d FROM feed_matches`).catch(() => ({ rows: [{ d: null }] }));
  const sum = (k: string, game?: string) => rows.filter((r: any) => !game || r.game === game).reduce((a: number, r: any) => a + Number(r[k]), 0);
  return {
    from: days[0], to: days[6],
    since: first.rows[0]?.d || null,
    total: sum('n'), cs2: sum('n', 'cs2'), dota2: sum('n', 'dota2'),
    finished: sum('fin'), noScore: sum('noscore'), withOdds: sum('odds'),
    scoreDelayMin: delay.rows[0]?.med != null ? Math.round(Number(delay.rows[0].med)) : null,
    lateScores: Number(delay.rows[0]?.n || 0),
    days: days.map((day) => ({
      day,
      total: rows.filter((r: any) => r.day === day).reduce((a: number, r: any) => a + r.n, 0),
      noScore: rows.filter((r: any) => r.day === day).reduce((a: number, r: any) => a + r.noscore, 0),
      withOdds: rows.filter((r: any) => r.day === day).reduce((a: number, r: any) => a + r.odds, 0),
    })),
  };
}
