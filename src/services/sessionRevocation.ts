// ═══════════════════════════════════════════
// «Log out on all devices»: users.sessions_revoked_at.
// Any access or refresh token issued before that second is rejected.
// Cached per user for 30 s so the auth middleware does not query on every request.
// ═══════════════════════════════════════════

import { pool } from '../db/client';

const TTL_MS = 30_000;
const cache = new Map<number, { at: number | null; checked: number }>();

/** Epoch ms of the last «log out everywhere» for this user (null if never). */
export async function sessionsRevokedAt(userId: number): Promise<number | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.checked < TTL_MS) return hit.at;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { rows } = await pool.query('SELECT sessions_revoked_at AS at FROM users WHERE id=$1', [userId]);
    const at = rows[0]?.at ? new Date(rows[0].at).getTime() : null;
    cache.set(userId, { at, checked: Date.now() });
    return at;
  } catch {
    return hit?.at ?? null; // DB hiccup — keep the last known value
  }
}

/** Mark every existing token of the user as revoked. Returns the revocation time (whole second). */
export async function revokeAllSessions(userId: number): Promise<number> {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await pool.query('UPDATE users SET sessions_revoked_at=$2 WHERE id=$1', [userId, new Date(at).toISOString()]);
  cache.set(userId, { at, checked: Date.now() });
  return at;
}

/** True when a token with this `iat` (seconds) was issued before the revocation. */
export function issuedBefore(iatSec: number | undefined, revokedAtMs: number | null): boolean {
  return !!revokedAtMs && typeof iatSec === 'number' && iatSec * 1000 < revokedAtMs;
}
