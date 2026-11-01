// ═══════════════════════════════════════════
// Auth Service — extracted from routes/auth.ts
// ═══════════════════════════════════════════

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { signToken, signRefreshToken } from '../utils/jwt';
import type { AuthResult } from './types';
import { sessionProblem, sessionProblemMessage } from './sessionRules';
import { invalidateUserState } from '../utils/userState';

export class AuthService {
  async login(username: string, password: string): Promise<AuthResult> {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (!user) return { success: false, error: 'Invalid credentials', status: 401 };

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return { success: false, error: 'Invalid credentials', status: 401 };

    const problem = sessionProblem(user.tokenVersion, { role: user.role, tokenVersion: user.tokenVersion, startDate: user.startDate, endDate: user.endDate });
    if (problem) return { success: false, error: sessionProblemMessage[problem], status: 403 };

    const claims = { userId: user.id, username: user.username, role: user.role as 'admin' | 'user', tv: user.tokenVersion };
    const token = signToken(claims);
    const refreshToken = signRefreshToken(claims);

    return {
      success: true,
      isAdmin: user.role === 'admin',
      token,
      refreshToken,
      user: { username: user.username, role: user.role, telegram: user.telegram || undefined, isOwner: user.isOwner },
      status: 200,
    };
  }

  async register(data: {
    username: string; password?: string; telegram?: string; role?: string;
    priceMonth?: string; startDate?: string; endDate?: string;
  }, actor?: {userId:number; username:string}) {
    const existing = await db.select().from(schema.users).where(eq(schema.users.username, data.username)).limit(1);
    if (existing.length > 0) return null;

    const plainPassword = data.password || generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    return db.transaction(async tx => {
    const [user] = await tx.insert(schema.users).values({
      username: data.username,
      passwordHash,
      role: data.role || 'user',
      telegram: data.telegram || '',
      priceMonth: data.priceMonth || '0',
      startDate: toPgDate(data.startDate),
      endDate: toPgDate(data.endDate),
    }).returning();

    if (actor && Number(user.priceMonth) > 0) {
      const paidOn = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const start = user.startDate || paidOn;
      const end = user.endDate || start;
      if (end < start) throw new Error('Дата завершення має бути не раніше початку підписки');
      await tx.execute(sql`INSERT INTO admin_payments(request_id,user_id,username,amount,paid_on,period_start,period_end,note,extend_subscription,created_by,created_by_name)
        VALUES(${crypto.randomUUID()},${user.id},${user.username},${user.priceMonth},${paidOn},${start},${end},'Перша оплата при створенні користувача',false,${actor.userId},${actor.username})`);
      const details=JSON.stringify({targetUsername:user.username,_targetUserId:String(user.id),amount:user.priceMonth,currency:'UAH',paidOn,periodStart:start,periodEnd:end,source:'registration'});
      await tx.execute(sql`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES(${actor.userId},${actor.username},'POST',${`/admin/users/${user.id}/payments`},${details},'success')`);
    }
    return { userId: user.id, username: user.username, password: plainPassword };
    });
  }

  /** Public register result — no password exposure */
  getRegisterResponse(id: number, username: string) {
    return { userId: id, username };
  }

  async getMe(userId: number) {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return row || null;
  }

  async listUsers() {
    return db.select({
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
      isOwner: schema.users.isOwner,
      telegram: schema.users.telegram,
      priceMonth: schema.users.priceMonth,
      startDate: schema.users.startDate,
      endDate: schema.users.endDate,
      createdAt: schema.users.createdAt,
    }).from(schema.users).orderBy(schema.users.username);
  }

  /** Role + owner flag, read fresh from the DB (JWT claims may be stale). */
  async getAccess(id: number): Promise<{ id: number; role: string; isOwner: boolean } | null> {
    const [row] = await db.select({ id: schema.users.id, role: schema.users.role, isOwner: schema.users.isOwner })
      .from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row || null;
  }

  async countOwners(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(eq(schema.users.isOwner, true));
    return Number(row?.n ?? 0);
  }

  async deleteUser(id: number) {
    await db.delete(schema.users).where(eq(schema.users.id, id));
    invalidateUserState(id);
  }

  async updateUser(id: number, data: Record<string, unknown>) {
    const updateData: Record<string, unknown> = {};
    if (data.telegram !== undefined) updateData.telegram = data.telegram;
    if (data.username !== undefined) {
      const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, String(data.username))).limit(1);
      if (existing && existing.id !== id) return null;
      updateData.username = data.username;
    }
    if (data.password) {
      updateData.passwordHash = await bcrypt.hash(String(data.password), 10);
      updateData.tokenVersion = sql`${schema.users.tokenVersion} + 1`; // log out everywhere
    }
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isOwner !== undefined) updateData.isOwner = data.isOwner;
    if (data.priceMonth !== undefined) updateData.priceMonth = data.priceMonth;
    if (data.startDate !== undefined) updateData.startDate = toPgDate(String(data.startDate));
    if (data.endDate !== undefined) updateData.endDate = toPgDate(String(data.endDate));

    const [updated] = await db.update(schema.users).set(updateData).where(eq(schema.users.id, id)).returning();
    invalidateUserState(id);
    return updated || null;
  }

  async resetPassword(id: number) {
    const newPassword = generatePassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Bumping the token version ends every existing session of this account.
    const [updated] = await db.update(schema.users)
      .set({ passwordHash, tokenVersion: sql`${schema.users.tokenVersion} + 1` })
      .where(eq(schema.users.id, id)).returning();
    invalidateUserState(id);
    if (!updated) return null;
    return { username: updated.username, password: newPassword };
  }
}

function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

/** DD/MM/YYYY or YYYY-MM-DD → YYYY-MM-DD (empty → undefined). */
export function toPgDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
  if (parts.length === 3 && parts[2]?.length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return dateStr;
}

export const authService = new AuthService();
