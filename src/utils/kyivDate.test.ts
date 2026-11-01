import { describe, it, expect } from 'vitest';
import { isSubscriptionExpired, kyivToday } from './kyivDate';

describe('isSubscriptionExpired', () => {
  // 1 Nov 2026, 10:00 Kyiv (08:00 UTC) — the old check already failed here.
  const lastDayMorning = new Date('2026-11-01T08:00:00Z');

  it('keeps access for the whole last day in Kyiv', () => {
    expect(isSubscriptionExpired('2026-11-01', lastDayMorning)).toBe(false);
    expect(isSubscriptionExpired('2026-11-01', new Date('2026-11-01T21:59:00Z'))).toBe(false); // 23:59 Kyiv
  });

  it('expires once the next Kyiv day starts', () => {
    expect(isSubscriptionExpired('2026-11-01', new Date('2026-11-01T22:00:00Z'))).toBe(true); // 00:00 Kyiv, 2 Nov
    expect(isSubscriptionExpired('2026-10-31', lastDayMorning)).toBe(true);
  });

  it('treats a missing end date as no limit', () => {
    expect(isSubscriptionExpired(null, lastDayMorning)).toBe(false);
    expect(isSubscriptionExpired('', lastDayMorning)).toBe(false);
  });

  it('formats Kyiv today', () => {
    expect(kyivToday(new Date('2026-06-30T21:30:00Z'))).toBe('2026-07-01'); // 00:30 Kyiv (summer, UTC+3)
  });
});
