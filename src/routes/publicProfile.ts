/** Public, read-only profile. Game and period scope every aggregate and recent row. */
import { Hono } from 'hono';
import { db, schema } from '../db/client';
import { eq, and } from 'drizzle-orm';
import { generateLogoFallback } from '../services/createMatchesRouter';
import { buildPublicProfileStats, toNumber, type ProfileGame, type ProfilePeriod } from '../services/publicProfileStats';

const publicProfile = new Hono();
publicProfile.get('/:username', async c => {
  const username = c.req.param('username') || '';
  const game = c.req.query('game') || 'all';
  const period = c.req.query('period') || 'all';
  if (!['all', 'cs2', 'dota2'].includes(game) || !['all', '30d', '90d', '365d'].includes(period)) {
    return c.json({ error: 'Invalid profile filter' }, 400);
  }
  try {
    const [user] = await db.select({ id: schema.users.id, username: schema.users.username, telegram: schema.users.telegram })
      .from(schema.users).where(eq(schema.users.username, username)).limit(1);
    if (!user) return c.json({ error: 'User not found' }, 404);
    const allBets = await db.select().from(schema.bets).where(eq(schema.bets.userId, user.id));
    const [bankroll] = await db.select().from(schema.bankroll).where(eq(schema.bankroll.userId, user.id)).limit(1);
    const goals = await db.select().from(schema.goals).where(and(eq(schema.goals.userId, user.id), eq(schema.goals.isCompleted, false)));
    const result = buildPublicProfileStats(allBets, { game: game as ProfileGame, period: period as ProfilePeriod, exchangeRate: bankroll?.exchangeRate });
    return c.json({
      ...result, username: user.username, telegram: user.telegram || '',
      stats: { ...result.stats, currentBank: toNumber(bankroll?.initialBank) + result.stats.totalProfit, activeGoals: goals.length },
      recentBets: result.recentBets.map(bet => {
        const prefix = /dota|дота/i.test(bet.game) ? 'dota2' : 'cs2';
        return { ...bet,
          logoTeam1: bet.logoTeam1 || (bet.team1 ? generateLogoFallback(bet.team1, prefix) : null),
          logoTeam2: bet.logoTeam2 || (bet.team2 ? generateLogoFallback(bet.team2, prefix) : null),
        };
      }),
    });
  } catch (error) {
    console.error('[PublicProfile] Error:', (error as Error).message);
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }
});
export default publicProfile;
