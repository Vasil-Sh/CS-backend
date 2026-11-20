import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { settingsService } from '../services/settingsService';
import { recordAction } from '../services/auditLog';
import { pool } from '../db/client';

const settings = new Hono();

/** GET /api/admin/settings — read admin settings. */
settings.get('/admin/settings', requireAuth, requireAdmin, async (c) => {
  try {
    const [data, meta] = await Promise.all([settingsService.get(), settingsService.meta()]);
    return c.json({ settings: data, meta });
  } catch (err) {
    console.error('[Settings/Get] Error:', (err as Error).message);
    return c.json({ error: 'Failed to fetch settings' }, 500);
  }
});

/** PUT /api/admin/settings — update admin settings. */
settings.put('/admin/settings', requireAuth, requireAdmin, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  try {
    const num = (v: unknown): number | undefined =>
      v === undefined || v === null ? undefined : Number(v);
    const arr = (v: unknown): string[] | undefined =>
      v === undefined || v === null ? undefined : Array.isArray(v) ? v.map(String) : undefined;
    const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
    const before = await settingsService.get();
    const patch = {
      defaultMonthlyPrice: num(body.defaultMonthlyPrice),
      subscriptionDays: num(body.subscriptionDays),
      bannerSpecText: body.bannerSpecText !== undefined ? String(body.bannerSpecText) : undefined,
      basicPrice: num(body.basicPrice),
      proPrice: num(body.proPrice),
      basicFeatures: arr(body.basicFeatures),
      proFeatures: arr(body.proFeatures),
      trialEnabled: body.trialEnabled !== undefined ? Boolean(body.trialEnabled) : undefined,
      trialDays: num(body.trialDays),
      trialPlan: body.trialPlan !== undefined ? String(body.trialPlan) : undefined,
      aiDailyLimit: num(body.aiDailyLimit),
      warningThreshold: num(body.warningThreshold),
      receiptFields: arr(body.receiptFields),
      disclaimerText: body.disclaimerText !== undefined ? String(body.disclaimerText) : undefined,
      aiUsdUah: num(body.aiUsdUah),
      churnInactiveDays: num(body.churnInactiveDays),
      churnLossStreak: num(body.churnLossStreak),
      adsOddsInList: body.adsOddsInList !== undefined ? Boolean(body.adsOddsInList) : undefined,
      adsMatchDetails: body.adsMatchDetails !== undefined ? Boolean(body.adsMatchDetails) : undefined,
      trialStepDays: num(body.trialStepDays),
      aiStopWords: arr(body.aiStopWords),
      aiWordingRule: str(body.aiWordingRule),
      footerDisclaimer: str(body.footerDisclaimer),
      addictionHelp: str(body.addictionHelp),
      beforeAiText: str(body.beforeAiText),
      expiringDays: num(body.expiringDays),
      receiptSupport: str(body.receiptSupport),
      receiptThanks: str(body.receiptThanks),
      receiptPrefix: str(body.receiptPrefix),
      tplExpiring: str(body.tplExpiring),
      tplInactive: str(body.tplInactive),
      tplPaid: str(body.tplPaid),
      tplLapsed: str(body.tplLapsed),
    };
    const actor = c.get('user');
    const data = await settingsService.update(patch, actor?.username || '');
    await recordAction(actor, 'PUT', '/admin/settings', {
      before: before as unknown as Record<string, unknown>,
      after: data as unknown as Record<string, unknown>,
    });
    return c.json({ settings: data, meta: await settingsService.meta() });
  } catch (err) {
    console.error('[Settings/Put] Error:', (err as Error).message);
    return c.json({ error: (err as Error).message || 'Failed to update settings' }, 400);
  }
});

/**
 * GET /api/admin/settings/overview — live numbers shown next to the settings:
 * people on each plan, trial now and conversion, AI usage today / this month,
 * how many users the warning rules catch right now, and the next receipt number.
 */
settings.get('/admin/settings/overview', requireAuth, requireAdmin, async (c) => {
  try {
    const s = await settingsService.get();
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;
    const [plans, trial, conv, ai, expiring, inactive, streak, receipt] = await Promise.all([
      pool.query<{ plan: string; n: string }>(
        `SELECT plan, count(*)::int AS n FROM users
         WHERE role='user' AND plan IN ('basic','pro') AND end_date >= CURRENT_DATE GROUP BY plan`),
      one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role='user' AND plan='trial' AND trial_end_date >= CURRENT_DATE`),
      // Registered in the last 30 days and the trial is already over: what share pays now.
      one<{ ended: number; paid: number }>(
        `SELECT count(*)::int AS ended, count(*) FILTER (WHERE plan IN ('basic','pro') AND end_date >= CURRENT_DATE)::int AS paid
         FROM users WHERE role='user' AND created_at >= now() - interval '30 days' AND created_at < now() - make_interval(days => $1::int)`,
        [s.trialDays]),
      one<{ today: number; todayCost: string; month: number; monthCost: string }>(
        `SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv')::int AS today,
                coalesce(sum(cost) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'), 0) AS "todayCost",
                count(*)::int AS month, coalesce(sum(cost), 0) AS "monthCost"
         FROM ai_usage WHERE status='success' AND created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'`),
      one<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE role='user' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int`, [s.expiringDays]),
      one<{ n: number }>(
        `SELECT count(*)::int AS n FROM users u WHERE u.role='user' AND u.end_date >= CURRENT_DATE
         AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.user_id=u.id AND b.created_at >= now() - make_interval(days => $1::int))`, [s.churnInactiveDays]),
      one<{ n: number }>(
        `WITH r AS (SELECT b.user_id, b.result, row_number() OVER (PARTITION BY b.user_id ORDER BY b.created_at DESC) AS rn
                    FROM bets b JOIN users u ON u.id=b.user_id
                    WHERE u.role='user' AND u.end_date >= CURRENT_DATE AND b.result IN ('Win','Loss'))
         SELECT count(*)::int AS n FROM (SELECT user_id FROM r WHERE rn <= $1::int GROUP BY user_id
                                          HAVING count(*) = $1::int AND bool_and(result='Loss')) x`, [s.churnLossStreak]),
      one<{ next: number }>(`SELECT coalesce(max(id), 0)::int + 1 AS next FROM admin_payments`),
    ]);
    const byPlan = Object.fromEntries(plans.rows.map((r) => [r.plan, Number(r.n)]));
    const rate = s.aiUsdUah;
    return c.json({
      plans: { basic: byPlan.basic ?? 0, pro: byPlan.pro ?? 0 },
      trial: { now: trial.n, conversionPct: conv.ended ? Math.round((conv.paid / conv.ended) * 100) : null },
      ai: {
        today: ai.today, todayUah: Math.round(Number(ai.todayCost) * rate),
        month: ai.month, monthUah: Math.round(Number(ai.monthCost) * rate),
      },
      alerts: { expiring: expiring.n, inactive: inactive.n, lossStreak: streak.n },
      receiptNext: receipt.next,
    });
  } catch (err) {
    console.error('[Settings/Overview] Error:', (err as Error).message);
    return c.json({ error: 'Failed to load settings overview' }, 500);
  }
});

export default settings;
