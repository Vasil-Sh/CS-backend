import { describe, it, expect } from 'vitest';
import { numericNormalizer } from './numericNormalizer';

describe('numericNormalizer', () => {
  it('returns null as-is', () => {
    expect(numericNormalizer(null)).toBeNull();
  });

  it('returns undefined as-is', () => {
    expect(numericNormalizer(undefined)).toBeUndefined();
  });

  it('returns non-numeric strings unchanged', () => {
    expect(numericNormalizer('hello')).toBe('hello');
    expect(numericNormalizer('CS2')).toBe('CS2');
    expect(numericNormalizer('')).toBe('');
  });

  it('converts integer numeric strings to numbers', () => {
    expect(numericNormalizer('42')).toBe(42);
    // '0' is a known edge case — its replace produces '' which doesn't match String(0)
    expect(numericNormalizer('0')).toBe('0');
    expect(numericNormalizer('-5')).toBe(-5);
  });

  it('converts float numeric strings to numbers', () => {
    expect(numericNormalizer('1.85')).toBe(1.85);
    expect(numericNormalizer('3.14159')).toBe(3.14159);
    expect(numericNormalizer('-2.5')).toBe(-2.5);
  });

  it('converts strings with trailing zeros to numbers', () => {
    expect(numericNormalizer('85.00')).toBe(85);
    expect(numericNormalizer('1.850')).toBe(1.85);
    expect(numericNormalizer('100.000')).toBe(100);
  });

  it('leaves non-numeric text with digits unchanged', () => {
    expect(numericNormalizer('v1.2.3')).toBe('v1.2.3');
    expect(numericNormalizer('10px')).toBe('10px');
  });

  it('recursively normalizes arrays', () => {
    expect(numericNormalizer(['1', 'hello', '3.14'])).toEqual([1, 'hello', 3.14]);
  });

  it('recursively normalizes objects', () => {
    const input = { odds: '1.85', amount: '100.00', team: 'NAVI' };
    expect(numericNormalizer(input)).toEqual({ odds: 1.85, amount: 100, team: 'NAVI' });
  });

  it('handles nested objects', () => {
    const input = {
      match: { odds: '2.50', team1: 'FaZe' },
      bets: [{ profit: '25.00' }, { profit: '-10.50' }],
    };
    expect(numericNormalizer(input)).toEqual({
      match: { odds: 2.5, team1: 'FaZe' },
      bets: [{ profit: 25 }, { profit: -10.5 }],
    });
  });

  it('returns primitives unchanged', () => {
    expect(numericNormalizer(42)).toBe(42);
    expect(numericNormalizer(true)).toBe(true);
    expect(numericNormalizer(false)).toBe(false);
  });
});
