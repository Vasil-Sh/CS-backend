import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { adminStatsService } from '../services/adminStatsService';

const adminStats = new Hono();

/** GET /api/admin/stats — platform-wide analytics for admin dashboard */
adminStats.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const stats = await adminStatsService.getStats();
    return c.json(stats);
  } catch (err: any) {
    console.error('[Admin/Stats] Error:', err.message);
    return c.json({ error: 'Failed to fetch stats: ' + err.message }, 500);
  }
});

export default adminStats;
