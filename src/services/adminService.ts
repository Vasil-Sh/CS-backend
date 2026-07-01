// ═══════════════════════════════════════════
// Admin Service — self-service data reset
// ═══════════════════════════════════════════

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class AdminService {
  /** Delete ALL user data (bets, goals, strategies, groups, bankroll, risky teams) */
  async resetUserData(userId: number) {
    const counts = { bets: 0, goals: 0, strategies: 0, groups: 0, bankroll: false, riskyTeams: 0 };
    counts.bets = (await db.delete(schema.bets).where(eq(schema.bets.userId, userId))).rowCount || 0;
    counts.goals = (await db.delete(schema.goals).where(eq(schema.goals.userId, userId))).rowCount || 0;
    counts.strategies = (await db.delete(schema.strategies).where(eq(schema.strategies.userId, userId))).rowCount || 0;
    counts.groups = (await db.delete(schema.telegramGroups).where(eq(schema.telegramGroups.userId, userId))).rowCount || 0;
    counts.bankroll = ((await db.delete(schema.bankroll).where(eq(schema.bankroll.userId, userId))).rowCount || 0) > 0;
    counts.riskyTeams = (await db.delete(schema.riskyTeams).where(eq(schema.riskyTeams.userId, userId))).rowCount || 0;
    return counts;
  }
}

export const adminService = new AdminService();
