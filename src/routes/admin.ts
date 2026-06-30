import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { requireAuth } from '../middleware/auth';

/**
 * POST /api/admin/reset — delete ALL user data (bets, goals, strategies, groups, bankroll, risky teams).
 * One call, no silent failures.
 */
const admin = new Hono();

admin.post('/admin/reset', requireAuth, async (c) => {
  const user = c.get('user');
  const uid = user.userId;

  const counts = {
    bets: 0,
    goals: 0,
    strategies: 0,
    groups: 0,
    bankroll: false,
    riskyTeams: 0,
  };

  try {
    const betsResult = await db.delete(schema.bets).where(eq(schema.bets.userId, uid));
    counts.bets = betsResult.rowCount || 0;

    const goalsResult = await db.delete(schema.goals).where(eq(schema.goals.userId, uid));
    counts.goals = goalsResult.rowCount || 0;

    const stratsResult = await db.delete(schema.strategies).where(eq(schema.strategies.userId, uid));
    counts.strategies = stratsResult.rowCount || 0;

    const groupsResult = await db.delete(schema.telegramGroups).where(eq(schema.telegramGroups.userId, uid));
    counts.groups = groupsResult.rowCount || 0;

    const bankrollResult = await db.delete(schema.bankroll).where(eq(schema.bankroll.userId, uid));
    counts.bankroll = (bankrollResult.rowCount || 0) > 0;

    const riskyResult = await db.delete(schema.riskyTeams).where(eq(schema.riskyTeams.userId, uid));
    counts.riskyTeams = riskyResult.rowCount || 0;

    return c.json({ success: true, counts });
  } catch (err: any) {
    console.error('[Admin/Reset] Error:', err.message);
    return c.json({ error: 'Reset failed: ' + err.message, counts }, 500);
  }
});

export default admin;
