import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/client', () => ({ pool: { query: vi.fn() } }));
import { pool } from '../db/client';
import { issuedBefore, revokeAllSessions, sessionsRevokedAt } from './sessionRevocation';

const query = vi.mocked(pool.query) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { query.mockReset(); process.env.DATABASE_URL = 'postgres://x'; });

describe('session revocation', () => {
  it('compares token iat with the revocation second', () => {
    expect(issuedBefore(100, 101_000)).toBe(true);
    expect(issuedBefore(101, 101_000)).toBe(false); // issued in the same second — the new token of the calling device
    expect(issuedBefore(100, null)).toBe(false);
    expect(issuedBefore(undefined, 101_000)).toBe(false);
  });
  it('stores a whole-second timestamp and caches it', async () => {
    query.mockResolvedValue({ rows: [] });
    const at = await revokeAllSessions(7);
    expect(at % 1000).toBe(0);
    expect(query.mock.calls[0][1][0]).toBe(7);
    query.mockClear();
    expect(await sessionsRevokedAt(7)).toBe(at);
    expect(query).not.toHaveBeenCalled();
  });
  it('reads the timestamp from the database once per TTL', async () => {
    query.mockResolvedValueOnce({ rows: [{ at: '2026-11-13T10:40:00.000Z' }] });
    expect(await sessionsRevokedAt(42)).toBe(Date.parse('2026-11-13T10:40:00.000Z'));
    expect(await sessionsRevokedAt(42)).toBe(Date.parse('2026-11-13T10:40:00.000Z'));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
