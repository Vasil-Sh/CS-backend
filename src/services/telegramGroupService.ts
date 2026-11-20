// ═══════════════════════════════════════════
// Telegram Group Service — extracted from routes/telegramGroups.ts
// ═══════════════════════════════════════════

import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { screenText } from './groupScreening';

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
    // an approved group whose new name/description looks like selling fixed matches or a scam goes back to review
    const nextText = `${fields.name ?? found.name} ${fields.comment ?? found.comment ?? ''}`;
    const backToReview = found.moderationStatus === 'approved' && (fields.name !== undefined || fields.comment !== undefined) && screenText(nextText).length > 0;
    const [group] = await db
      .update(schema.telegramGroups)
      .set({
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.link !== undefined ? { link: fields.link } : {}),
        ...(fields.hasChannel !== undefined ? { hasChannel: fields.hasChannel } : {}),
        ...(fields.comment !== undefined ? { comment: fields.comment } : {}),
        ...(fields.game !== undefined ? { game: fields.game } : {}),
        ...(backToReview ? { moderationStatus: 'pending', reviewedBy: null, reviewedAt: null } : {}),
      })
      .where(and(eq(schema.telegramGroups.id, id), eq(schema.telegramGroups.userId, userId)))
      .returning();
    return group;
  }
}

export const telegramGroupService = new TelegramGroupService();
