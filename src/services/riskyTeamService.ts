// ═══════════════════════════════════════════
// Risky Team Service — extracted from routes/riskyTeams.ts
// ═══════════════════════════════════════════

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class RiskyTeamService {
  async list(userId: number) {
    return db.select().from(schema.riskyTeams)
      .where(eq(schema.riskyTeams.userId, userId))
      .orderBy(schema.riskyTeams.name);
  }

  async create(userId: number, data: { name: string; game?: string; status?: string; notes?: string }) {
    const [existing] = await db.select().from(schema.riskyTeams)
      .where(eq(schema.riskyTeams.name, data.name))
      .limit(1);
    if (existing) return null;
    const [team] = await db.insert(schema.riskyTeams)
      .values({ userId, name: data.name, game: data.game || '', status: data.status || '', notes: data.notes || '' })
      .returning();
    return team;
  }

  async remove(id: number): Promise<void> {
    await db.delete(schema.riskyTeams).where(eq(schema.riskyTeams.id, id));
  }
}

export const riskyTeamService = new RiskyTeamService();
