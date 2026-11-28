import { db } from '../db/client';
import { matchesHistory, type NewMatchHistory, type MatchHistory } from '../db/schema';
import { eq, and, gte, desc, sql } from 'drizzle-orm';

const CAMEL: Record<string, string> = { start_at: 'startAt', rank1: 'rank1', rank2: 'rank2', coeff1: 'coeff1', coeff2: 'coeff2', open_coeff1: 'openCoeff1', open_coeff2: 'openCoeff2', close_coeff1: 'closeCoeff1', close_coeff2: 'closeCoeff2', best_coeff1: 'bestCoeff1', best_coeff2: 'bestCoeff2', best_book1: 'bestBook1', best_book2: 'bestBook2', tier: 'tier', maps: 'maps', pm_coeff1: 'pmCoeff1', pm_coeff2: 'pmCoeff2', pm_close1: 'pmClose1', pm_close2: 'pmClose2' };
/** `col = COALESCE(the new value, the saved one)` for each column. */
const keep = (...cols: string[]) => Object.fromEntries(cols.map((c) => [CAMEL[c], sql.raw(`COALESCE(excluded.${c}, matches_history.${c})`)]));
/** The predictor fields of a feed match: start, rankings, odds, tier, maps. */
export function historyExtras(m: { startDate?: string | null; positionTeam1?: number | null; positionTeam2?: number | null; coeff1?: number | null; coeff2?: number | null; openCoeff1?: number | null; openCoeff2?: number | null; closeCoeff1?: number | null; closeCoeff2?: number | null; bestCoeff1?: number | null; bestCoeff2?: number | null; bestBook1?: string | null; bestBook2?: string | null; tier?: string | null; maps?: unknown[] | null; pmCoeff1?: number | null; pmCoeff2?: number | null; pmClose1?: number | null; pmClose2?: number | null }) {
  const n = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 1 ? String(v) : null);
  const at = m.startDate ? new Date(m.startDate) : null;
  return {
    startAt: at && !Number.isNaN(at.getTime()) ? at : null,
    rank1: m.positionTeam1 ?? null, rank2: m.positionTeam2 ?? null,
    coeff1: n(m.coeff1), coeff2: n(m.coeff2), openCoeff1: n(m.openCoeff1), openCoeff2: n(m.openCoeff2),
    closeCoeff1: n(m.closeCoeff1), closeCoeff2: n(m.closeCoeff2), bestCoeff1: n(m.bestCoeff1), bestCoeff2: n(m.bestCoeff2),
    bestBook1: m.bestBook1 ?? null, bestBook2: m.bestBook2 ?? null, tier: m.tier ?? null, maps: m.maps?.length ? m.maps : null,
    pmCoeff1: n(m.pmCoeff1), pmCoeff2: n(m.pmCoeff2), pmClose1: n(m.pmClose1), pmClose2: n(m.pmClose2),
  };
}

/**
 * Upsert a finished match into the history table.
 * Uses ON CONFLICT (match_id) to avoid duplicates.
 */
export async function upsertMatchHistory(match: NewMatchHistory): Promise<void> {
  // A finished 0:0 is «no score yet»: it never wipes a score already known (an admin's temporary result included)
  const noScore = !match.score1 && !match.score2;
  try {
    await db
      .insert(matchesHistory)
      .values(match)
      .onConflictDoUpdate({
        target: matchesHistory.id,
        set: {
          ...(noScore ? {} : { score1: match.score1 ?? 0, score2: match.score2 ?? 0 }),
          status: match.status ?? 'finished',
          tournament: match.tournament ?? '',
          matchType: match.matchType ?? '',
          logoTeam1: match.logoTeam1,
          logoTeam2: match.logoTeam2,
          tournamentLogo: match.tournamentLogo,
          // what a predictor needs: a value once known is never wiped by a later copy without it
          ...keep('start_at', 'rank1', 'rank2', 'coeff1', 'coeff2', 'open_coeff1', 'open_coeff2', 'close_coeff1', 'close_coeff2', 'best_coeff1', 'best_coeff2', 'best_book1', 'best_book2', 'tier', 'maps', 'pm_coeff1', 'pm_coeff2', 'pm_close1', 'pm_close2'),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error('[matchHistory] Upsert failed:', (err as Error).message);
  }
}

/**
 * Batch upsert finished matches.
 */
export async function upsertMatchHistoryBatch(matches: NewMatchHistory[]): Promise<void> {
  if (matches.length === 0) return;
  let saved = 0;
  for (const m of matches) {
    try {
      await upsertMatchHistory(m);
      saved++;
    } catch { /* skip individual failures */ }
  }
  if (saved > 0) {
    console.log(`[matchHistory] Saved ${saved} finished matches`);
  }
}

/**
 * Get past finished matches, grouped by game.
 *
 * @param game  "dota2" | "cs2" | "all"
 * @param days  How many days back (default 7)
 */
export async function getPastMatches(
  game: 'dota2' | 'cs2' | 'all' = 'all',
  days = 7,
): Promise<MatchHistory[]> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const sinceStr = sinceDate.toISOString().split('T')[0];

  const conditions = [
    gte(matchesHistory.date, sinceStr),
  ];

  if (game !== 'all') {
    conditions.push(eq(matchesHistory.game, game));
  }

  const rows = await db
    .select()
    .from(matchesHistory)
    .where(and(...conditions))
    .orderBy(desc(matchesHistory.date));

  return rows;
}
