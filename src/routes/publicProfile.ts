/**
 * Public Profile API — no auth required
 * GET /api/public-profile/:username — returns public stats for sharing
 */

import { Hono } from 'hono';
import { db, schema } from '../db/client';
import { eq, and, sql } from 'drizzle-orm';

const publicProfile = new Hono();

publicProfile.get('/:username', async (c) => {
  const username = c.req.param('username') || '';
  if (!username) return c.json({ error: 'Username required' }, 400);

  try {
    // Find user
    const [user] = await db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (!user) return c.json({ error: 'User not found' }, 404);

    // Get ALL bets (including pending for total count)
    const allBets = await db
      .select()
      .from(schema.bets)
      .where(eq(schema.bets.userId, user.id));

    // Completed bets only for stats calculations
    const completedBets = allBets.filter((b: any) => b.result !== 'Pending');

    const totalBets = allBets.length;
    const wins = completedBets.filter((b: any) => b.result === 'Win').length;
    const winRate = completedBets.length > 0 ? Math.round((wins / completedBets.length) * 100) : 0;
    const totalProfit = completedBets.reduce((sum: number, b: any) => sum + (b.profit || 0), 0);
    const totalStaked = completedBets.reduce((sum: number, b: any) => sum + (b.amount || 0), 0);
    const roi = totalStaked > 0 ? Math.round((totalProfit / totalStaked) * 100) : 0;
    const avgOdds = completedBets.length > 0
      ? Math.round((completedBets.reduce((sum: number, b: any) => sum + Number(b.odds), 0) / completedBets.length) * 100) / 100
      : 0;
    const pendingBets = totalBets - completedBets.length;

    // Get bankroll
    const [bankroll] = await db
      .select()
      .from(schema.bankroll)
      .where(eq(schema.bankroll.userId, user.id))
      .limit(1);

    // Get active goals count
    const goals = await db
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, user.id), eq(schema.goals.isCompleted, false)));

    // Get recent 5 bets
    const recentBets = await db
      .select()
      .from(schema.bets)
      .where(eq(schema.bets.userId, user.id))
      .orderBy(sql`${schema.bets.createdAt} DESC`)
      .limit(5);

    // Monthly profit for chart (completed only)
    const monthlyProfit: { month: string; profit: number }[] = [];
    const monthMap = new Map<string, number>();
    for (const b of completedBets) {
      const date = b.date || b.createdAt;
      if (!date) continue;
      const m = String(date).substring(0, 7); // YYYY-MM
      monthMap.set(m, (monthMap.get(m) || 0) + (b.profit || 0));
    }
    for (const [month, profit] of [...monthMap.entries()].sort()) {
      monthlyProfit.push({ month, profit: Math.round(profit * 100) / 100 });
    }

    const currentBank = bankroll
      ? Number(bankroll.initialBank || 0) + totalProfit
      : totalProfit;

    const losses = completedBets.filter((b: any) => b.result === 'Loss').length;

    return c.json({
      username,
      stats: {
        totalBets,
        pendingBets,
        wins,
        losses,
        winRate,
        totalProfit: Math.round(totalProfit * 100) / 100,
        totalStaked: Math.round(totalStaked * 100) / 100,
        roi,
        avgOdds,
        currentBank: Math.round(currentBank * 100) / 100,
        activeGoals: goals.length,
      },
      recentBets: recentBets.map((b: any) => ({
        match: b.match,
        result: b.result,
        profit: b.profit,
        odds: Number(b.odds),
        date: b.date,
        game: b.game,
      })),
      monthlyProfit,
    });
  } catch (err) {
    console.error('[PublicProfile] Error:', (err as Error).message);
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }
});

export default publicProfile;
