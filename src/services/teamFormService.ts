import { db } from '../db/client';
import { matchesHistory } from '../db/schema';
import { eq, desc, or, and, gte } from 'drizzle-orm';

export type TeamFormResult = {
  wins: number;
  losses: number;
  lastResults: ('W' | 'L')[]; // ordered newest first
  streak: number; // positive for wins, negative for losses
  form: 'hot_streak' | 'stable' | 'momentum' | 'falling' | 'slump' | 'inconsistent' | 'unknown';
};

/**
 * Compute form for a single team from the last 10 finished matches in history.
 * Only considers matches from the last 90 days.
 */
async function computeTeamForm(teamName: string, game: 'dota2' | 'cs2'): Promise<TeamFormResult> {
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoffDate = ninetyDaysAgo.toISOString().split('T')[0];

    const rows = await db
      .select({
        team1: matchesHistory.team1,
        team2: matchesHistory.team2,
        score1: matchesHistory.score1,
        score2: matchesHistory.score2,
        date: matchesHistory.date,
      })
      .from(matchesHistory)
      .where(
        and(
          eq(matchesHistory.game, game),
          gte(matchesHistory.date, cutoffDate),
          or(
            eq(matchesHistory.team1, teamName),
            eq(matchesHistory.team2, teamName),
          ),
        ),
      )
      .orderBy(desc(matchesHistory.date))
      .limit(10);

    if (rows.length === 0) {
      if (game === 'cs2') console.log(`[teamForm] No history for ${teamName}`);
      return { wins: 0, losses: 0, lastResults: [], streak: 0, form: 'unknown' };
    }

    let wins = 0;
    let losses = 0;
    const lastResults: ('W' | 'L')[] = [];

    for (const row of rows) {
      const isTeam1 = row.team1 === teamName;
      const s1 = row.score1 ?? 0;
      const s2 = row.score2 ?? 0;

      // Skip matches with no score (0:0)
      if (s1 === 0 && s2 === 0) continue;

      const won = isTeam1 ? s1 > s2 : s2 > s1;
      if (won) {
        wins++;
        lastResults.push('W');
      } else {
        losses++;
        lastResults.push('L');
      }
    }

    // Compute streak
    let streak = 0;
    for (const r of lastResults) {
      if (r === 'W') {
        if (streak >= 0) streak++;
        else break;
      } else {
        if (streak <= 0) streak--;
        else break;
      }
    }

    // Classify form
    const total = wins + losses;
    if (total < 3) return { wins, losses, lastResults, streak, form: 'unknown' };

    let form: TeamFormResult['form'];
    if (streak >= 5) form = 'hot_streak';
    else if (streak <= -5) form = 'slump';
    else if (lastResults.slice(0, 2).every(r => r === 'L') && lastResults.length >= 3 && lastResults[2] === 'W') form = 'momentum';
    else if (wins >= total * 0.6) form = 'stable';
    else if (losses >= 2 && losses >= total * 0.5) form = 'falling';
    else if (Math.abs(wins - losses) <= 1 && total >= 4) form = 'inconsistent';
    else form = 'stable';

    return { wins, losses, lastResults, streak, form };
  } catch (err) {
    console.error(`[teamForm] Failed for ${teamName}:`, (err as Error).message);
    return { wins: 0, losses: 0, lastResults: [], streak: 0, form: 'unknown' };
  }
}

/**
 * Batch compute form for multiple teams. Returns a map of team name → form result.
 */
export async function batchComputeTeamForms(
  teamNames: string[],
  game: 'dota2' | 'cs2',
): Promise<Map<string, TeamFormResult>> {
  const unique = [...new Set(teamNames)].filter(Boolean);
  const results = new Map<string, TeamFormResult>();

  // Run in parallel, max 5 concurrent to avoid DB overload
  const chunks = [];
  for (let i = 0; i < unique.length; i += 5) {
    chunks.push(unique.slice(i, i + 5));
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async (name) => {
      const form = await computeTeamForm(name, game);
      return [name, form] as const;
    });
    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.set(s.value[0], s.value[1]);
      }
    }
  }

  return results;
}
