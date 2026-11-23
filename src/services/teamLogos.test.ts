import { describe, expect, it } from 'vitest';
import { customLogoUrl, normalizeLogoName, parseLogoDataUrl } from './teamLogos';

describe('team logos', () => {
  it('normalizes spellings like the logo packs', () => {
    expect(normalizeLogoName('Team Spirit')).toBe('teamspirit');
    expect(normalizeLogoName('NAVI!')).toBe('navi');
  });
  it('no custom logo → null (packs and feeds decide)', () => {
    expect(customLogoUrl('Unknown Team', 'cs2')).toBeNull();
  });
  it('accepts a small PNG data URL and rejects other types', () => {
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(parseLogoDataUrl(png).mime).toBe('image/png');
    expect(() => parseLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toThrow();
    expect(() => parseLogoDataUrl('nope')).toThrow();
  });
  it('rejects a file over 300 KB', () => {
    const big = 'data:image/png;base64,' + Buffer.alloc(301 * 1024).toString('base64');
    expect(() => parseLogoDataUrl(big)).toThrow(/300/);
  });
});
