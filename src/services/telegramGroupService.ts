// ═══════════════════════════════════════════
// Telegram Group Service — extracted from routes/telegramGroups.ts
// ═══════════════════════════════════════════

import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class TelegramGroupService {
  async list(userId: number) {
    return db.select().from(schema.telegramGroups).where(eq(schema.telegramGroups.userId, userId)).orderBy(schema.telegramGroups.name);
  }

  async create(userId: number, name: string, link: string) {
    const [group] = await db.insert(schema.telegramGroups).values({ userId, name, link }).returning();
    return group;
  }

  async remove(id: string, userId: number): Promise<boolean> {
    const [found] = await db.select().from(schema.telegramGroups).where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId))).limit(1);
    if (!found) return false;
    await db.delete(schema.telegramGroups).where(eq(schema.telegramGroups.id, id));
    return true;
  }
}

export const telegramGroupService = new TelegramGroupService();
