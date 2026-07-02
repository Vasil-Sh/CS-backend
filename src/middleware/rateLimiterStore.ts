/**
 * Redis-backed rate limiter with in-memory fallback.
 *
 * Uses REDIS_URL env var. When unavailable, falls back to Map.
 *
 * Usage:
 *   const limiter = createRateLimiter();
 *   const ok = await limiter.check(key, maxRequests, windowMs);
 */

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface RateLimiter {
  check(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult>;
}

// ── Redis implementation ──

let redisClient: import('ioredis').Redis | null = null;

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
    console.log('[RateLimiter] Connected to Redis');
    return redisClient;
  } catch {
    console.warn('[RateLimiter] Redis unavailable, using in-memory fallback');
    redisClient = null;
    return null;
  }
}

async function redisCheck(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const client = await getRedisClient();
  if (!client) throw new Error('Redis not available');

  const now = Date.now();
  const windowStart = now - windowMs;

  // Use Lua script for atomicity
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local max = tonumber(ARGV[3])
    local windowMs = tonumber(ARGV[4])

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

    -- Count current window
    local count = redis.call('ZCARD', key)

    if count >= max then
      return {0, 0, 0}
    end

    -- Add current request
    local member = now .. ':' .. math.random(1000000)
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, windowMs)

    count = count + 1
    return {1, max - count, now + windowMs}
  `;

  const result = await client.eval(script, 1, key, now, windowStart, max, windowMs) as number[];
  return {
    allowed: result[0] === 1,
    remaining: result[1],
    resetAt: result[2],
  };
}

// ── In-memory fallback ──

const MAX_MEMORY_ENTRIES = 10_000;
const memoryStore = new Map<string, { count: number; resetAt: number }>();

async function memoryCheck(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  let entry = memoryStore.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    // Evict oldest entry if at capacity
    if (memoryStore.size >= MAX_MEMORY_ENTRIES) {
      const oldestKey = memoryStore.keys().next().value;
      if (oldestKey) memoryStore.delete(oldestKey);
    }
    memoryStore.set(key, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= max,
    remaining: Math.max(0, max - entry.count),
    resetAt: entry.resetAt,
  };
}

// Periodic memory cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (now > entry.resetAt) memoryStore.delete(key);
  }
}, 5 * 60_000);

// ── Factory ──

export function createRateLimiter(): RateLimiter {
  return {
    async check(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
      try {
        return await redisCheck(key, maxRequests, windowMs);
      } catch {
        return await memoryCheck(key, maxRequests, windowMs);
      }
    },
  };
}
