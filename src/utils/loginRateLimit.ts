// ═══════════════════════════════════════════
// Simple in-memory login rate limiter (no Redis dependency).
// Keys by IP + username to slow down brute-force without lockouts
// that a single attacker could trigger for other users.
// ═══════════════════════════════════════════

interface Bucket {
  attempts: number[];
  blockedUntil: number;
}

const WINDOW_MS = 15 * 60 * 1000; // 15 min sliding window
const MAX_ATTEMPTS = 10; // per IP + username
const BLOCK_MS = 15 * 60 * 1000; // lock after 10 failures
// Per account, regardless of IP: the client can put any address into
// X-Forwarded-For, so an IP-based limit alone is easy to bypass by rotating
// fake IPs. Higher threshold so one person mistyping never hits it.
const MAX_ACCOUNT_ATTEMPTS = 30;

const buckets = new Map<string, Bucket>();

function keyFor(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

function accountKey(username: string): string {
  return `account|${username.trim().toLowerCase()}`;
}

function recordIn(key: string, max: number, now: number): number {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { attempts: [], blockedUntil: 0 };
    buckets.set(key, bucket);
  }
  prune(bucket, now);
  bucket.attempts.push(now);
  if (bucket.attempts.length >= max) {
    bucket.blockedUntil = now + BLOCK_MS;
    bucket.attempts = [];
  }
  return Math.max(0, max - bucket.attempts.length);
}

function blockedFor(key: string, now: number): number {
  const remaining = (buckets.get(key)?.blockedUntil ?? 0) - now;
  return remaining > 0 ? remaining : 0;
}

function prune(bucket: Bucket, now: number): void {
  bucket.attempts = bucket.attempts.filter((t) => now - t < WINDOW_MS);
}

/** Returns the client IP, honoring common reverse-proxy headers. */
export function clientIp(headers: Record<string, string | undefined>): string {
  return (
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    headers['x-real-ip'] ||
    headers['cf-connecting-ip'] ||
    'unknown'
  );
}

/** Record a failed attempt. Returns remaining attempts before block. */
export function recordLoginFailure(ip: string, username: string): number {
  const now = Date.now();
  recordIn(accountKey(username), MAX_ACCOUNT_ATTEMPTS, now);
  return recordIn(keyFor(ip, username), MAX_ATTEMPTS, now);
}

/** Clear failures after a successful login. */
export function clearLoginFailures(ip: string, username: string): void {
  buckets.delete(keyFor(ip, username));
  buckets.delete(accountKey(username));
}

/** Returns remaining block time in ms, or 0 if not blocked. */
export function loginBlockedMs(ip: string, username: string): number {
  const now = Date.now();
  return Math.max(blockedFor(keyFor(ip, username), now), blockedFor(accountKey(username), now));
}

// Periodic cleanup to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    prune(bucket, now);
    if (bucket.attempts.length === 0 && bucket.blockedUntil <= now) {
      buckets.delete(key);
    }
  }
}, 60_000);
