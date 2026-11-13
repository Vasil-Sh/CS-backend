import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { settingsService } from '../services/settingsService';
import { recordAction } from '../services/auditLog';

const settings = new Hono();

/** GET /api/admin/settings — read admin settings. */
settings.get('/admin/settings', requireAuth, requireAdmin, async (c) => {
  try {
    const data = await settingsService.get();
    return c.json({ settings: data });
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
    };
    const data = await settingsService.update(patch);
    const actor = c.get('user');
    await recordAction(actor, 'PUT', '/admin/settings', {
      before: before as unknown as Record<string, unknown>,
      after: data as unknown as Record<string, unknown>,
    });
    return c.json({ settings: data });
  } catch (err) {
    console.error('[Settings/Put] Error:', (err as Error).message);
    return c.json({ error: (err as Error).message || 'Failed to update settings' }, 400);
  }
});

export default settings;
