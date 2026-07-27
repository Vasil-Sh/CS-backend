/**
 * JWT blocklist backed by Redis (with in-memory fallback).
 *
 * When a user logs out or an admin revokes a token, add its JWT ID (jti)
 * to the blocklist. The auth middleware checks the blocklist before accepting
 * a token.
 *
 * Requires REDIS_URL. Falls back to in-memory Map when Redis unavailable.
 */

let redisClient: import('ioredis').Redis | null = null;
const memoryBlocklist = new Map<string, number>(); // jti → expiry timestamp

/** Clean expired in-memory entries every 10 minutes */
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of memoryBlocklist) {
    if (exp < now) memoryBlocklist.delete(jti);
  }
}, 10 * 60 * 1000).unref();

async function getRedisClient(): Promise<import('ioredis').Redis | null> {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const { Redis } = await import('ioredis');
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    await redisClient.connect();
    return redisClient;
  } catch {
    redisClient = null;
    return null;
  }
}

/**
 * Check if a JWT ID (jti) is in the blocklist.
 * Returns true if the token has been revoked.
 */
export async function isBlocked(jti: string): Promise<boolean> {
  const client = await getRedisClient();
  if (client) {
    try {
      return (await client.exists(`jwt_blocklist:${jti}`)) === 1;
    } catch {
      // Redis error — fall back to memory
    }
  }

  const exp = memoryBlocklist.get(jti);
  if (!exp) return false;
  if (exp < Date.now()) {
    memoryBlocklist.delete(jti);
    return false;
  }
  return true;
}

/**
 * Add a JWT ID to the blocklist.
 * @param jti — JWT ID (jti claim)
 * @param ttlMs — time-to-live in ms (should match remaining token lifetime)
 */
export async function blocklistJti(jti: string, ttlMs: number): Promise<void> {
  const ttlSec = Math.ceil(ttlMs / 1000);

  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(`jwt_blocklist:${jti}`, '1', 'PX', ttlMs);
      return;
    } catch {
      // Redis error — fall back to memory
    }
  }

  memoryBlocklist.set(jti, Date.now() + ttlMs);
}

/**
 * Remove a JWT ID from the blocklist (e.g. on token reuse detection — security alert).
 */
export async function unblocklistJti(jti: string): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    try {
      await client.del(`jwt_blocklist:${jti}`);
    } catch { /* ignore */ }
  }
  memoryBlocklist.delete(jti);
}

/**
 * Number of entries currently in the blocklist.
 */
export async function blocklistSize(): Promise<number> {
  const client = await getRedisClient();
  if (client) {
    try {
      return await client.dbsize();
    } catch {
      return memoryBlocklist.size;
    }
  }
  return memoryBlocklist.size;
}
