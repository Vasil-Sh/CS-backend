// ═══════════════════════════════════════════
// Admin Stats Service — business analytics
// ═══════════════════════════════════════════

import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { sql, count, sum, eq, gte, and } from 'drizzle-orm';
import { cache } from '../utils/cache';
import { planKey, planLabel } from './planNames';
import { settingsService } from './settingsService';

const STATS_CACHE_KEY = 'admin:stats';
const STATS_TTL_MS = 30_000; // 30s — short enough for freshness, avoids ~10 queries/refresh

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
    const cached = cache.get<AdminStats>(STATS_CACHE_KEY);
    if (cached) return cached;

    const client = await pool.connect();
    try {
      const [totalRow] = await db.select({ total: count() }).from(users).where(eq(users.role, 'user'));
      const [activeRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));
      const [adminRow] = await db.select({ count: count() }).from(users).where(eq(users.role, 'admin'));

      const [newMonthRow] = await db.select({ count: count() }).from(users).where(and(eq(users.role, 'user'), gte(users.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')`)));

      const [mrrRow] = await db.select({ total: sum(users.priceMonth) }).from(users).where(and(eq(users.role, 'user'), gte(users.endDate, sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`), sql`COALESCE(${users.startDate}, ${users.createdAt}::date) <= (now() AT TIME ZONE 'Europe/Kyiv')::date`));

      const revenueResult = await client.query(
        MONTHLY_SUBSCRIPTIONS_SQL
      );

      const regResult = await client.query(
        `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
         FROM users WHERE role = 'user' AND created_at >= date_trunc('year', (now() AT TIME ZONE 'Europe/Kyiv')::date)
         GROUP BY month ORDER BY month`
      );

      const recentResult = await client.query(
        `SELECT username, created_at, price_month::numeric as price
         FROM users WHERE role = 'user'
         ORDER BY created_at DESC LIMIT 8`
      );

      const planResult = await client.query(
        `SELECT COALESCE(NULLIF(plan,''),'trial') AS plan, COUNT(*)::int AS count,
                COALESCE(SUM(price_month)::numeric,0) AS price
         FROM users WHERE role = 'user'
         GROUP BY 1 ORDER BY 1`
      );

      // Conversion: trial → paid (basic/pro), plus refund totals.
      const conversionResult = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(plan,''),'trial') = 'trial')::int AS trial,
           COUNT(*) FILTER (WHERE plan IN ('basic','pro'))::int AS paid
         FROM users WHERE role = 'user'`
      );
      const refundsResult = await client.query(
        `SELECT COALESCE(SUM(refunded_amount)::numeric,0) AS total,
                COALESCE(SUM(refunded_amount) FILTER (WHERE refunded_at >= date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date))::numeric,0) AS month
         FROM admin_payments WHERE status='refunded' AND refunded_amount IS NOT NULL`
      );
      const refundsByMonthResult = await client.query(
        `SELECT to_char(refunded_at,'YYYY-MM') AS month, COALESCE(SUM(refunded_amount)::numeric,0) AS amount, COUNT(*)::int AS count
         FROM admin_payments WHERE status='refunded' AND refunded_at IS NOT NULL
           AND refunded_at >= date_trunc('year',(now() AT TIME ZONE 'Europe/Kyiv')::date)
         GROUP BY 1 ORDER BY 1`
      );
      const aiTodayResult = await client.query(
        `SELECT COALESCE(SUM(cost)::numeric,0) AS cost, COUNT(*)::int AS calls
         FROM ai_usage WHERE created_at >= (now() AT TIME ZONE 'Europe/Kyiv')::date`
      );
      const aiByMonthResult = await client.query(
        `SELECT to_char(created_at,'YYYY-MM') AS month, COALESCE(SUM(cost)::numeric,0) AS cost, COUNT(*)::int AS calls
         FROM ai_usage WHERE created_at >= date_trunc('year',(now() AT TIME ZONE 'Europe/Kyiv')::date)
         GROUP BY 1 ORDER BY 1`
      );

      // Conversion over the last 30 days: trial users whose trial ended, and of them who paid.
      const conversion30Result = await client.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE COALESCE(trial_end_date, CASE WHEN plan='trial' THEN end_date END)
                   BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - 30 AND (now() AT TIME ZONE 'Europe/Kyiv')::date
           )::int AS trial_ended,
           COUNT(*) FILTER (
             WHERE COALESCE(trial_end_date, CASE WHEN plan='trial' THEN end_date END)
                   BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - 30 AND (now() AT TIME ZONE 'Europe/Kyiv')::date
               AND EXISTS (SELECT 1 FROM admin_payments ap WHERE ap.user_id = users.id AND ap.status='recorded')
           )::int AS converted
         FROM users WHERE role='user'`
      );

      const payments = await client.query(`SELECT to_char(paid_on,'YYYY-MM') AS month,SUM(amount)::text AS amount,COUNT(*)::int AS count FROM admin_payments WHERE status='recorded' AND user_id IS NOT NULL AND paid_on >= date_trunc('year',(now() AT TIME ZONE 'Europe/Kyiv')::date) AND paid_on <= (now() AT TIME ZONE 'Europe/Kyiv')::date GROUP BY 1 ORDER BY 1`);

      const cancellationsResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM admin_payments WHERE status='cancelled' AND user_id IS NOT NULL`
      );
      const cancellationsByMonthResult = await client.query(
        `SELECT to_char(cancelled_at,'YYYY-MM') AS month, COUNT(*)::int AS count
         FROM admin_payments
         WHERE status='cancelled' AND cancelled_at IS NOT NULL
           AND cancelled_at >= date_trunc('year',(now() AT TIME ZONE 'Europe/Kyiv')::date)
         GROUP BY 1 ORDER BY 1`
      );
      const recentPaymentsResult = await client.query(
        `SELECT p.id::text, p.username, p.amount::numeric AS amount, p.paid_on::text AS "paidOn",
                p.status, p.extend_subscription AS "extendSubscription",
                p.promo_code AS "promoCode",
                COALESCE(u.plan,'trial') AS plan
         FROM admin_payments p
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.user_id IS NOT NULL
         ORDER BY p.paid_on DESC, p.id DESC LIMIT 8`
      );
      const retentionResult = await client.query(
        `SELECT
           (SELECT COUNT(DISTINCT user_id)::int FROM admin_payments WHERE extend_subscription = true AND user_id IS NOT NULL) AS retained,
           (SELECT COUNT(*)::int FROM users u WHERE u.role='user'
              AND u.end_date < (now() AT TIME ZONE 'Europe/Kyiv')::date
              AND NOT EXISTS (SELECT 1 FROM admin_payments p WHERE p.user_id=u.id AND p.extend_subscription=true)) AS churned`
      );

      // ── Retention by month (last 6 months) ──
      // A "subscription period" = one recorded payment (period_end is when it
      // ends). A period "ended" in month M if its period_end falls in M; it is
      // "renewed" if a later extend_subscription payment exists with paid_on
      // within ±7 days of that end, or a payment whose period starts after it.
      // `users.end_date` is overwritten on renewal, so we reconstruct the
      // history from admin_payments period_start/period_end.
      const retentionByMonthResult = await client.query(
        `WITH months AS (
           SELECT to_char(m, 'YYYY-MM') AS month
           FROM generate_series(
             date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date) - INTERVAL '5 months',
             date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date),
             '1 month') AS m
         ),
         periods AS (
           SELECT p.user_id, p.period_end,
                  EXISTS (
                    SELECT 1 FROM admin_payments rp
                    WHERE rp.user_id = p.user_id AND rp.status='recorded'
                      AND rp.paid_on > p.paid_on
                      AND (rp.extend_subscription = true
                           AND (rp.paid_on BETWEEN p.period_end - 7 AND p.period_end + 7
                                OR rp.period_start > p.period_end))
                  ) AS renewed
           FROM admin_payments p
           JOIN users u ON u.id = p.user_id
           WHERE p.status='recorded' AND p.user_id IS NOT NULL AND u.role='user'
             AND p.period_end >= date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date) - INTERVAL '5 months'
             -- only periods that are really over (a period ending later this month is not churn yet)
             AND p.period_end < (now() AT TIME ZONE 'Europe/Kyiv')::date
           UNION ALL
           -- users who never paid (trial only): their access ended and nobody renewed —
           -- the same people the all-time «churned» counts, so the month bars match the totals
           SELECT u.id, u.end_date, false
           FROM users u
           WHERE u.role='user' AND u.end_date IS NOT NULL
             AND u.end_date < (now() AT TIME ZONE 'Europe/Kyiv')::date
             AND u.end_date >= date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date) - INTERVAL '5 months'
             AND NOT EXISTS (SELECT 1 FROM admin_payments p WHERE p.user_id=u.id AND p.status='recorded')
         )
         SELECT to_char(period_end, 'YYYY-MM') AS month,
                COUNT(*) FILTER (WHERE NOT renewed)::int AS ended,
                COUNT(*) FILTER (WHERE renewed)::int AS renewed
         FROM periods GROUP BY 1`
      );

      // Self-limitation: from self_limitation_requests (not tilt_blocks).
      const selfLimitationCountResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM self_limitation_requests WHERE status='new'`
      );
      const selfLimitationLatestResult = await client.query(
        `SELECT id::text, username, period_days AS "periodDays", status, created_at AS "createdAt"
         FROM self_limitation_requests
         WHERE status='new' OR (status='applied' AND created_at > now() - INTERVAL '24 hours')
         ORDER BY created_at DESC LIMIT 3`
      );
      const aiUsageResult = await client.query(
        `SELECT COUNT(*)::int AS calls, COALESCE(SUM(cost)::numeric,0) AS cost,
                COALESCE(SUM(prompt_tokens)::bigint,0) + COALESCE(SUM(completion_tokens)::bigint,0) AS tokens
         FROM ai_usage`
      );
      const parserFailuresResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM parser_failures WHERE created_at > now() - INTERVAL '24 hours'`
      );
      const supportTicketsResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM support_tickets WHERE status='open'`
      );
      // Age verification: count by age_confirmed=false (not birth_date IS NULL).
      const unverifiedAgeResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE role='user' AND age_confirmed = false`
      );
      const ageUnverifiedResult = await client.query(
        `SELECT username FROM users WHERE role='user' AND age_confirmed = false ORDER BY id LIMIT 3`
      );

      const totalUsers = Number(totalRow?.total ?? 0);
      const activeUsers = Number(activeRow?.count ?? 0);
      const appSettings = await settingsService.get();
      const usdToUah = appSettings.aiUsdUah;

      // Build the retention.byMonth array for the last 6 months (zero-filled).
      const retentionMap = new Map<string, { ended: number; renewed: number }>();
      retentionByMonthResult.rows.forEach((r: any) =>
        retentionMap.set(r.month, { ended: Number(r.ended), renewed: Number(r.renewed) }),
      );
      const last6 = Array.from({ length: 6 }, (_, i) => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - (5 - i));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      });

      const stats: AdminStats = {
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
        planDistribution: planResult.rows.map((r: any) => {
          const key = planKey(r.plan);
          return { plan: key, label: planLabel(key), count: Number(r.count), price: Number(r.price) };
        }),
        conversion: {
          trial: Number(conversionResult.rows[0]?.trial ?? 0),
          paid: Number(conversionResult.rows[0]?.paid ?? 0),
          last30: {
            trialEnded: Number(conversion30Result.rows[0]?.trial_ended ?? 0),
            converted: Number(conversion30Result.rows[0]?.converted ?? 0),
          },
        },
        refunds: {
          total: Number(refundsResult.rows[0]?.total ?? 0),
          month: Number(refundsResult.rows[0]?.month ?? 0),
          byMonth: refundsByMonthResult.rows.map((r: any) => ({
            month: r.month,
            amount: Number(r.amount),
            count: Number(r.count),
          })),
        },
        cancellations: {
          total: Number(cancellationsResult.rows[0]?.total ?? 0),
          byMonth: cancellationsByMonthResult.rows.map((r: any) => ({
            month: r.month,
            count: Number(r.count),
          })),
        },
        recentPayments: recentPaymentsResult.rows.map((r: any) => ({
          id: r.id,
          username: r.username,
          amount: Number(r.amount),
          paidOn: r.paidOn || '',
          status: r.status,
          extendSubscription: Boolean(r.extendSubscription),
          promoCode: r.promoCode || '',
          plan: r.plan || 'trial',
        })),
        retention: {
          retained: Number(retentionResult.rows[0]?.retained ?? 0),
          churned: Number(retentionResult.rows[0]?.churned ?? 0),
          byMonth: last6.map((m) => ({ month: m, ...(retentionMap.get(m) ?? { ended: 0, renewed: 0 }) })),
        },
        selfLimitation: {
          new: Number(selfLimitationCountResult.rows[0]?.count ?? 0),
          latest: selfLimitationLatestResult.rows.map((r: any) => ({
            id: r.id,
            username: r.username,
            periodDays: Number(r.periodDays),
            status: r.status,
            createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
          })),
        },
        aiUsage: {
          calls: Number(aiUsageResult.rows[0]?.calls ?? 0),
          costUsd: Number(aiUsageResult.rows[0]?.cost ?? 0),
          tokens: Number(aiUsageResult.rows[0]?.tokens ?? 0),
          usdToUah,
          today: { calls: Number(aiTodayResult.rows[0]?.calls ?? 0), costUsd: Number(aiTodayResult.rows[0]?.cost ?? 0) },
          byMonth: aiByMonthResult.rows.map((r: any) => ({ month: r.month, costUsd: Number(r.cost), calls: Number(r.calls) })),
        },
        parserFailures24h: Number(parserFailuresResult.rows[0]?.count ?? 0),
        openSupportTickets: Number(supportTicketsResult.rows[0]?.count ?? 0),
        unverifiedAge: Number(unverifiedAgeResult.rows[0]?.count ?? 0),
        ageUnverified: ageUnverifiedResult.rows.map((r: any) => ({ username: r.username })),
      };
      cache.set(STATS_CACHE_KEY, stats, STATS_TTL_MS);
      return stats;
    } finally {
      client.release();
    }
  }

  /** Invalidate the cached stats (call after user/payment mutations). */
  invalidate(): void {
    cache.del(STATS_CACHE_KEY);
  }
}

export interface AdminStats {
  paymentsByMonth: {month:string;amount:number;count:number}[];
  totalUsers: number; activeUsers: number; adminUsers: number; inactiveUsers: number;
  newThisMonth: number; mrr: number;
  revenueByMonth: { month: string; revenue: number; paidUsers: number }[];
  registrationsByMonth: { month: string; count: number }[];
  recentRegistrations: { username: string; date: string; price: number }[];
  planDistribution: { plan: string; label: string; count: number; price: number }[];
  conversion: { trial: number; paid: number; last30: { trialEnded: number; converted: number } };
  cancellations: { total: number; byMonth: { month: string; count: number }[] };
  refunds: { total: number; month: number; byMonth: { month: string; amount: number; count: number }[] };
  recentPayments: { id: string; username: string; amount: number; paidOn: string; status: string; extendSubscription: boolean; promoCode: string; plan: string }[];
  retention: { retained: number; churned: number; byMonth: { month: string; ended: number; renewed: number }[] };
  selfLimitation: { new: number; latest: { id: string; username: string; periodDays: number; status: string; createdAt: string }[] };
  aiUsage: { calls: number; costUsd: number; tokens: number; usdToUah: number; today: { calls: number; costUsd: number }; byMonth: { month: string; costUsd: number; calls: number }[] };
  parserFailures24h: number;
  openSupportTickets: number;
  unverifiedAge: number;
  ageUnverified: { username: string }[];
}

export const adminStatsService = new AdminStatsService();
