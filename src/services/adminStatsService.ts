// ═══════════════════════════════════════════
// Admin Stats Service — business analytics
// ═══════════════════════════════════════════

import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { sql, count, sum, eq, gte, and } from 'drizzle-orm';

export const MONTHLY_SUBSCRIPTIONS_SQL = `WITH months AS (
           SELECT generate_series(
             date_trunc('year', (now() AT TIME ZONE 'Europe/Kyiv')::date),
             date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date),
             '1 month'
           )::date AS month_start
         )
         SELECT to_char(m.month_start, 'YYYY-MM') as month,
                COALESCE(SUM(u.price_month), 0) as revenue, COUNT(u.id) FILTER (WHERE u.price_month > 0) as paid_users
         FROM months m
         LEFT JOIN users u ON u.end_date >= m.month_start
           AND COALESCE(u.start_date,u.created_at::date) < (m.month_start + INTERVAL '1 month')
           AND COALESCE(u.start_date,u.created_at::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date
           AND u.role = 'user'
         GROUP BY m.month_start ORDER BY m.month_start`;

export class AdminStatsService {
  async getStats(): Promise<AdminStats> {
    const client = await pool.connect();
    try {
      const [totalRow] = await db.select({ total: count() }).from(users).where(eq(users.role, 'user'));
      const [activeRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));
      const [adminRow] = await db.select({ count: count() }).from(users).where(eq(users.role, 'admin'));

      const [newMonthRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')`)));

      const [mrrRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));
      const [totalRevenueRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(eq(users.role, 'user'));

      const revenueResult = await client.query(
        MONTHLY_SUBSCRIPTIONS_SQL
      );

      const regResult = await client.query(
        `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
         FROM users WHERE role = 'user' AND created_at >= date_trunc('year', (now() AT TIME ZONE 'Europe/Kyiv')::date)
         GROUP BY month ORDER BY month`
      );

      const topResult = await client.query(
        `SELECT username, telegram, price_month::numeric as revenue, end_date
         FROM users WHERE role = 'user' ORDER BY price_month DESC LIMIT 5`
      );

      const expiringResult = await client.query(
        `SELECT username, telegram, end_date, price_month::numeric as price_month
         FROM users WHERE end_date BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date AND (now() AT TIME ZONE 'Europe/Kyiv')::date + INTERVAL '7 days'
         ORDER BY end_date`
      );

      const recentResult = await client.query(
        `SELECT username, created_at, price_month::numeric as price
         FROM users WHERE role = 'user'
         ORDER BY created_at DESC LIMIT 8`
      );

      const planResult = await client.query(
        `SELECT price_month::numeric as price, COUNT(*) as count
         FROM users WHERE role = 'user'
         GROUP BY price_month ORDER BY price_month`
      );

      const payments = await client.query(`SELECT to_char(paid_on,'YYYY-MM') AS month,SUM(amount)::text AS amount,COUNT(*)::int AS count FROM admin_payments WHERE status='recorded' AND paid_on >= date_trunc('year',(now() AT TIME ZONE 'Europe/Kyiv')::date) AND paid_on <= (now() AT TIME ZONE 'Europe/Kyiv')::date GROUP BY 1 ORDER BY 1`);
      const totalUsers = Number(totalRow?.total ?? 0);
      const activeUsers = Number(activeRow?.count ?? 0);

      return {
        paymentsByMonth: payments.rows.map(r=>({month:r.month,amount:Number(r.amount),count:r.count})),
        totalUsers, activeUsers,
        adminUsers: Number(adminRow?.count ?? 0),
        inactiveUsers: totalUsers - activeUsers,
        newThisMonth: Number(newMonthRow?.count ?? 0),
        mrr: Number(mrrRow?.total ?? 0),
        totalRevenue: Number(totalRevenueRow?.total ?? 0),
        revenueByMonth: revenueResult.rows.map((r: any) => ({ month: r.month, revenue: Number(r.revenue), paidUsers: Number(r.paid_users) })),
        registrationsByMonth: regResult.rows.map((r: any) => ({ month: r.month, count: Number(r.count) })),
        topUsers: topResult.rows.map((r: any) => ({
          username: r.username, telegram: r.telegram || '',
          revenue: Number(r.revenue),
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
          price: Number(r.price),
        })),
        planDistribution: planResult.rows.map((r: any) => ({
          price: Number(r.price),
          count: Number(r.count),
        })),
      };
    } finally {
      client.release();
    }
  }
}

export interface AdminStats {
  paymentsByMonth: {month:string;amount:number;count:number}[];
  totalUsers: number; activeUsers: number; adminUsers: number; inactiveUsers: number;
  newThisMonth: number; mrr: number; totalRevenue: number;
  revenueByMonth: { month: string; revenue: number; paidUsers: number }[];
  registrationsByMonth: { month: string; count: number }[];
  topUsers: { username: string; telegram: string; revenue: number; endDate: string }[];
  expiringSubscriptions: { username: string; telegram: string; endDate: string; priceMonth: number }[];
  recentRegistrations: { username: string; date: string; price: number }[];
  planDistribution: { price: number; count: number }[];
}

export const adminStatsService = new AdminStatsService();
