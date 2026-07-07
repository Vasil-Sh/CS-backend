// ═══════════════════════════════════════════
// Admin Stats Service — platform-wide analytics
// ═══════════════════════════════════════════

import { db, pool } from '../db/client';
import { users, bets, telegramGroups } from '../db/schema';
import { sql, count, sum, eq, gte, and } from 'drizzle-orm';

export class AdminStatsService {
  async getStats(): Promise<AdminStats> {
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const nowStr = now.toISOString().split('T')[0];

    const client = await pool.connect();
    try {
      // ── User metrics ──
      const [userRow] = await db
        .select({ total: count(), })
        .from(users);

      const [activeRow] = await db
        .select({ count: count(), })
        .from(users)
        .where(gte(users.endDate, sql`CURRENT_DATE`));

      const [adminRow] = await db
        .select({ count: count(), })
        .from(users)
        .where(eq(users.role, 'admin'));

      // ── MRR ──
      const [mrrRow] = await db
        .select({ total: sum(users.priceMonth), })
        .from(users)
        .where(gte(users.endDate, sql`CURRENT_DATE`));

      // ── Bets this week ──
      const [betsWeekRow] = await db
        .select({ count: count(), })
        .from(bets)
        .where(gte(bets.date, weekAgoStr));

      // ── Wins this week ──
      const [winsRow] = await db
        .select({ count: count(), })
        .from(bets)
        .where(and(gte(bets.date, weekAgoStr), eq(bets.result, 'Win')));

      const [lossesRow] = await db
        .select({ count: count(), })
        .from(bets)
        .where(and(gte(bets.date, weekAgoStr), eq(bets.result, 'Loss')));

      // ── Total profit ──
      const [profitRow] = await db
        .select({ total: sum(bets.profit), })
        .from(bets);

      // ── Telegram groups ──
      const [groupsRow] = await db
        .select({ count: count(), })
        .from(telegramGroups);

      // ── Registrations by month (last 12 months) ──
      const regResult = await client.query(
        `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
         FROM users
         WHERE created_at >= NOW() - INTERVAL '12 months'
         GROUP BY month ORDER BY month`
      );

      // ── Top users by bets ──
      const topResult = await client.query(
        `SELECT u.username, COUNT(b.id) as bet_count
         FROM bets b JOIN users u ON u.id = b.user_id
         GROUP BY u.username ORDER BY bet_count DESC LIMIT 5`
      );

      // ── Expiring subscriptions (7 days) ──
      const expiringResult = await client.query(
        `SELECT username, telegram, end_date, price_month
         FROM users
         WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
         ORDER BY end_date`
      );

      const totalUsers = Number(userRow?.total ?? 0);
      const activeUsers = Number(activeRow?.count ?? 0);

      return {
        totalUsers,
        activeUsers,
        adminUsers: Number(adminRow?.count ?? 0),
        inactiveUsers: totalUsers - activeUsers,
        mrr: Math.round(Number(mrrRow?.total ?? 0)),
        betsThisWeek: Number(betsWeekRow?.count ?? 0),
        winsThisWeek: Number(winsRow?.count ?? 0),
        lossesThisWeek: Number(lossesRow?.count ?? 0),
        totalProfit: Math.round(Number(profitRow?.total ?? 0)),
        telegramGroups: Number(groupsRow?.count ?? 0),
        registrationsByMonth: regResult.rows.map((r: any) => ({
          month: r.month,
          count: Number(r.count),
        })),
        topUsers: topResult.rows.map((r: any) => ({
          username: r.username,
          betCount: Number(r.bet_count),
        })),
        expiringSubscriptions: expiringResult.rows.map((r: any) => ({
          username: r.username,
          telegram: r.telegram || '',
          endDate: r.end_date ? new Date(r.end_date).toISOString().split('T')[0] : '',
          priceMonth: Math.round(Number(r.price_month ?? 0)),
        })),
      };
    } finally {
      client.release();
    }
  }
}

export interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  inactiveUsers: number;
  mrr: number;
  betsThisWeek: number;
  winsThisWeek: number;
  lossesThisWeek: number;
  totalProfit: number;
  telegramGroups: number;
  registrationsByMonth: { month: string; count: number }[];
  topUsers: { username: string; betCount: number }[];
  expiringSubscriptions: {
    username: string;
    telegram: string;
    endDate: string;
    priceMonth: number;
  }[];
}

export const adminStatsService = new AdminStatsService();
