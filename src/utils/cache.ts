// ═══════════════════════════════════════════
// Simple in-memory cache (no Redis dependency needed)
// Falls back to Node.js Map, ready for Redis upgrade later.
// ═══════════════════════════════════════════

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private defaultTTL = 30_000; // 30 seconds

  /** Get cached value or null if expired/not found */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  /** Set value with optional TTL (ms) */
  set<T>(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs || this.defaultTTL),
    });
  }

  /** Delete a specific key */
  del(key: string): void {
    this.store.delete(key);
  }

  /** Delete all keys matching a prefix */
  delByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

export const cache = new MemoryCache();

// Auto-cleanup every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache['store'].entries()) {
    if (now > (entry as CacheEntry<any>).expiresAt) {
      cache['store'].delete(key);
    }
  }
}, 60_000);
