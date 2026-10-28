// ═══════════════════════════════════════════
// Banner Service — global advertising banners for the matches schedule
// ═══════════════════════════════════════════

import { asc, eq, and, or, isNull, lte, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import {
  periodsOverlap,
  validPlacement,
  BannerConflict,
  BannerPeriodError,
} from "./bannerRules";

export type BannerInput = {
  active?: boolean;
  slot?: number;
  screen?: string;
  startsOn?: string | null;
  endsOn?: string | null;
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
  async listActive(screen = "matches") {
    return db
      .select()
      .from(schema.banners)
      .where(
        and(
          eq(schema.banners.active, true),
          eq(schema.banners.screen, screen),
          or(
            isNull(schema.banners.startsOn),
            lte(
              schema.banners.startsOn,
              sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`,
            ),
          ),
          or(
            isNull(schema.banners.endsOn),
            gte(
              schema.banners.endsOn,
              sql`(now() AT TIME ZONE 'Europe/Kyiv')::date`,
            ),
          ),
        ),
      )
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
    const banner = await this.save(undefined, data);
    if (!banner) throw new Error("Banner creation failed");
    return banner;
  }

  async update(id: number, data: Partial<BannerInput>) {
    return this.save(id, data);
  }

  private async save(id: number | undefined, data: Partial<BannerInput>) {
    return db.transaction(async (tx) => {
      // Serialize placement changes so simultaneous administrators cannot book the same slot.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7492011)`);
      const rows = await tx.select().from(schema.banners);
      const existing =
        id === undefined ? undefined : rows.find((row) => row.id === id);
      if (id !== undefined && !existing) return undefined;
      const candidate = {
        active: false,
        slot: 1,
        screen: "matches",
        startsOn: null,
        endsOn: null,
        title: "",
        description: "",
        imageUrl: "",
        href: "",
        ...existing,
        ...data,
      };
      if (!validPlacement(candidate))
        throw new BannerPeriodError(
          "Завершення показу не може бути раніше початку",
        );
      if (
        candidate.active &&
        rows.some(
          (row) =>
            row.id !== id &&
            row.active &&
            row.screen === candidate.screen &&
            row.slot === candidate.slot &&
            periodsOverlap(row, candidate),
        )
      ) {
        throw new BannerConflict(
          "Цей слот уже зайнятий активним банером у вибраний період. Змініть дати, слот або вимкніть інший банер.",
        );
      }
      const values = {
        active: candidate.active,
        slot: candidate.slot,
        screen: candidate.screen,
        startsOn: candidate.startsOn,
        endsOn: candidate.endsOn,
        title: candidate.title,
        description: candidate.description,
        imageUrl: candidate.imageUrl,
        href: candidate.href,
      };
      const [banner] =
        id === undefined
          ? await tx.insert(schema.banners).values(values).returning()
          : await tx
              .update(schema.banners)
              .set(values)
              .where(eq(schema.banners.id, id))
              .returning();
      return banner;
    });
  }

  async remove(id: number): Promise<void> {
    await db.delete(schema.banners).where(eq(schema.banners.id, id));
  }
}

export const bannerService = new BannerService();
