// ═══════════════════════════════════════════
// Telegram Group Service — extracted from routes/telegramGroups.ts
// ═══════════════════════════════════════════

import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class TelegramGroupService {
  async list(userId: number) {
    return db.select().from(schema.telegramGroups).where(eq(schema.telegramGroups.userId, userId)).orderBy(schema.telegramGroups.name);
  }

  async create(userId: number, name: string, link: string, hasChannel: boolean = false, comment: string = '', game: string = '') {
    const [group] = await db.insert(schema.telegramGroups).values({ userId, name, link, hasChannel, comment, game }).returning();
    return group;
  }

  async remove(id: string, userId: number): Promise<boolean> {
    const [found] = await db.select().from(schema.telegramGroups).where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId))).limit(1);
    if (!found) return false;
    await db.delete(schema.telegramGroups).where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId)));
    return true;
  }

  async update(
    id: string,
    userId: number,
    fields: { name?: string; link?: string; hasChannel?: boolean; comment?: string; game?: string },
  ) {
    const [found] = await db.select().from(schema.telegramGroups).where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId))).limit(1);
    if (!found) return null;
    const [group] = await db
      .update(schema.telegramGroups)
      .set({
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.link !== undefined ? { link: fields.link } : {}),
        ...(fields.hasChannel !== undefined ? { hasChannel: fields.hasChannel } : {}),
        ...(fields.comment !== undefined ? { comment: fields.comment } : {}),
        ...(fields.game !== undefined ? { game: fields.game } : {}),
      })
      .where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId)))
      .returning();
    return group;
  }
}

export const telegramGroupService = new TelegramGroupService();
