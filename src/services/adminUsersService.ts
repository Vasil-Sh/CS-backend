// ═══════════════════════════════════════════
// Admin Users Service — per-user betting overview
// ═══════════════════════════════════════════

import { pool } from '../db/client';

export interface AdminUserOverview {
  id: number;
  username: string;
  role: string;
  telegram: string;
  priceMonth: number;
  startDate: string;
  endDate: string;
  createdAt: string;
  betCount: number;
  wins: number;
  losses: number;
  pending: number;
  totalStaked: number;
  totalProfit: number;
  winRate: number;
  roi: number;
  initialBank: number;
  manualAdjustments: number;
  currentBank: number;
}

export interface AdminUserBet {
  id: string;
  match: string;
  team1: string;
  team2: string;
  betType: string;
  odds: number;
  amount: number;
  stake: number | null;
  date: string;
  result: string;
  profit: number;
  game: string;
  currency: string;
  strategy: string;
  createdAt: string;
}

export class AdminUsersService {
  async getUsersOverview(): Promise<AdminUserOverview[]> {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          u.id,
          u.username,
          u.role,
          u.telegram,
          u.price_month::numeric AS price_month,
          u.start_date::text AS start_date,
          u.end_date::text AS end_date,
          u.created_at,
          COUNT(b.id)::int AS bet_count,
          COALESCE(SUM(CASE WHEN b.result = 'Win' THEN 1 ELSE 0 END)::int, 0) AS wins,
          COALESCE(SUM(CASE WHEN b.result = 'Loss' THEN 1 ELSE 0 END)::int, 0) AS losses,
          COALESCE(SUM(CASE WHEN b.result = 'Pending' THEN 1 ELSE 0 END)::int, 0) AS pending,
          COALESCE(SUM(b.amount)::numeric, 0) AS total_staked,
          COALESCE(SUM(b.profit)::numeric, 0) AS total_profit,
          COALESCE(br.initial_bank::numeric, 0) AS initial_bank,
          COALESCE(br.manual_adjustments::numeric, 0) AS manual_adjustments
        FROM users u
        LEFT JOIN bets b ON b.user_id = u.id
        LEFT JOIN bankroll br ON br.user_id = u.id
        GROUP BY u.id, br.initial_bank, br.manual_adjustments
        ORDER BY u.created_at DESC
      `);

      return result.rows.map((r: any) => {
        const wins = Number(r.wins);
        const losses = Number(r.losses);
        const decided = wins + losses;
        const totalStaked = Number(r.total_staked);
        const totalProfit = Number(r.total_profit);
        const initialBank = Number(r.initial_bank);
        const manual = Number(r.manual_adjustments);

        return {
          id: r.id,
          username: r.username,
          role: r.role,
          telegram: r.telegram || '',
          priceMonth: Number(r.price_month),
          startDate: r.start_date || '',
          endDate: r.end_date || '',
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
          betCount: Number(r.bet_count),
          wins,
          losses,
          pending: Number(r.pending),
          totalStaked,
          totalProfit,
          winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0,
          roi: totalStaked > 0 ? Math.round((totalProfit / totalStaked) * 1000) / 10 : 0,
          initialBank,
          manualAdjustments: manual,
          currentBank: initialBank + manual + totalProfit,
        };
      });
    } finally {
      client.release();
    }
  }

  async getUserBets(userId: number): Promise<AdminUserBet[]> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
           id, match, team1, team2, bet_type, odds, amount, stake,
           date::text AS date, result, profit, game, currency, strategy, created_at
         FROM bets
         WHERE user_id = $1
         ORDER BY date DESC, created_at DESC`,
        [userId],
      );

      return result.rows.map((r: any) => ({
        id: r.id,
        match: r.match,
        team1: r.team1 || '',
        team2: r.team2 || '',
        betType: r.bet_type,
        odds: Number(r.odds),
        amount: Number(r.amount),
        stake: r.stake == null ? null : Number(r.stake),
        date: r.date || '',
        result: r.result,
        profit: Number(r.profit),
        game: r.game || '',
        currency: r.currency || '',
        strategy: r.strategy || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
      }));
    } finally {
      client.release();
    }
  }
}

export const adminUsersService = new AdminUsersService();
