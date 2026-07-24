import { db } from '../db/client';
import { matchesHistory, type NewMatchHistory, type MatchHistory } from '../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

/**
 * Upsert a finished match into the history table.
 * Uses ON CONFLICT (match_id) to avoid duplicates.
 */
export async function upsertMatchHistory(match: NewMatchHistory): Promise<void> {
  try {
    await db
      .insert(matchesHistory)
      .values(match)
      .onConflictDoUpdate({
        target: matchesHistory.id,
        set: {
          score1: match.score1 ?? 0,
          score2: match.score2 ?? 0,
          status: match.status ?? 'finished',
          tournament: match.tournament ?? '',
          matchType: match.matchType ?? '',
          logoTeam1: match.logoTeam1,
          logoTeam2: match.logoTeam2,
          tournamentLogo: match.tournamentLogo,
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
