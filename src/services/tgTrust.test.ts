import { describe, it, expect } from 'vitest';
import { honestyOf } from './tgHonesty';
import { bookmakerOf, slipBet } from './tgSlip';
import { doubtOf, linkedHandles } from './tgSources';
import type { TgCandidate, TgParsed } from './tgPostParser';

const m: TgCandidate = { id: 'm', game: 'cs2', team1: 'M80', team2: '100 Thieves', start: '2026-11-27T12:00:00Z' };
const bet = (market: string, pick: string, odds = 1.56): Extract<TgParsed, { kind: 'bet' }> => ({ kind: 'bet', match: m, market, pick, odds });

describe('channel trust', () => {
  it('honesty: deleted losses, disproved claims and live wins (half) count against', () => {
    expect(honestyOf({ settled: 20, mismatches: 0, deletedLost: 0, liveWon: 0 })).toBe(100);
    expect(honestyOf({ settled: 20, mismatches: 1, deletedLost: 2, liveWon: 2 })).toBe(80);
    expect(honestyOf({ settled: 0, mismatches: 0, deletedLost: 0, liveWon: 0 })).toBe(null);
  });
  it('doubt: the caption or the slip says another bet, the money differs', () => {
    expect(doubtOf(bet('Handicap +1.5', 'M80'), bet('Handicap +1.5', 'M80'), null, null, null)).toBe(null);
    expect(doubtOf(bet('Match Winner', 'M80'), { kind: 'other' }, bet('Handicap +1.5', 'M80'), null, null)).toMatch(/на квитку Handicap \+1\.5/);
    expect(doubtOf(bet('Match Winner', 'M80'), bet('Match Winner', '100 Thieves'), null, null, null)).toMatch(/у підписі/);
    expect(doubtOf(bet('Match Winner', 'M80'), { kind: 'other' }, null, { isTip: true, stake: 3500 }, { stake: 350, currency: 'USDT' })).toMatch(/сума: ШІ 3500, OCR 350/);
  });
  it('bookmakers and their shorthand', () => {
    expect(bookmakerOf('Открыта • Ординар\nПродать за 350,00 USDT')).toBe('1win');
    expect(bookmakerOf('BC.GAME · Sports')).toBe('BC.Game');
    expect(bookmakerOf('PARIVISION — Liquid')).toBe(null);
    const t = 'Сумма ставки 100,00 USDT\nВыигрыш 185,00 USDT\nM80\n100 Thieves\nФ1(-1.5) 1.85';
    expect(slipBet(t, '2026-11-27T11:52:00Z', [m])).toMatchObject({ market: 'Handicap -1.5', pick: 'M80', odds: 1.85 });
    expect(slipBet(t.replace('Ф1(-1.5)', 'ТБ(2.5)'), '2026-11-27T11:52:00Z', [m])).toMatchObject({ market: 'Total Maps Over 2.5' });
  });
  it('channels a post points to', () => {
    expect(linkedHandles('Наш вип: t.me/smatikvip и @cs2_insider, бот @smatik_bot, сами мы @smatikbet', 'smatikbet')).toEqual(['smatikvip', 'cs2_insider']);
  });
});
