// ═══════════════════════════════════════════
// Admin Service — self-service data reset
// ═══════════════════════════════════════════

import { db, schema, pool } from '../db/client';

export class AdminService {
  /** Delete ALL user data atomically in one transaction */
  async resetUserData(userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const counts = { bets: 0, goals: 0, strategies: 0, groups: 0, bankroll: false, riskyTeams: 0 };
      const r1 = await client.query(`DELETE FROM bets WHERE user_id = $1`, [userId]);
      counts.bets = r1.rowCount || 0;
      const r2 = await client.query(`DELETE FROM goals WHERE user_id = $1`, [userId]);
      counts.goals = r2.rowCount || 0;
      const r3 = await client.query(`DELETE FROM strategies WHERE user_id = $1`, [userId]);
      counts.strategies = r3.rowCount || 0;
      const r4 = await client.query(`DELETE FROM telegram_groups WHERE user_id = $1`, [userId]);
      counts.groups = r4.rowCount || 0;
      const r5 = await client.query(`DELETE FROM bankroll WHERE user_id = $1`, [userId]);
      counts.bankroll = (r5.rowCount || 0) > 0;
      const r6 = await client.query(`DELETE FROM risky_teams WHERE user_id = $1`, [userId]);
      counts.riskyTeams = r6.rowCount || 0;
      await client.query('COMMIT');
      return counts;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export const adminService = new AdminService();
