// ═══════════════════════════════════════════
// Goal Service — extracted from routes/goals.ts
// ═══════════════════════════════════════════

import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client';

export class GoalService {
  async list(userId: number) {
    return db.select().from(schema.goals).where(eq(schema.goals.userId, userId));
  }

  async create(userId: number, body: Record<string, any>) {
    const target = body.targetAmount ?? body.targetLadderAmount ?? body.targetROI ?? body.targetWinRate ?? body.target ?? 0;
    const [goal] = await db.insert(schema.goals).values({
      userId,
      type: body.type === 'winrate' ? 'winrate' : body.type,
      name: body.name || '',
      target: target.toString(),
      current: body.current?.toString() || '0',
      deadline: body.deadline || null,
      isCompleted: body.isCompleted || false,
      config: body.config || body,
    }).returning();
    return goal;
  }

  async getOwned(id: string, userId: number) {
    const [row] = await db.select().from(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, userId))).limit(1);
    return row || null;
  }

  async update(id: string, userId: number, body: Record<string, any>) {
    const existing = await this.getOwned(id, userId);
    if (!existing) return null;

    const data: Record<string, any> = {};
    if (body.type !== undefined) data.type = body.type;
    if (body.name !== undefined) data.name = body.name;
    if (body.config !== undefined) data.config = body.config;
    if (body.target !== undefined) data.target = body.target.toString();
    if (body.current !== undefined) data.current = body.current.toString();
    if (body.deadline !== undefined) data.deadline = body.deadline;
    if (body.isCompleted !== undefined) data.isCompleted = body.isCompleted;

    const [updated] = await db.update(schema.goals).set(data).where(eq(schema.goals.id, id)).returning();
    return updated;
  }

  async remove(id: string, userId: number): Promise<boolean> {
    const [found] = await db.select().from(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, userId))).limit(1);
    if (!found) return false;
    await db.delete(schema.goals).where(eq(schema.goals.id, found.id));
    return true;
  }
}

export const goalService = new GoalService();
