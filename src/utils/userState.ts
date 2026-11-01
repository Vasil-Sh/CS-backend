import { pool } from '../db/client';
import type { UserState } from '../services/sessionRules';

// Short cache: one DB lookup per user per 15 s instead of per request.
// Mutations in this process call invalidateUserState() so admin actions apply at once.
const TTL_MS = 15_000;
const cache = new Map<number, { state: UserState | null; at: number }>();

/**
 * Returns the user's current state, null if the user no longer exists,
 * or undefined if the DB could not be reached (caller decides how to degrade).
 */
export async function getUserState(userId: number, { fresh = false } = {}): Promise<UserState | null | undefined> {
  const hit = cache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.state;
  try {
    const { rows } = await pool.query(
      'SELECT role, token_version AS "tokenVersion", start_date::text AS "startDate", end_date::text AS "endDate" FROM users WHERE id = $1',
      [userId],
    );
    const state: UserState | null = rows[0] ? { ...rows[0], tokenVersion: Number(rows[0].tokenVersion ?? 0) } : null;
    cache.set(userId, { state, at: Date.now() });
    if (cache.size > 5000) cache.delete(cache.keys().next().value as number);
    return state;
  } catch (err) {
    console.warn('[userState] lookup failed:', (err as Error).message);
    return undefined;
  }
}

export function invalidateUserState(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}
