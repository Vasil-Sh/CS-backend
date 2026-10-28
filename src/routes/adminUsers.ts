import { pool } from '../db/client';
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { adminUsersService } from '../services/adminUsersService';

const adminUsers = new Hono();

/** GET /api/admin/users — list of all users with aggregated betting stats */
adminUsers.get('/admin/users', requireAuth, requireAdmin, async (c) => {
  try {
    const users = await adminUsersService.getUsersOverview();
    return c.json({ users });
  } catch (err: any) {
    console.error('[Admin/Users] Error:', err.message);
    return c.json({ error: 'Failed to fetch users: ' + err.message }, 500);
  }
});

/** GET /api/admin/users/:id/bets — individual bets for a single user */
adminUsers.get('/admin/users/:id/bets', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  try {
    const bets = await adminUsersService.getUserBets(id);
    return c.json({ bets });
  } catch (err: any) {
    console.error('[Admin/UserBets] Error:', err.message);
    return c.json({ error: 'Failed to fetch bets: ' + err.message }, 500);
  }
});

adminUsers.get('/admin/audit', requireAuth, requireAdmin, async (c) => {
 const page = Math.max(1, Math.min(100000, Number(c.req.query('page')) || 1));
 const offset = (Math.floor(page) - 1) * 30;
 const result = await pool.query(`SELECT a.*, COALESCE(a.details->>'targetUsername', a.details->>'username', u.username) AS target_username
 FROM admin_audit_log a
 LEFT JOIN users u ON u.id::text = substring(a.target from '^/auth/users/([0-9]+)')
 ORDER BY a.created_at DESC, a.id DESC LIMIT 31 OFFSET $1`, [offset]);
 return c.json({ entries: result.rows.slice(0,30), hasMore: result.rows.length > 30 });
});
export default adminUsers;
