import { describe, it, expect } from 'vitest';
import { slipBet } from './tgSlip';
import type { TgCandidate } from './tgPostParser';

const at = '2026-11-26T14:06:00Z';
const c = (team1: string, team2: string): TgCandidate => ({ id: `m-${team1}`, game: 'cs2', team1, team2, start: '2026-11-26T13:30:00Z' });
const cands = [c('Wildcard', 'Chinggis Warriors'), c('Ninjas in Pyjamas', 'Team Liquid'), c('Natus Vincere', 'Team Spirit')];
const slip = (lines: string[]) => ['26 ноября 2026 г. в 16:06', 'ID 415437741', 'Открыта Ординар', 'Сумма ставки 1 55,00 USDT', 'Возможный выигрыш', '2 35,60 USDT', 'Событие 1', 'CS2 · PGL · PGL Singapore Major', ...lines].join('\n');

describe('a bookmaker slip read by OCR', () => {
  it('map winner, odds printed', () => {
    expect(slipBet(slip(['Ninjas in Pyjamas 13 1', 'Team Liquid 7 0', 'Карта 2. Победитель, Ninjas in Pyjamas 1.52']), at, cands))
      .toMatchObject({ kind: 'bet', market: 'Map 2 Winner', pick: 'Ninjas in Pyjamas', odds: 1.52 });
  });
  it('match winner, odds from payout ÷ stake', () => {
    expect(slipBet(slip(['Natus Vincere', 'Team Spirit', 'Победитель матча: Team Spirit']), at, cands))
      .toMatchObject({ market: 'Match Winner', pick: 'Team Spirit', odds: 1.52 });
  });
  it('maps handicap and total', () => {
    expect(slipBet(slip(['Natus Vincere', 'Team Spirit', 'Фора, Natus Vincere -1.5 1.52']), at, cands)).toMatchObject({ market: 'Handicap -1.5', pick: 'Natus Vincere' });
    expect(slipBet(slip(['Natus Vincere', 'Team Spirit', 'Тотал карт больше 2.5 1.52']), at, cands)).toMatchObject({ market: 'Total Maps Over 2.5', pick: '' });
  });
  it('rounds on a map', () => {
    const s2 = (l: string[]) => slip(l).replace('2 35,60', '2 43,35');
    expect(slipBet(s2(['Wildcard 13 11 1', 'Chinggis Warriors 7 13 1', 'Карта 3. Фора, Chinggis Warriors 4.5 1.57']), at, cands)).toMatchObject({ market: 'Map 3 Handicap +4.5', pick: 'Chinggis Warriors', odds: 1.57 });
  });
  it('odds that disagree, an express, an unknown match — left to the AI', () => {
    expect(slipBet(slip(['Natus Vincere', 'Team Spirit', 'Победитель, Team Spirit 2.40']), at, cands)).toBe(null);
    expect(slipBet(slip(['Экспресс', 'Natus Vincere', 'Team Spirit', 'Победитель, Team Spirit 1.52']), at, cands)).toBe(null);
    expect(slipBet(slip(['Vitality', 'MOUZ', 'Победитель, MOUZ 1.52']), at, cands)).toBe(null);
  });
});
