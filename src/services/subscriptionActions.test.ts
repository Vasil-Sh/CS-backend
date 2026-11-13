import { describe, it, expect } from 'vitest';
import { addDays, grantProDates, kyivToday } from './subscriptionActions';

describe('subscription actions', () => {
  it('adds days across months', () => {
    expect(addDays('2026-11-08', 14)).toBe('2026-11-22');
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
  it('grants Pro from today and shifts the paid end by the same days (design: 12 → 26 лист.)', () => {
    expect(grantProDates('2026-11-08', 14, '2026-11-12')).toEqual({ proUntil: '2026-11-22', newEndDate: '2026-11-26' });
  });
  it('starts from today when the subscription already ended', () => {
    expect(grantProDates('2026-11-08', 7, '2026-10-01')).toEqual({ proUntil: '2026-11-15', newEndDate: '2026-11-15' });
    expect(grantProDates('2026-11-08', 7, null).newEndDate).toBe('2026-11-15');
  });
  it('formats today in Kyiv', () => {
    expect(kyivToday(new Date('2026-11-13T23:30:00Z'))).toBe('2026-11-14');
  });
});
