// ═══════════════════════════════════════════
// Strategy Service — extracted from routes/strategies.ts
// ═══════════════════════════════════════════

import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class StrategyService {
  async list(userId: number) {
    return db.select().from(schema.strategies).where(eq(schema.strategies.userId, userId));
  }

  async create(userId: number, body: { name: string; isPrimary?: boolean; config?: Record<string, unknown> }) {
    if (body.isPrimary) {
      await db.update(schema.strategies).set({ isPrimary: false }).where(eq(schema.strategies.userId, userId));
    }
    const [s] = await db.insert(schema.strategies).values({
      userId,
      name: body.name,
      isPrimary: body.isPrimary ?? false,
      config: body.config && Object.keys(body.config).length > 0 ? body.config : body,
    }).returning();
    return s;
  }

  async getOwned(id: string, userId: number) {
    const [row] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.id, id), eq(schema.strategies.userId, userId))).limit(1);
    return row || null;
  }

  async update(id: string, userId: number, body: Record<string, any>) {
    const existing = await this.getOwned(id, userId);
    if (!existing) return null;
    if (body.isPrimary) {
      await db.update(schema.strategies).set({ isPrimary: false }).where(eq(schema.strategies.userId, userId));
    }
    const data: Record<string, any> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.isPrimary !== undefined) data.isPrimary = body.isPrimary;
    if (body.config !== undefined) data.config = body.config;
    const [updated] = await db.update(schema.strategies).set(data).where(eq(schema.strategies.id, id)).returning();
    return updated;
  }

  async remove(id: string, userId: number, name?: string): Promise<boolean> {
    let [found] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.id, id), eq(schema.strategies.userId, userId))).limit(1);
    if (!found && name) {
      [found] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.name, name), eq(schema.strategies.userId, userId))).limit(1);
    }
    if (!found) return false;
    await db.delete(schema.strategies).where(eq(schema.strategies.id, found.id));
    return true;
  }
}

export const strategyService = new StrategyService();
