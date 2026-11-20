import { describe, it, expect } from 'vitest';
import { cleanHandle, ogImageOf, validHandle } from './telegramAvatar';

describe('telegramAvatar helpers', () => {
  it('reads og:image and ignores the generic Telegram logo', () => {
    expect(ogImageOf('<meta property="og:image" content="https://cdn4.telesco.pe/file/abc.jpg">')).toBe('https://cdn4.telesco.pe/file/abc.jpg');
    expect(ogImageOf('<meta content="https://cdn1.telesco.pe/x.jpg?a=1&amp;b=2" property="og:image">')).toBe('https://cdn1.telesco.pe/x.jpg?a=1&b=2');
    expect(ogImageOf('<meta property="og:image" content="https://telegram.org/img/t_logo.png">')).toBeNull();
    expect(ogImageOf('<html></html>')).toBeNull();
  });
  it('accepts @name, t.me links and rejects short names', () => {
    expect(cleanHandle('@betsofcs2')).toBe('betsofcs2');
    expect(cleanHandle('https://t.me/betsofcs2/12')).toBe('betsofcs2');
    expect(validHandle('new')).toBe(false);
    expect(validHandle('betsofcs2')).toBe(true);
  });
});
