import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { settingsService, type AppSettings } from '../services/settingsService';
import { pool } from '../db/client';
import { auditChanges } from '../services/auditChanges';

/** Audit-friendly copy: long texts are shortened so the log stays readable. */
const snapshot = (s: AppSettings) => ({ ...s, bannerSpecText: s.bannerSpecText.length > 200 ? s.bannerSpecText.slice(0, 200) + '…' : s.bannerSpecText });

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
    const before = await settingsService.get();
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
    // Record who changed what (the generic audit middleware only covers users/banners).
    const changes = auditChanges(snapshot(before), snapshot(data));
    if (Object.keys(changes).length) {
      const actor = c.get('user');
      await pool.query(
        `INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'PUT','/admin/settings',$3,'success')`,
        [actor.userId, actor.username, JSON.stringify({ _changes: changes })],
      ).catch((e) => console.error('[Settings/Put] Audit failed:', (e as Error).message));
    }
    return c.json({ settings: data });
  } catch (err) {
    console.error('[Settings/Put] Error:', (err as Error).message);
    return c.json({ error: (err as Error).message || 'Failed to update settings' }, 400);
  }
});

export default settings;
