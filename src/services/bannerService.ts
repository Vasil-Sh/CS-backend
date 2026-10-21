// ═══════════════════════════════════════════
// Banner Service — global advertising banners for the matches schedule
// ═══════════════════════════════════════════

import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';

export type BannerInput = {
  active?: boolean;
  slot?: number;
  title: string;
  description?: string;
  imageUrl?: string;
  href?: string;
};

export class BannerService {
  /** All banners (admin). */
  async list() {
    return db.select().from(schema.banners).orderBy(asc(schema.banners.id));
  }

  /** Active banner(s) exposed to the public schedule. */
  async listActive() {
    return db
      .select()
      .from(schema.banners)
      .where(eq(schema.banners.active, true))
      .orderBy(asc(schema.banners.id));
  }

  /** Placeholder-enabled state per slot (independent of banners). */
  async listSlots() {
    return db
      .select()
      .from(schema.bannerSlots)
      .orderBy(asc(schema.bannerSlots.slot));
  }

  /** Enable/disable the demo placeholder for a slot. */
  async setSlotPlaceholder(slot: number, enabled: boolean) {
    await db
      .insert(schema.bannerSlots)
      .values({ slot, placeholderEnabled: enabled })
      .onConflictDoUpdate({
        target: schema.bannerSlots.slot,
        set: { placeholderEnabled: enabled },
      });
    return { slot, placeholderEnabled: enabled };
  }

  async create(data: BannerInput) {
    const [banner] = await db
      .insert(schema.banners)
      .values({
        active: data.active ?? false,
        slot: data.slot ?? 1,
        title: data.title,
        description: data.description || '',
        imageUrl: data.imageUrl || '',
        href: data.href || '',
      })
      .returning();
    return banner;
  }

  async update(id: number, data: Partial<BannerInput>) {
    const [banner] = await db
      .update(schema.banners)
      .set({
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.slot !== undefined ? { slot: data.slot } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
        ...(data.href !== undefined ? { href: data.href } : {}),
      })
      .where(eq(schema.banners.id, id))
      .returning();
    return banner;
  }

  async remove(id: number): Promise<void> {
    await db.delete(schema.banners).where(eq(schema.banners.id, id));
  }
}

export const bannerService = new BannerService();
