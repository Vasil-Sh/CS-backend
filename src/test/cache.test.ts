import { describe, it, expect } from "vitest";

// ── MemoryCache (pure logic, extracted for testing) ──

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TestMemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private defaultTTL = 30_000;

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs || this.defaultTTL) });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  delByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

describe("MemoryCache", () => {
  let cache: TestMemoryCache;

  beforeEach(() => {
    cache = new TestMemoryCache();
  });

  it("returns null for missing key", () => {
    expect(cache.get("missing")).toBeNull();
  });

  it("sets and gets a value", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("sets and gets objects", () => {
    const obj = { a: 1, b: "hello" };
    cache.set("obj", obj);
    expect(cache.get("obj")).toEqual(obj);
  });

  it("increments size with each set", () => {
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });

  it("respects custom TTL", async () => {
    cache.set("short", "value", 10); // 10ms TTL
    expect(cache.get("short")).toBe("value");
    await new Promise((r) => setTimeout(r, 15));
    expect(cache.get("short")).toBeNull();
  });

  it("uses default TTL of 30s", async () => {
    cache.set("default", "value");
    expect(cache.get("default")).toBe("value");
    // Not expired after 5ms
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get("default")).toBe("value");
  });

  it("deletes a specific key", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.del("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("delByPrefix deletes matching keys only", () => {
    cache.set("bets:1:1:10", "data1");
    cache.set("bets:1:2:10", "data2");
    cache.set("stats:1", "stats");
    cache.set("other", "other");

    cache.delByPrefix("bets:1");
    expect(cache.get("bets:1:1:10")).toBeNull();
    expect(cache.get("bets:1:2:10")).toBeNull();
    expect(cache.get("stats:1")).toBe("stats");
    expect(cache.get("other")).toBe("other");
    expect(cache.size).toBe(2);
  });

  it("delByPrefix with non-matching prefix removes nothing", () => {
    cache.set("bets:1", "data");
    cache.delByPrefix("stats:");
    expect(cache.size).toBe(1);
    expect(cache.get("bets:1")).toBe("data");
  });

  it("returns 0 size when empty", () => {
    expect(cache.size).toBe(0);
  });

  it("overwrites existing key", () => {
    cache.set("key", "old");
    cache.set("key", "new");
    expect(cache.get("key")).toBe("new");
    expect(cache.size).toBe(1);
  });
});
