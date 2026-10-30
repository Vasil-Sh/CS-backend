import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { settingsService } from '../services/settingsService';

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
    const data = await settingsService.update({
      ...(body.defaultMonthlyPrice !== undefined
        ? { defaultMonthlyPrice: Number(body.defaultMonthlyPrice) }
        : {}),
      ...(body.subscriptionDays !== undefined
        ? { subscriptionDays: Number(body.subscriptionDays) }
        : {}),
      ...(body.bannerSpecText !== undefined
        ? { bannerSpecText: String(body.bannerSpecText) }
        : {}),
    });
    return c.json({ settings: data });
  } catch (err) {
    console.error('[Settings/Put] Error:', (err as Error).message);
    return c.json({ error: (err as Error).message || 'Failed to update settings' }, 400);
  }
});

export default settings;
