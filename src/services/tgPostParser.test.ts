import { describe, it, expect } from 'vitest';
import { parseTgPost, parseTgPage, type TgCandidate } from './tgPostParser';

const at = '2026-11-25T13:00:00Z';
const C: TgCandidate[] = [
  { id: 'lp-1', game: 'cs2', team1: 'Natus Vincere', team2: 'G2 Esports', start: '2026-11-25T17:30:00Z', aliases1: ['NAVI'], aliases2: ['G2'] },
  { id: 'lp-2', game: 'cs2', team1: 'Team Liquid', team2: 'Heroic', start: '2026-11-25T18:00:00Z', aliases1: ['Liquid'] },
  { id: 'lp-3', game: 'cs2', team1: 'MOUZ', team2: 'G2 Esports', start: '2026-11-25T11:00:00Z', aliases2: ['G2'] },
  { id: 'lp-4', game: 'dota2', team1: 'Team Spirit', team2: 'Tundra Esports', start: '2026-11-26T15:00:00Z', aliases1: ['Spirit'], aliases2: ['Tundra'] },
];

describe('parseTgPost', () => {
  it('«Перемога NAVI @1.72» → Match Winner on NAVI', () => {
    expect(parseTgPost('🔥 NAVI vs G2 Esports\nПеремога NAVI @1.72 · ставка 3% банку', at, C)).toMatchObject({ kind: 'bet', match: { id: 'lp-1' }, market: 'Match Winner', pick: 'Natus Vincere', odds: 1.72 });
  });
  it('П2 with «кф»', () => {
    expect(parseTgPost('Spirit — Tundra П2 кф 2,05', at, C)).toMatchObject({ kind: 'bet', match: { id: 'lp-4' }, pick: 'Tundra Esports', odds: 2.05 });
  });
  it('total maps', () => {
    expect(parseTgPost('Spirit vs Tundra ТБ 2.5 @1.95', at, C)).toMatchObject({ kind: 'bet', market: 'Total Maps Over 2.5', odds: 1.95 });
    expect(parseTgPost('Liquid vs Heroic тотал меньше 2.5 кф 2.1', at, C)).toMatchObject({ kind: 'bet', market: 'Total Maps Under 2.5' });
  });
  it('handicap next to the team', () => {
    expect(parseTgPost('MOUZ — G2 Фора MOUZ -1.5 @2.40', at, C)).toMatchObject({ kind: 'bet', match: { id: 'lp-3' }, market: 'Handicap -1.5', pick: 'MOUZ', odds: 2.4 });
    expect(parseTgPost('Spirit vs Tundra Ф2(+1.5) 1.6', at, C)).toMatchObject({ kind: 'bet', market: 'Handicap +1.5', pick: 'Tundra Esports' });
  });
  it('odds without a side → not recognized; a channel rule closes it', () => {
    expect(parseTgPost('Liquid vs Heroic кф 1.85 💰', at, C)).toMatchObject({ kind: 'unknown', reason: 'Не вказано, на кого ставка', match: { id: 'lp-2' }, odds: 1.85 });
    expect(parseTgPost('Liquid vs Heroic кф 1.85 💰', at, C, { oddsOnly: 'p1' })).toMatchObject({ kind: 'bet', pick: 'Team Liquid' });
  });
  it('one team only → «немає суперника»; express / individual totals → not counted yet', () => {
    expect(parseTgPost('G2 сьогодні забирають 🔥 1.6', at, C)).toMatchObject({ kind: 'unknown', reason: 'Матч не знайдено — немає суперника' }); // G2 has two matches that day
    expect(parseTgPost('NAVI сьогодні забирають 🔥 1.6', at, C)).toMatchObject({ kind: 'bet', match: { id: 'lp-1' }, pick: 'Natus Vincere' }); // its only match
    expect(parseTgPost('Экспресс: NAVI + Spirit @3.1', at, C)).toMatchObject({ kind: 'unknown', reason: 'Експреси поки не рахуємо' });
    expect(parseTgPost('Liquid vs Heroic ИТБ1 1.5 @1.9', at, C)).toMatchObject({ kind: 'unknown', reason: 'Індивідуальні тотали поки не рахуємо' });
  });
  it('a chat post is not a tip', () => {
    expect(parseTgPost('Всім гарного вечора! Сьогодні 3 прогнози 👇', at, C)).toEqual({ kind: 'other' });
  });
  it('«G2» does not hide inside other words', () => {
    expect(parseTgPost('Mouzg2 promo @1.5', at, C).kind).not.toBe('bet');
  });
});

describe('parseTgPage', () => {
  it('reads channel info and posts', () => {
    const html = `<div class="tgme_channel_info_header_title"><span dir="auto">BetZone &amp; CS2</span></div>
      <div class="tgme_channel_info_counter"><span class="counter_value">12.4K</span> <span class="counter_type">subscribers</span></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="betzone_cs2/101"><div class="tgme_widget_message_text js-message_text" dir="auto">NAVI vs G2<br/>П1 @1.72</div>
      <a class="tgme_widget_message_date"><time datetime="2026-11-25T15:10:00+00:00" class="time">15:10</time></a></div></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="betzone_cs2/102"><div class="tgme_widget_message_photo_wrap"></div>
      <a class="tgme_widget_message_date"><time datetime="2026-11-25T16:00:00+00:00">16:00</time></a></div></div>`;
    const p = parseTgPage(html);
    expect(p.title).toBe('BetZone & CS2');
    expect(p.subscribers).toBe(12400);
    expect(p.posts).toEqual([{ id: 101, at: '2026-11-25T15:10:00.000Z', text: 'NAVI vs G2\nП1 @1.72', photos: [] }, { id: 102, at: '2026-11-25T16:00:00.000Z', text: '', photos: [] }]);
  });
});

describe('rounds on one map', () => {
  const c = [{ id: 'wc', game: 'cs2' as const, team1: 'Wildcard', team2: 'Chinggis Warriors', start: '2026-11-26T13:30:00Z' }];
  const at = '2026-11-26T14:08:00Z';
  it('a slip: «Карта 3. Фора, Chinggis Warriors 4.5 1.57»', () => {
    expect(parseTgPost('Wildcard 13 1\nChinggis Warriors 7 13\nКарта 3. Фора, Chinggis Warriors 4.5 1.57', at, c)).toMatchObject({ kind: 'bet', market: 'Map 3 Handicap +4.5', pick: 'Chinggis Warriors', odds: 1.57 });
  });
  it('a caption: «фора Chinggis +4.5 3map»', () => {
    expect(parseTgPost('Wildcard - Chinggis Warriors\nПрогноз: фора Chinggis Warriors +4.5 3map', at, c)).toMatchObject({ market: 'Map 3 Handicap +4.5', pick: 'Chinggis Warriors' });
  });
  it('rounds total on a map', () => {
    expect(parseTgPost('Wildcard vs Chinggis Warriors\n2 карта тотал больше 26.5 @1.85', at, c)).toMatchObject({ market: 'Map 2 Total Over 26.5', odds: 1.85 });
  });
});

describe('«Фора по картам» without a sign', () => {
  it('is a maps handicap +1.5', () => {
    const c = [{ id: 'm', game: 'cs2' as const, team1: 'M80', team2: '100 Thieves', start: '2026-11-27T12:00:00Z' }];
    expect(parseTgPost('M80 - 100 Thieves\nФора по картам, M80 1.5 1.56', '2026-11-27T11:52:00Z', c)).toMatchObject({ kind: 'bet', market: 'Handicap +1.5', pick: 'M80', odds: 1.56 });
  });
});

import { parseTgPage, resultMark } from './tgPostParser';
describe('replies and result marks', () => {
  it('a reply link on t.me/s', () => {
    const html = '<div class="tgme_widget_message" data-post="smatikbet/15700"><a class="tgme_widget_message_reply" href="https://t.me/smatikbet/15688"><div class="tgme_widget_message_reply_text js-message_reply_text">Прогноз</div></a><div class="tgme_widget_message_text js-message_text" dir="auto">✅✅✅</div><time datetime="2026-11-27T15:00:00+00:00"></time></div>';
    expect(parseTgPage(html).posts[0]).toMatchObject({ id: 15700, text: '✅✅✅', replyTo: 15688 });
  });
  it('the result a channel writes', () => {
    expect(resultMark('✅✅✅')).toBe('Win');
    expect(resultMark('Зашло 🔥')).toBe('Win');
    expect(resultMark('❌ минус, бывает')).toBe('Loss');
    expect(resultMark('не зашло')).toBe('Loss');
    expect(resultMark('Возврат')).toBe('Void');
    expect(resultMark('Сегодня стрим в 20:00')).toBe(null);
    expect(resultMark('✅ '.repeat(3) + 'Длинный текст прогноза на матч '.repeat(8))).toBe(null);
  });
});
