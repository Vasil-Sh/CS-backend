import { describe, it, expect } from 'vitest';
import { isNight, kyivHour } from './nightMode';

describe('night mode (Kyiv 02:00–06:00)', () => {
  it('uses Kyiv time, not UTC', () => {
    expect(kyivHour(Date.parse('2026-11-24T00:30:00Z'))).toBe(2); // winter, UTC+2
    expect(kyivHour(Date.parse('2026-07-01T00:30:00Z'))).toBe(3); // summer, UTC+3
  });
  it('02:00 is night, 06:00 and 01:59 are not', () => {
    expect(isNight(Date.parse('2026-11-24T00:00:00Z'))).toBe(true); // 02:00
    expect(isNight(Date.parse('2026-11-24T03:59:00Z'))).toBe(true); // 05:59
    expect(isNight(Date.parse('2026-11-24T04:00:00Z'))).toBe(false); // 06:00
    expect(isNight(Date.parse('2026-11-23T23:59:00Z'))).toBe(false); // 01:59
  });
});
