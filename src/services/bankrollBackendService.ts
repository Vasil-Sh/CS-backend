// ═══════════════════════════════════════════
// Bankroll Service (backend) — extracted from routes/bankroll.ts
// ═══════════════════════════════════════════

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class BankrollBackendService {
  async getOrCreate(userId: number) {
    const [row] = await db.select().from(schema.bankroll).where(eq(schema.bankroll.userId, userId)).limit(1);
    if (!row) {
      const [created] = await db.insert(schema.bankroll).values({
        userId,
        initialBank: '0',
        manualAdjustments: '0',
      }).returning();
      return created;
    }
    return row;
  }

  async get(userId: number) {
    const [row] = await db.select().from(schema.bankroll).where(eq(schema.bankroll.userId, userId)).limit(1);
    return row || null;
  }

  async setInitialBank(userId: number, amount: number) {
    const existing = await this.get(userId);
    if (existing) {
      const [updated] = await db.update(schema.bankroll)
        .set({ initialBank: amount.toString() })
        .where(eq(schema.bankroll.userId, userId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(schema.bankroll)
      .values({ userId, initialBank: amount.toString(), manualAdjustments: '0' })
      .returning();
    return created;
  }

  async adjust(userId: number, amount: number) {
    const existing = await this.get(userId);
    if (!existing) return null;
    const newAdjustments = parseFloat(existing.manualAdjustments || '0') + amount;
    const [updated] = await db.update(schema.bankroll)
      .set({ manualAdjustments: newAdjustments.toString() })
      .where(eq(schema.bankroll.userId, userId))
      .returning();
    return updated;
  }

  async getStats(userId: number) {
    const row = await this.get(userId);
    if (!row) return { initialBank: 0, manualAdjustments: 0, currentBank: 0, totalProfit: 0, roi: 0 };

    const bets = await db.select().from(schema.bets).where(eq(schema.bets.userId, userId));
    const totalProfit = bets.filter(b => b.result !== 'Pending').reduce((sum, b) => sum + parseFloat(b.profit || '0'), 0);
    const initialBank = parseFloat(row.initialBank || '0');
    const manualAdjustments = parseFloat(row.manualAdjustments || '0');
    const currentBank = initialBank + totalProfit + manualAdjustments;
    const roi = initialBank > 0 ? (totalProfit / initialBank) * 100 : 0;

    return { initialBank, manualAdjustments, currentBank, totalProfit, roi: Math.round(roi * 100) / 100 };
  }
}

export const bankrollBackendService = new BankrollBackendService();
