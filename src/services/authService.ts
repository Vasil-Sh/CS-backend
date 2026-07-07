// ═══════════════════════════════════════════
// Auth Service — extracted from routes/auth.ts
// ═══════════════════════════════════════════

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { signToken, signRefreshToken } from '../utils/jwt';
import type { AuthResult } from './types';

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

    if (user.role !== 'admin' && user.endDate) {
      const now = new Date();
      const end = new Date(user.endDate);
      if (end < now) return { success: false, error: 'Subscription expired', status: 403 };
    }

    const token = signToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });
    const refreshToken = signRefreshToken({ userId: user.id, username: user.username, role: user.role as 'admin' | 'user' });

    return {
      success: true,
      isAdmin: user.role === 'admin',
      token,
      refreshToken,
      user: { username: user.username, role: user.role, telegram: user.telegram || undefined },
      status: 200,
    };
  }

  async register(data: {
    username: string; password?: string; telegram?: string; role?: string;
    priceMonth?: string; endDate?: string;
  }) {
    const existing = await db.select().from(schema.users).where(eq(schema.users.username, data.username)).limit(1);
    if (existing.length > 0) return null;

    const plainPassword = data.password || generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const [user] = await db.insert(schema.users).values({
      username: data.username,
      passwordHash,
      role: data.role || 'user',
      telegram: data.telegram || '',
      priceMonth: data.priceMonth || '0',
      endDate: toPgDate(data.endDate),
    }).returning();

    return { userId: user.id, username: user.username, password: plainPassword };
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
      telegram: schema.users.telegram,
      priceMonth: schema.users.priceMonth,
      startDate: schema.users.startDate,
      endDate: schema.users.endDate,
      createdAt: schema.users.createdAt,
    }).from(schema.users).orderBy(schema.users.username);
  }

  async deleteUser(id: number) {
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }

  async updateUser(id: number, data: Record<string, unknown>) {
    const updateData: Record<string, unknown> = {};
    if (data.telegram !== undefined) updateData.telegram = data.telegram;
    if (data.username !== undefined) {
      // Check uniqueness
      const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, String(data.username))).limit(1);
      if (existing && existing.id !== id) return null;
      updateData.username = data.username;
    }
    if (data.password) updateData.passwordHash = await bcrypt.hash(String(data.password), 10);
    if (data.role !== undefined) updateData.role = data.role;
    if (data.priceMonth !== undefined) updateData.priceMonth = data.priceMonth;
    if (data.startDate !== undefined) updateData.startDate = toPgDate(String(data.startDate));
    if (data.endDate !== undefined) updateData.endDate = toPgDate(String(data.endDate));

    const [updated] = await db.update(schema.users).set(updateData).where(eq(schema.users.id, id)).returning();
    return updated || null;
  }
}

function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

function toPgDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
  if (parts.length === 3 && parts[2]?.length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return dateStr;
}

export const authService = new AuthService();
