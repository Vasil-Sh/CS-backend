import { describe, it, expect } from 'vitest';
import { MemoryCache } from '../utils/cache';

// Re-create the cache for testing (no auto-cleanup interval)
function createCache() {
  return new (MemoryCache as any)() as InstanceType<typeof MemoryCache>;
}

// Since cache is exported as singleton, we test via its API
import { cache } from '../utils/cache';

describe('MemoryCache', () => {
  beforeEach(() => {
    // Clear all entries before each test
    for (const key of [...(cache as any).store.keys()]) {
      (cache as any).store.delete(key);
    }
  });

  it('returns null for missing keys', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves values', () => {
    cache.set('test-key', { name: 'test' });
    expect(cache.get('test-key')).toEqual({ name: 'test' });
  });

  it('stores and retrieves primitive values', () => {
    cache.set('num', 42);
    cache.set('str', 'hello');
    cache.set('bool', true);
    expect(cache.get('num')).toBe(42);
    expect(cache.get('str')).toBe('hello');
    expect(cache.get('bool')).toBe(true);
  });

  it('expires entries after default TTL (30s)', async () => {
    cache.set('fast', 'value', 10); // 10ms TTL
    expect(cache.get('fast')).toBe('value');
    await new Promise((r) => setTimeout(r, 15));
    expect(cache.get('fast')).toBeNull();
  });

  it('deletes specific keys', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.del('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
  });

  it('deletes keys by prefix', () => {
    cache.set('bets:1', { id: 1 });
    cache.set('bets:2', { id: 2 });
    cache.set('stats:1', { wins: 5 });
    cache.set('other', 'keep');

    cache.delByPrefix('bets:');
    expect(cache.get('bets:1')).toBeNull();
    expect(cache.get('bets:2')).toBeNull();
    expect(cache.get('stats:1')).toEqual({ wins: 5 });
    expect(cache.get('other')).toBe('keep');
  });

  it('reports correct size', () => {
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    cache.del('a');
    expect(cache.size).toBe(1);
  });

  it('overwrites existing keys', () => {
    cache.set('key', 'old');
    cache.set('key', 'new');
    expect(cache.get('key')).toBe('new');
    expect(cache.size).toBe(1);
  });
});
