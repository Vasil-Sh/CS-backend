import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { adminService } from '../services/adminService';

/**
 * Self-service data reset — authenticated users delete THEIR OWN data.
 * This is NOT an admin-only endpoint despite the /admin path (kept for frontend compat).
 * Each user can only reset their own data (scoped by c.get('user').userId).
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

export default admin;
