// ═══════════════════════════════════════════
// Admin Stats Service — business analytics
// ═══════════════════════════════════════════

import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { sql, count, sum, eq, gte, and } from 'drizzle-orm';
import { cache } from '../utils/cache';

const STATS_CACHE_KEY = 'admin:stats';
const kyivYear = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric' }).format(new Date()));
const STATS_TTL_MS = 30_000; // 30s — short enough for freshness, avoids ~10 queries/refresh

/** $1 = report year. Months of that year up to the current month (all 12 for past years). */
export const MONTHLY_SUBSCRIPTIONS_SQL = `WITH months AS (
           SELECT generate_series(
             make_date($1::int, 1, 1),
             LEAST(date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)::date, make_date($1::int, 12, 1)),
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
  /** @param year report year for the monthly series (default: current year in Kyiv). Current-state KPIs ignore it. */
  async getStats(year: number = kyivYear()): Promise<AdminStats> {
    const cacheKey = `${STATS_CACHE_KEY}:${year}`;
    const cached = cache.get<AdminStats>(cacheKey);
    if (cached) return cached;

    const client = await pool.connect();
    try {
      const [totalRow] = await db.select({ total: count() }).from(users).where(eq(users.role, 'user'));
      const [activeRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));
      const [adminRow] = await db.select({ count: count() }).from(users).where(eq(users.role, 'admin'));

      const [newMonthRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')`)));

      const [mrrRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));

      const revenueResult = await client.query(MONTHLY_SUBSCRIPTIONS_SQL, [year]);

      const regResult = await client.query(
        `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
         FROM users WHERE role = 'user' AND created_at >= make_date($1::int, 1, 1) AND created_at < make_date($1::int + 1, 1, 1)
         GROUP BY month ORDER BY month`, [year]
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

      const payments = await client.query(`SELECT to_char(paid_on,'YYYY-MM') AS month,SUM(amount)::text AS amount,COUNT(*)::int AS count FROM admin_payments WHERE status='recorded' AND user_id IS NOT NULL AND paid_on >= make_date($1::int,1,1) AND paid_on < make_date($1::int + 1,1,1) AND paid_on <= (now() AT TIME ZONE 'Europe/Kyiv')::date GROUP BY 1 ORDER BY 1`,[year]);
      const totalUsers = Number(totalRow?.total ?? 0);
      const activeUsers = Number(activeRow?.count ?? 0);

      const stats: AdminStats = {
        year,
        paymentsByMonth: payments.rows.map(r=>({month:r.month,amount:Number(r.amount),count:r.count})),
        totalUsers, activeUsers,
        adminUsers: Number(adminRow?.count ?? 0),
        inactiveUsers: totalUsers - activeUsers,
        newThisMonth: Number(newMonthRow?.count ?? 0),
        mrr: Number(mrrRow?.total ?? 0),
        revenueByMonth: revenueResult.rows.map((r: any) => ({ month: r.month, revenue: Number(r.revenue), paidUsers: Number(r.paid_users) })),
        registrationsByMonth: regResult.rows.map((r: any) => ({ month: r.month, count: Number(r.count) })),
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
      cache.set(cacheKey, stats, STATS_TTL_MS);
      return stats;
    } finally {
      client.release();
    }
  }

  /** Invalidate the cached stats (call after user/payment mutations). */
  invalidate(): void {
    cache.delByPrefix(STATS_CACHE_KEY);
  }
}

export interface AdminStats {
  /** Year of the monthly series below. */
  year: number;
  paymentsByMonth: {month:string;amount:number;count:number}[];
  totalUsers: number; activeUsers: number; adminUsers: number; inactiveUsers: number;
  newThisMonth: number; mrr: number;
  revenueByMonth: { month: string; revenue: number; paidUsers: number }[];
  registrationsByMonth: { month: string; count: number }[];
  recentRegistrations: { username: string; date: string; price: number }[];
  planDistribution: { price: number; count: number }[];
}

export const adminStatsService = new AdminStatsService();
