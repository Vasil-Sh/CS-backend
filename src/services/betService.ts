// ═══════════════════════════════════════════
// Bet Service — business logic extracted from routes
// ═══════════════════════════════════════════

import { eq, desc, and, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { cache } from '../utils/cache';
import type { BetStats, BetPagination } from './types';
import type { CreateBetInput, UpdateBetInput } from '../middleware/validation';

export class BetService {
  /** Invalidate all cached bet data for a user */
  invalidateCache(userId: number): void {
    cache.delByPrefix(`bets:${userId}`);
    cache.del(`stats:${userId}`);
  }

  /** Normalize goalId: empty/'all'/whitespace → null */
  static cleanGoalId(id?: string): string | null {
    if (!id || id === 'all' || !id.trim()) return null;
    return id;
  }

  /** Get paginated bets for a user */
  async getBets(userId: number, page: number, limit: number): Promise<BetPagination> {
    const cacheKey = `bets:${userId}:${page}:${limit}`;
    const cached = cache.get<BetPagination>(cacheKey);
    if (cached) return cached;

    const offset = (page - 1) * limit;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.bets)
      .where(eq(schema.bets.userId, userId));

    const rows = await db
      .select()
      .from(schema.bets)
      .where(eq(schema.bets.userId, userId))
      .orderBy(desc(schema.bets.date), desc(schema.bets.createdAt))
      .limit(limit)
      .offset(offset);

    const result = { rows, total: count, page, limit };
    cache.set(cacheKey, result, 15_000); // 15s TTL
    return result;
  }

  /** Create a bet */
  async createBet(userId: number, body: CreateBetInput) {
    this.invalidateCache(userId);

    const data = this.buildBetData(userId, body);
    const [bet] = await db.insert(schema.bets).values(data as any).returning();
    return bet;
  }

  /** Get bet by ID, verifying ownership */
  async getOwnedBet(id: string, userId: number) {
    const [row] = await db
      .select()
      .from(schema.bets)
      .where(and(eq(schema.bets.id, id), eq(schema.bets.userId, userId)))
      .limit(1);
    return row || null;
  }

  /** Update a bet */
  async updateBet(id: string, userId: number, body: UpdateBetInput) {
    this.invalidateCache(userId);

    const existing = await this.getOwnedBet(id, userId);
    if (!existing) return null;

    const updateData = this.buildUpdateData(body);
    const [updated] = await db
      .update(schema.bets)
      .set(updateData)
      .where(eq(schema.bets.id, id))
      .returning();
    return updated;
  }

  /** Delete a bet */
  async deleteBet(id: string, userId: number): Promise<boolean> {
    this.invalidateCache(userId);

    const existing = await this.getOwnedBet(id, userId);
    if (!existing) return false;

    await db.delete(schema.bets).where(eq(schema.bets.id, id));
    return true;
  }

  /** Get aggregated stats for user */
  async getStats(userId: number): Promise<BetStats> {
    const cached = cache.get<BetStats>(`stats:${userId}`);
    if (cached) return cached;

    const [totals] = await db
      .select({
        totalBets: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${schema.bets.result} = 'Win')::int`,
        totalProfit: sql<number>`coalesce(sum(
          case when ${schema.bets.result} != 'Pending' then ${schema.bets.profit} else 0 end
        ), 0)::float`,
        totalRoi: sql<number>`coalesce(avg(
          case when ${schema.bets.result} != 'Pending' then ${schema.bets.roi} else null end
        ), 0)::float`,
      })
      .from(schema.bets)
      .where(eq(schema.bets.userId, userId));

    cache.set(`stats:${userId}`, totals, 30_000);
    return totals;
  }

  /** Get profit aggregated by month (YYYY-MM format) */
  async getProfitByMonth(userId: number): Promise<{ month: string; profit: number }[]> {
    const rows = await db
      .select({
        month: sql<string>`to_char(${schema.bets.date}, 'YYYY-MM')`,
        profit: sql<number>`coalesce(sum(
          case when ${schema.bets.result} != 'Pending' then ${schema.bets.profit} else 0 end
        ), 0)::float`,
      })
      .from(schema.bets)
      .where(eq(schema.bets.userId, userId))
      .groupBy(sql`to_char(${schema.bets.date}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${schema.bets.date}, 'YYYY-MM')`);
    return rows.map(r => ({ month: r.month as string, profit: Number(r.profit) }));
  }

  /** Get profit aggregated by strategy name */
  async getProfitByStrategy(userId: number): Promise<{ strategy: string; profit: number }[]> {
    const rows = await db
      .select({
        strategy: sql<string>`coalesce(${schema.bets.strategy}, 'Без стратегії')`,
        profit: sql<number>`coalesce(sum(
          case when ${schema.bets.result} != 'Pending' then ${schema.bets.profit} else 0 end
        ), 0)::float`,
      })
      .from(schema.bets)
      .where(eq(schema.bets.userId, userId))
      .groupBy(schema.bets.strategy);
    return rows.map(r => ({ strategy: r.strategy as string, profit: Number(r.profit) }));
  }

  // ── Private helpers ──

  private buildBetData(userId: number, body: CreateBetInput): Record<string, unknown> {
    return {
      userId,
      match: body.match,
      team1: body.team1 || '',
      team2: body.team2 || '',
      betType: body.betType,
      odds: body.odds.toString(),
      amount: body.amount.toString(),
      stake: body.stake?.toString(),
      date: body.date || new Date().toISOString().split('T')[0],
      result: body.result,
      profit: body.profit?.toString() || '0',
      strategy: body.strategy || '',
      format: body.format || '',
      game: body.game || 'CS2',
      currency: body.currency || 'UAH',
      originalAmount: body.originalAmount?.toString(),
      exchangeRate: body.exchangeRate?.toString(),
      originalProfit: body.originalProfit?.toString(),
      roi: body.roi?.toString(),
      goalId: BetService.cleanGoalId(body.goalId),
      selection: body.selection || '',
      matchUrl: body.matchUrl || '',
      winProbability: body.winProbability?.toString() || undefined,
      risk: body.risk || '',
      notes: body.notes || '',
      riskyTeams: body.riskyTeams || [],
      tournament: body.tournament || '',
      logoTeam1: body.logoTeam1,
      logoTeam2: body.logoTeam2,
      expressLogos: body.expressLogos || [],
    };
  }

  private buildUpdateData(body: UpdateBetInput): Record<string, unknown> {
    const NUMERIC = new Set(['profit','odds','amount','roi','stake','originalAmount','exchangeRate','originalProfit','winProbability']);
    const PASSTHROUGH = new Set(['result','notes','strategy','risk','match','team1','team2','betType','date','format','game','currency','goalId','selection','matchUrl','riskyTeams','tournament','logoTeam1','logoTeam2','expressLogos']);
    const data: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (NUMERIC.has(key)) data[key] = value?.toString();
      else if (PASSTHROUGH.has(key)) data[key] = value;
    }
    return data;
  }
}

export const betService = new BetService();
