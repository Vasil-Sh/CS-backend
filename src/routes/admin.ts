import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { adminService } from '../services/adminService';

/**
 * Self-service data reset — authenticated users delete THEIR OWN data.
 * Mounted under both /api and /api/v1 for backward compat.
 */
const admin = new Hono();

admin.post('/admin/reset', requireAuth, async (c) => {
  try {
    const counts = await adminService.resetUserData(c.get('user').userId);
    return c.json({ success: true, counts });
  } catch (err: any) {
    console.error('[Admin/Reset] Error:', err.message);
    return c.json({ error: 'Reset failed: ' + err.message }, 500);
  }
});

// Also mount at /self/reset (new canonical path)
admin.post('/self/reset', requireAuth, async (c) => {
  try {
    const counts = await adminService.resetUserData(c.get('user').userId);
    return c.json({ success: true, counts });
  } catch (err: any) {
    console.error('[Self/Reset] Error:', err.message);
    return c.json({ error: 'Reset failed: ' + err.message }, 500);
  }
});

export default admin;
