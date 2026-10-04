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

export default adminUsers;
