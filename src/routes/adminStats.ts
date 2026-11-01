import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { adminStatsService } from '../services/adminStatsService';

const adminStats = new Hono();

/** GET /api/admin/stats?year=YYYY — platform-wide analytics for admin dashboard (monthly series for that year) */
adminStats.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const raw = c.req.query('year');
    const currentYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric' }).format(new Date()));
    const year = raw ? Number(raw) : currentYear;
    if (!Number.isInteger(year) || year < 2020 || year > currentYear) return c.json({ error: 'Invalid year' }, 400);
    const stats = await adminStatsService.getStats(year);
    return c.json(stats);
  } catch (err: any) {
    console.error('[Admin/Stats] Error:', err.message);
    return c.json({ error: 'Failed to fetch stats: ' + err.message }, 500);
  }
});

export default adminStats;
