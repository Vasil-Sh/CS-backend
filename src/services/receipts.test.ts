import { describe, it, expect } from 'vitest';
import { isPng, receiptCaption, telegramErrorMessage, uaDate } from './receipts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('receipts', () => {
  it('detects PNG by signature', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isPng(new Uint8Array([]))).toBe(false);
  });
  it('formats dates for Ukrainian readers', () => {
    expect(uaDate('2026-11-08')).toBe('08.11.2026');
    expect(uaDate('')).toBe('');
  });
  it('builds a caption with amount, date and period', () => {
    expect(receiptCaption({ amount: '600', paidOn: '2026-11-08', periodStart: '2026-11-08', periodEnd: '2026-12-07' }))
      .toBe('Чек MatchIQ · 600 ₴\nОплата від 08.11.2026\nПідписка: 08.11.2026 — 07.12.2026');
    expect(receiptCaption({ amount: '250.50', paidOn: '2026-10-29' })).toContain('250,50 ₴');
  });
  it('maps Telegram errors to friendly messages', () => {
    expect(telegramErrorMessage('Forbidden: bot was blocked by the user').status).toBe(409);
    expect(telegramErrorMessage('Bad Request: chat not found').status).toBe(409);
    expect(telegramErrorMessage('Too Many Requests').status).toBe(502);
  });
});
