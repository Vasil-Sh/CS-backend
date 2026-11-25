import { describe, it, expect, vi } from 'vitest';
vi.mock('../db/client', () => ({ pool: { query: vi.fn() }, db: {} }));
import { publicHandle } from './tgSources';

describe('publicHandle', () => {
  it('reads public links and @names, skips invites', () => {
    expect(publicHandle('https://t.me/kiberprognoz_ua')).toBe('kiberprognoz_ua');
    expect(publicHandle('t.me/s/BetZone_CS2')).toBe('betzone_cs2');
    expect(publicHandle('@cs2insider')).toBe('cs2insider');
    expect(publicHandle('https://t.me/+AbC12xyz')).toBeNull();
    expect(publicHandle('https://t.me/joinchat/AbC12')).toBeNull();
    expect(publicHandle('')).toBeNull();
  });
});
