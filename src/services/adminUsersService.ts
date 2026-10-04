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
  /** Consecutive losses counting back from the most recent decided bet (0 if none). */
  lossStreak: number;
  /** Per-game aggregated stats (profit/ROI separately for CS2, Dota2, …). */
  games: GameBreakdown[];
}

export interface GameBreakdown {
  game: string;
  bets: number;
  wins: number;
  losses: number;
  pending: number;
  staked: number;
  profit: number;
  winRate: number;
  roi: number;
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

      // Current loss streak per user (consecutive `Loss` from the most recent
      // decided bet; a Win or Pending breaks the streak).
      const streakResult = await client.query(`
        WITH ranked AS (
          SELECT user_id, result,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date DESC, created_at DESC) AS rn
          FROM bets
        ),
        streaks AS (
          SELECT user_id, result, rn,
                 SUM(CASE WHEN result <> 'Loss' THEN 1 ELSE 0 END)
                   OVER (PARTITION BY user_id ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
          FROM ranked
        )
        SELECT user_id, COUNT(*)::int AS loss_streak
        FROM streaks
        WHERE grp = 0 AND result = 'Loss'
        GROUP BY user_id
      `);

      // Per-game breakdown (profit/ROI separately for CS2, Dota2, etc.)
      const gamesResult = await client.query(`
        SELECT user_id,
               COALESCE(NULLIF(game, ''), 'CS2') AS game,
               COUNT(*)::int AS bets,
               COUNT(*) FILTER (WHERE result = 'Win')::int AS wins,
               COUNT(*) FILTER (WHERE result = 'Loss')::int AS losses,
               COUNT(*) FILTER (WHERE result = 'Pending')::int AS pending,
               COALESCE(SUM(amount)::numeric, 0) AS staked,
               COALESCE(SUM(profit)::numeric, 0) AS profit
        FROM bets
        GROUP BY user_id, COALESCE(NULLIF(game, ''), 'CS2')
        ORDER BY user_id, game
      `);

      const lossStreakMap = new Map<number, number>();
      streakResult.rows.forEach((r: any) =>
        lossStreakMap.set(Number(r.user_id), Number(r.loss_streak)),
      );

      const gamesMap = new Map<number, GameBreakdown[]>();
      gamesResult.rows.forEach((r: any) => {
        const uid = Number(r.user_id);
        const list = gamesMap.get(uid) || [];
        const wins = Number(r.wins);
        const losses = Number(r.losses);
        const decided = wins + losses;
        const staked = Number(r.staked);
        const profit = Number(r.profit);
        list.push({
          game: r.game,
          bets: Number(r.bets),
          wins,
          losses,
          pending: Number(r.pending),
          staked,
          profit,
          winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0,
          roi: staked > 0 ? Math.round((profit / staked) * 1000) / 10 : 0,
        });
        gamesMap.set(uid, list);
      });

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
          lossStreak: lossStreakMap.get(r.id) || 0,
          games: gamesMap.get(r.id) || [],
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
