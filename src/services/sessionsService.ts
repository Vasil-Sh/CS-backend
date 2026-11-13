// ═══════════════════════════════════════════
// Sessions service — track active sessions for logout-all / session list.
// A session = one refresh token (30d). Access tokens are short-lived (15m)
// and expire on their own; blocking the refresh jti kills the session.
// ═══════════════════════════════════════════

import { pool } from '../db/client';
import jwt from 'jsonwebtoken';

export interface SessionRow {
  id: string;
  refreshJti: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
}

function decodeJti(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as { jti?: string; exp?: number } | null;
    return decoded?.jti ?? null;
  } catch {
    return null;
  }
}

function decodeExp(token: string): number {
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    return decoded?.exp ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  } catch {
    return Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  }
}

export class SessionsService {
  /** Record a session from a freshly issued refresh token. */
  async record(refreshToken: string, userId: number, ip: string, userAgent: string): Promise<void> {
    const jti = decodeJti(refreshToken);
    if (!jti || !process.env.DATABASE_URL) return;
    const exp = new Date(decodeExp(refreshToken) * 1000).toISOString();
    try {
      await pool.query(
        `INSERT INTO sessions(user_id, refresh_jti, ip, user_agent, expires_at)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(refresh_jti) DO UPDATE SET last_seen_at=now()`,
        [userId, jti, ip.slice(0, 64), userAgent.slice(0, 500), exp],
      );
    } catch (e) {
      console.warn('[sessions] record failed:', (e as Error).message);
    }
  }

  async list(userId: number, currentJti: string | null): Promise<SessionRow[]> {
    if (!process.env.DATABASE_URL) return [];
    const { rows } = await pool.query(
      `SELECT id::text AS id, refresh_jti AS "refreshJti", ip, user_agent AS "userAgent",
              created_at AS "createdAt", last_seen_at AS "lastSeenAt"
       FROM sessions WHERE user_id=$1 AND expires_at > now()
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map((r: any) => ({
      id: r.id,
      refreshJti: r.refreshJti,
      ip: r.ip || '',
      userAgent: r.userAgent || '',
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
      lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : '',
      current: currentJti != null && r.refreshJti === currentJti,
    })) as any;
  }

  /** Return all refresh jtis except the given one (for logout-all). */
  async jtisExcept(userId: number, excludeJti: string | null): Promise<string[]> {
    if (!process.env.DATABASE_URL) return [];
    const { rows } = await pool.query(
      `SELECT refresh_jti AS jti FROM sessions WHERE user_id=$1 AND expires_at > now() AND refresh_jti IS DISTINCT FROM $2`,
      [userId, excludeJti],
    );
    return rows.map((r: any) => r.jti);
  }
}

export const sessionsService = new SessionsService();
