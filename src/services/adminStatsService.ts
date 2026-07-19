// ═══════════════════════════════════════════
// Admin Stats Service — business analytics
// ═══════════════════════════════════════════

import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { sql, count, sum, eq, gte } from 'drizzle-orm';

export class AdminStatsService {
  async getStats(): Promise<AdminStats> {
    const client = await pool.connect();
    try {
      const [totalRow] = await db.select({ total: count() }).from(users);
      const [activeRow] = await db.select({ count: count() }).from(users).where(gte(users.endDate, sql`CURRENT_DATE`));
      const [adminRow] = await db.select({ count: count() }).from(users).where(eq(users.role, 'admin'));

      const firstOfMonth = new Date();
      firstOfMonth.setDate(1);
      const firstOfMonthStr = firstOfMonth.toISOString().split('T')[0];
      const [newMonthRow] = await db.select({ count: count() }).from(users).where(gte(users.createdAt, sql`${firstOfMonthStr}::date`));

      const [mrrRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(gte(users.endDate, sql`CURRENT_DATE`));
      const [totalRevenueRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(eq(users.role, 'user'));

      const revenueResult = await client.query(
        `WITH months AS (
           SELECT generate_series(
             date_trunc('month', NOW()) - INTERVAL '11 months',
             date_trunc('month', NOW()),
             '1 month'
           )::date AS month_start
         )
         SELECT to_char(m.month_start, 'YYYY-MM') as month,
                COALESCE(SUM(u.price_month)::int, 0) as revenue
         FROM months m
         LEFT JOIN users u ON u.end_date >= m.month_start AND u.role = 'user'
         GROUP BY m.month_start ORDER BY m.month_start`
      );

      const regResult = await client.query(
        `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
         FROM users WHERE created_at >= NOW() - INTERVAL '12 months'
         GROUP BY month ORDER BY month`
      );

      const topResult = await client.query(
        `SELECT username, telegram, price_month::int as revenue, end_date
         FROM users ORDER BY price_month DESC LIMIT 5`
      );

      const expiringResult = await client.query(
        `SELECT username, telegram, end_date, price_month::int as price_month
         FROM users WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
         ORDER BY end_date`
      );

      const recentResult = await client.query(
        `SELECT username, created_at, price_month::int as price
         FROM users WHERE role = 'user'
         ORDER BY created_at DESC LIMIT 8`
      );

      const planResult = await client.query(
        `SELECT price_month::int as price, COUNT(*) as count
         FROM users WHERE role = 'user'
         GROUP BY price_month ORDER BY price_month`
      );

      const totalUsers = Number(totalRow?.total ?? 0);
      const activeUsers = Number(activeRow?.count ?? 0);

      return {
        totalUsers, activeUsers,
        adminUsers: Number(adminRow?.count ?? 0),
        inactiveUsers: totalUsers - activeUsers,
        newThisMonth: Number(newMonthRow?.count ?? 0),
        mrr: Math.round(Number(mrrRow?.total ?? 0)),
        totalRevenue: Math.round(Number(totalRevenueRow?.total ?? 0)),
        revenueByMonth: revenueResult.rows.map((r: any) => ({ month: r.month, revenue: Number(r.revenue) })),
        registrationsByMonth: regResult.rows.map((r: any) => ({ month: r.month, count: Number(r.count) })),
        topUsers: topResult.rows.map((r: any) => ({
          username: r.username, telegram: r.telegram || '',
          revenue: r.revenue,
          endDate: r.end_date ? new Date(r.end_date).toISOString().split('T')[0] : '',
        })),
        expiringSubscriptions: expiringResult.rows.map((r: any) => ({
          username: r.username, telegram: r.telegram || '',
          endDate: r.end_date ? new Date(r.end_date).toISOString().split('T')[0] : '',
          priceMonth: r.price_month,
        })),
        recentRegistrations: recentResult.rows.map((r: any) => ({
          username: r.username,
          date: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '',
          price: r.price,
        })),
        planDistribution: planResult.rows.map((r: any) => ({
          price: r.price,
          count: Number(r.count),
        })),
      };
    } finally {
      client.release();
    }
  }
}

export interface AdminStats {
  totalUsers: number; activeUsers: number; adminUsers: number; inactiveUsers: number;
  newThisMonth: number; mrr: number; totalRevenue: number;
  revenueByMonth: { month: string; revenue: number }[];
  registrationsByMonth: { month: string; count: number }[];
  topUsers: { username: string; telegram: string; revenue: number; endDate: string }[];
  expiringSubscriptions: { username: string; telegram: string; endDate: string; priceMonth: number }[];
  recentRegistrations: { username: string; date: string; price: number }[];
  planDistribution: { price: number; count: number }[];
}

export const adminStatsService = new AdminStatsService();
