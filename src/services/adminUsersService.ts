// ═══════════════════════════════════════════
// Admin Users Service — per-user betting overview
// ═══════════════════════════════════════════

import { pool } from '../db/client';
import { cache } from '../utils/cache';
import { planKey, planLabel } from './planNames';

const OVERVIEW_CACHE_KEY = 'admin:users:overview';
const OVERVIEW_TTL_MS = 15_000; // 15s — shared by users list + betting activity

export interface AdminUserOverview {
  id: number;
  username: string;
  role: string;
  telegram: string;
  /** The user has started the MatchIQ bot, so receipts can be sent to their Telegram. */
  telegramLinked: boolean;
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
  /** Dollar bets, in $ (stake/profit as entered; old records without it use amount ÷ rate). */
  usdBets: number;
  usdStaked: number;
  usdProfit: number;
  usdRoi: number;
  winRate: number;
  roi: number;
  initialBank: number;
  manualAdjustments: number;
  currentBank: number;
  /** Consecutive losses counting back from the most recent decided bet (0 if none). */
  lossStreak: number;
  /** Stored plan key (trial/basic/pro). */
  plan: string;
  /** Human-readable plan label (Пробний/Базова/Pro). */
  planLabel: string;
  /** Trial end date ('' if none). */
  trialEndDate: string;
  /** Whether the user's age has been verified. */
  ageConfirmed: boolean;
  /** Date of the user's most recent bet ('' if none). */
  lastBetDate: string;
  /** ISO timestamp of the user's most recent bet ('' if none). */
  lastBetAt: string;
  /** Number of subscription extensions (payments with extend_subscription). */
  extensions: number;
  /** Date of the user's most recent payment ('' if none). */
  lastPaymentDate: string;
  /** Per-game aggregated stats (profit/ROI separately for CS2, Dota2, …). */
  games: GameBreakdown[];
  /** Owner flag (admins only). */
  isOwner: boolean;
  /** Birth date YYYY-MM-DD ('' if not given). */
  birthDate: string;
  /** Sum and count of recorded (not cancelled/refunded) payments. */
  paidTotal: number;
  paidCount: number;
  /** Amount of the most recent payment of any status (0 if none). */
  lastPaymentAmount: number;
  /** Most recent payment was cancelled or refunded: when, and how much was refunded. */
  cancelledAt: string;
  refundedAmount: number;
  /** Active self-limitation: blocked until (ISO), '' if none. */
  selfLimitedUntil: string;
  /** AI analyses used today (Europe/Kyiv). */
  aiToday: number;
  /** Temporary Pro granted by an admin: until (YYYY-MM-DD) and the plan it returns to. */
  proUntil: string;
  proBasePlan: string;
  /** Subscription cancelled by an admin: when and how (end of period / now). */
  subscriptionCancelledAt: string;
  subscriptionCancelMode: string;
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
  originalAmount: number | null;
  originalProfit: number | null;
  exchangeRate: number | null;
  strategy: string;
  createdAt: string;
}

export class AdminUsersService {
  async getUsersOverview(): Promise<AdminUserOverview[]> {
    const cached = cache.get<AdminUserOverview[]>(OVERVIEW_CACHE_KEY);
    if (cached) return cached;

    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          u.id,
          u.username,
          u.role,
          u.telegram,
          (u.telegram_chat_id IS NOT NULL) AS telegram_linked,
          u.price_month::numeric AS price_month,
          u.plan,
          u.trial_end_date::text AS trial_end_date,
          u.age_confirmed,
          u.is_owner,
          u.birth_date::text AS birth_date,
          u.pro_until::text AS pro_until,
          u.pro_base_plan,
          u.subscription_cancelled_at,
          u.subscription_cancel_mode,
          u.start_date::text AS start_date,
          u.end_date::text AS end_date,
          u.created_at,
          COUNT(b.id)::int AS bet_count,
          COALESCE(SUM(CASE WHEN b.result = 'Win' THEN 1 ELSE 0 END)::int, 0) AS wins,
          COALESCE(SUM(CASE WHEN b.result = 'Loss' THEN 1 ELSE 0 END)::int, 0) AS losses,
          COALESCE(SUM(CASE WHEN b.result = 'Pending' THEN 1 ELSE 0 END)::int, 0) AS pending,
          -- ₴ totals count hryvnia bets only; dollar bets get their own totals in $ (as in the app)
          COALESCE(SUM(b.amount) FILTER (WHERE upper(coalesce(NULLIF(b.currency,''),'UAH')) <> 'USD'), 0)::numeric AS total_staked,
          COALESCE(SUM(b.profit) FILTER (WHERE upper(coalesce(NULLIF(b.currency,''),'UAH')) <> 'USD'), 0)::numeric AS total_profit,
          COALESCE(SUM(b.profit)::numeric, 0) AS total_profit_all,
          COUNT(b.id) FILTER (WHERE upper(coalesce(b.currency,'')) = 'USD')::int AS usd_bets,
          COALESCE(SUM(COALESCE(b.original_amount, b.amount / NULLIF(b.exchange_rate, 0))) FILTER (WHERE upper(coalesce(b.currency,'')) = 'USD'), 0)::numeric AS usd_staked,
          COALESCE(SUM(COALESCE(b.original_profit, b.profit / NULLIF(b.exchange_rate, 0))) FILTER (WHERE upper(coalesce(b.currency,'')) = 'USD' AND b.result IN ('Win', 'Loss')), 0)::numeric AS usd_profit,
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
               COALESCE(SUM(amount) FILTER (WHERE upper(coalesce(NULLIF(currency,''),'UAH')) <> 'USD'), 0)::numeric AS staked,
               COALESCE(SUM(profit) FILTER (WHERE upper(coalesce(NULLIF(currency,''),'UAH')) <> 'USD'), 0)::numeric AS profit
        FROM bets
        GROUP BY user_id, COALESCE(NULLIF(game, ''), 'CS2')
        ORDER BY user_id, game
      `);

      // Last bet date per user (for churn/inactive analysis).
      const lastBetResult = await client.query(
        `SELECT user_id, MAX(date)::text AS last_bet_date, MAX(created_at) AS last_bet_at FROM bets GROUP BY user_id`
      );

      // Extension history per user: how many times extended, last payment date.
      const paymentsResult = await client.query(
        `SELECT user_id,
                COUNT(*) FILTER (WHERE extend_subscription = true)::int AS extensions,
                MAX(paid_on)::text AS last_payment_date
         FROM admin_payments WHERE user_id IS NOT NULL GROUP BY user_id`
      );

      // Payment totals + the latest payment (to tell a cancelled/refunded subscription).
      const paidResult = await client.query(
        `SELECT user_id,
                COALESCE(SUM(amount) FILTER (WHERE status='recorded'),0)::numeric AS paid_total,
                COUNT(*) FILTER (WHERE status='recorded')::int AS paid_count
           FROM admin_payments WHERE user_id IS NOT NULL GROUP BY user_id`
      );
      const lastPayResult = await client.query(
        `SELECT DISTINCT ON (user_id) user_id, amount::numeric AS amount, status,
                COALESCE(refunded_at, cancelled_at) AS ended_at, COALESCE(refunded_amount,0)::numeric AS refunded
           FROM admin_payments WHERE user_id IS NOT NULL
          ORDER BY user_id, paid_on DESC, id DESC`
      );
      const selfLimResult = await client.query(
        `SELECT user_id, MAX(until) AS until FROM tilt_blocks
          WHERE reason = 'Самообмеження користувача' AND until > now() GROUP BY user_id`
      ).catch(() => ({ rows: [] as any[] }));
      const aiTodayResult = await client.query(
        `SELECT user_id, COUNT(*)::int AS n FROM ai_usage
          WHERE user_id IS NOT NULL AND created_at >= (now() AT TIME ZONE 'Europe/Kyiv')::date GROUP BY user_id`
      ).catch(() => ({ rows: [] as any[] }));
      const paidMap = new Map<number, { total: number; count: number }>();
      paidResult.rows.forEach((r: any) => paidMap.set(Number(r.user_id), { total: Number(r.paid_total), count: Number(r.paid_count) }));
      const lastPayMap = new Map<number, { amount: number; status: string; endedAt: string; refunded: number }>();
      lastPayResult.rows.forEach((r: any) => lastPayMap.set(Number(r.user_id), {
        amount: Number(r.amount), status: r.status, refunded: Number(r.refunded),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : '',
      }));
      const selfLimMap = new Map<number, string>();
      selfLimResult.rows.forEach((r: any) => selfLimMap.set(Number(r.user_id), new Date(r.until).toISOString()));
      const aiTodayMap = new Map<number, number>();
      aiTodayResult.rows.forEach((r: any) => aiTodayMap.set(Number(r.user_id), Number(r.n)));

      const lossStreakMap = new Map<number, number>();
      streakResult.rows.forEach((r: any) =>
        lossStreakMap.set(Number(r.user_id), Number(r.loss_streak)),
      );

      const lastBetMap = new Map<number, { date: string; at: string }>();
      lastBetResult.rows.forEach((r: any) =>
        lastBetMap.set(Number(r.user_id), {
          date: r.last_bet_date || '',
          at: r.last_bet_at ? new Date(r.last_bet_at).toISOString() : '',
        }),
      );

      const paymentsMap = new Map<number, { extensions: number; lastPaymentDate: string }>();
      paymentsResult.rows.forEach((r: any) =>
        paymentsMap.set(Number(r.user_id), {
          extensions: Number(r.extensions),
          lastPaymentDate: r.last_payment_date || '',
        }),
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

      const overview = result.rows.map((r: any) => {
        const wins = Number(r.wins);
        const losses = Number(r.losses);
        const decided = wins + losses;
        const totalStaked = Number(r.total_staked);
        const totalProfit = Number(r.total_profit);
        const usdStaked = Math.round(Number(r.usd_staked) * 100) / 100;
        const usdProfit = Math.round(Number(r.usd_profit) * 100) / 100;
        const initialBank = Number(r.initial_bank);
        const manual = Number(r.manual_adjustments);

        return {
          id: r.id,
          username: r.username,
          role: r.role,
          telegram: r.telegram || '',
          telegramLinked: !!r.telegram_linked,
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
          usdBets: Number(r.usd_bets) || 0,
          usdStaked,
          usdProfit,
          usdRoi: usdStaked > 0 ? Math.round((usdProfit / usdStaked) * 1000) / 10 : 0,
          // The bank is kept in ₴: dollar bets count at the rate they were saved with
          currentBank: initialBank + manual + Number(r.total_profit_all),
          lossStreak: lossStreakMap.get(r.id) || 0,
          plan: planKey(r.plan),
          planLabel: planLabel(r.plan),
          trialEndDate: r.trial_end_date || '',
          ageConfirmed: Boolean(r.age_confirmed),
          lastBetDate: lastBetMap.get(r.id)?.date || '',
          lastBetAt: lastBetMap.get(r.id)?.at || '',
          extensions: paymentsMap.get(r.id)?.extensions || 0,
          lastPaymentDate: paymentsMap.get(r.id)?.lastPaymentDate || '',
          games: gamesMap.get(r.id) || [],
          isOwner: Boolean(r.is_owner),
          birthDate: r.birth_date || '',
          paidTotal: paidMap.get(r.id)?.total || 0,
          paidCount: paidMap.get(r.id)?.count || 0,
          lastPaymentAmount: lastPayMap.get(r.id)?.amount || 0,
          cancelledAt: lastPayMap.get(r.id) && lastPayMap.get(r.id)!.status !== 'recorded' ? lastPayMap.get(r.id)!.endedAt : '',
          refundedAmount: lastPayMap.get(r.id)?.status === 'refunded' ? lastPayMap.get(r.id)!.refunded : 0,
          selfLimitedUntil: selfLimMap.get(r.id) || '',
          aiToday: aiTodayMap.get(r.id) || 0,
          proUntil: r.pro_until || '',
          proBasePlan: r.pro_base_plan || '',
          subscriptionCancelledAt: r.subscription_cancelled_at ? new Date(r.subscription_cancelled_at).toISOString() : '',
          subscriptionCancelMode: r.subscription_cancel_mode || '',
        };
      });
      cache.set(OVERVIEW_CACHE_KEY, overview, OVERVIEW_TTL_MS);
      return overview;
    } finally {
      client.release();
    }
  }

  /** Invalidate the overview cache (call after user/bet mutations). */
  invalidateOverview(): void {
    cache.del(OVERVIEW_CACHE_KEY);
  }

  async getUserBets(userId: number): Promise<AdminUserBet[]> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
           id, match, team1, team2, bet_type, odds, amount, stake,
           date::text AS date, result, profit, game, currency, strategy, created_at,
           original_amount, original_profit, exchange_rate
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
        originalAmount: r.original_amount == null ? null : Number(r.original_amount),
        originalProfit: r.original_profit == null ? null : Number(r.original_profit),
        exchangeRate: r.exchange_rate == null ? null : Number(r.exchange_rate),
        strategy: r.strategy || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
      }));
    } finally {
      client.release();
    }
  }
}

export const adminUsersService = new AdminUsersService();
