import { describe, it, expect } from 'vitest';
import { parseTgPost, parseTgPage, teamsFromText, type TgCandidate } from './tgPostParser';
import { cleanOcr, mergeOcr } from './tgOcr';

// What tesseract read on real bet screenshots (25.11), + the caption
const at = '2026-11-25T08:13:00Z';
const C: TgCandidate[] = [
  { id: 'nip-liq', game: 'cs2', team1: 'Ninjas in Pyjamas', team2: 'Team Liquid', start: '2026-11-25T10:30:00Z', aliases1: ['NiP'], aliases2: ['Liquid'] },
  { id: 'og-aur', game: 'dota2', team1: 'OG', team2: 'Aurora Gaming', start: '2026-11-25T08:00:00Z', aliases2: ['Aurora'] },
  { id: 'liq-hero-old', game: 'cs2', team1: 'Team Liquid', team2: 'Heroic', start: '2026-11-28T18:00:00Z', aliases1: ['Liquid'] },
];

describe('screenshots (OCR text)', () => {
  it('1win: «Победитель , Liquid 1.8» → Match Winner Liquid', () => {
    const ocr = 'Открыта » Ординар [1.8 |\nСумма ставки 500,00 USDT\nВозможный выигрыш\n900,00 USDT\nСобытие 1\nCS2 . PGL » PGL Singapore Major\nNiP\nLiquid\n25 ноября, 12:30 Открыта\nПобедитель , Liquid 1.8';
    expect(parseTgPost(ocr, at, C)).toMatchObject({ kind: 'bet', match: { id: 'nip-liq' }, market: 'Match Winner', pick: 'Team Liquid', odds: 1.8 });
  });
  it('BC.GAME: «1 карта - победитель Team OG» → a map bet, match and odds found', () => {
    const ocr = '1-ая карта (©)\nN Dota 2 › BLAST SLAM IX\nTeam OG vs Aurora Gaming 0:0 и!\nID ставки: 2737067784851821110 Qj [С] ВС.САМЕ\n1 карта - победитель Team ОС 0:0\nИтоговый коэффициент 2.35\nСтавка 12000.00 Р';
    expect(parseTgPost(ocr, at, C)).toMatchObject({ kind: 'bet', market: 'Map 1 Winner', pick: 'OG', match: { id: 'og-aur' }, odds: 2.35 });
  });
  it('one team on the screen → its match around the post time', () => {
    const ocr = 'SS PGL Major\n< © 00:37:02 363 x\nLiquid\nПобеда на карте #2\nili, СТАТИСТИКА\nх 2.418 = =\nКОЭФФИЦИЕНТ ВЫИГРЫШ';
    expect(parseTgPost(ocr, at, C)).toMatchObject({ kind: 'bet', market: 'Map 2 Winner', pick: 'Team Liquid', match: { id: 'nip-liq' }, odds: 2.418 });
    expect(parseTgPost('Liquid\nПобеда\nх 2.418', at, C)).toMatchObject({ kind: 'bet', match: { id: 'nip-liq' }, pick: 'Team Liquid', odds: 2.418 });
  });
  it('a map bet on a match we cannot find stays in the queue', () => {
    expect(parseTgPost('Камбек на 2карту від ЗдМакс\nКарта 2: Переможець карти: 3DMAX 1.90', at, C)).toMatchObject({ kind: 'unknown', reason: 'Матч не знайдено' }); // 3DMAX is not in the candidates
  });
  it('football screenshots are not ours', () => {
    expect(parseTgPost('ЭКСПРЕСС 25 нояб.\n1.6 Сабах ФК vs Барселона\nБарселона выиграет обе половины да\nЛига Чемпионов УЕФА\nИтоговый коэффициент 1.84', at, C)).toMatchObject({ kind: 'other' });
    expect(parseTgPost('over 0.5\nSabah Masazir vs FC Barcelona\nTotal in time period 0:00-35:00\n1.85', at, C)).toMatchObject({ kind: 'other' });
  });
  it('«2.5 карти» in a total is not a map bet', () => {
    expect(parseTgPost('NiP vs Liquid тотал больше 2.5 карты кф 1.9', at, C)).toMatchObject({ kind: 'bet', market: 'Total Maps Over 2.5' });
  });
  it('page: photo links of a post', () => {
    const html = `<div class="tgme_widget_message" data-post="ch/7"><a class="tgme_widget_message_photo_wrap 1 2" href="x" style="width:800px;background-image:url('https://cdn4.telesco.pe/file/a.jpg')"></a><div class="tgme_widget_message_text js-message_text" dir="auto">Камбек</div><time datetime="2026-09-03T10:13:00+00:00"></time></div>`;
    expect(parseTgPage(html).posts[0]).toMatchObject({ id: 7, text: 'Камбек', photos: ['https://cdn4.telesco.pe/file/a.jpg'] });
  });
  it('page: a reply keeps its own text, not the quote', () => {
    const html = `<div class="tgme_widget_message" data-post="ch/204"><a class="tgme_widget_message_reply" href="https://t.me/ch/203"><div class="tgme_widget_message_text js-message_reply_text" dir="auto">Ще таку спробую взяти</div></a><div class="tgme_widget_message_text js-message_text before_footer" dir="auto">гг) там тіпи 2 в 5 програли</div><time datetime="2026-09-03T10:01:38+00:00"></time></div>
<div class="tgme_widget_message" data-post="ch/209"><a class="tgme_widget_message_reply" href="https://t.me/ch/206"><div class="tgme_widget_message_text js-message_reply_text" dir="auto">Камбек</div></a><a class="tgme_widget_message_photo_wrap" style="width:380px;background-image:url('https://cdn4.telesco.pe/file/b.jpg')"></a><time datetime="2026-09-03T10:18:20+00:00"></time></div>`;
    expect(parseTgPage(html).posts).toMatchObject([{ id: 204, text: 'гг) там тіпи 2 в 5 програли', photos: [] }, { id: 209, text: '', photos: ['https://cdn4.telesco.pe/file/b.jpg'] }]);
  });
  it('OCR noise lines are dropped', () => {
    expect(cleanOcr('  Liquid \n\n| ~ \n x 2.418 = = ')).toBe('Liquid\nx 2.418 = =');
    expect(mergeOcr('NODWIN CLUTCH\n$100 — $190.00', 'NODWIN CLUTCH\n3DMAX\n1.90')).toBe('NODWIN CLUTCH\n$100 — $190.00\n3DMAX 1.90');
  });
  it('a match we do not have: the teams written in the post', () => {
    const p = parseTgPost('Спробую таку взяти\n📊 Тип прогнозу: Match Winner - magic\n💰 Коефіцієнт: 1.72\n🎯 Посилання на гру: https://www.hltv.org/matches/2395660/magic-vs-inner-circle-res-showdown-4-europe-blast-premier-rising-event', '2026-07-10T16:25:00Z', C);
    expect(p).toMatchObject({ kind: 'bet', match: { id: 'tg:2026-07-10:magic:inner-circle', team1: 'Magic', team2: 'Inner Circle' }, market: 'Match Winner', pick: 'Magic', odds: 1.72 });
  });
  it('a ticket where OCR glued «OGvsBBTeam» and read «ВВ Team» in Cyrillic', () => {
    const ocr = '$? Виграш\n2026-08-04\nOG OGvsBBTeam [3\n© ПЕРЕМОЖЕЦЬ МАТЧУ\nВВ Теат\nСУМА КОЕФЦИЕНТ\n25000 1.37\nBurpaw (© ПЕРЕМОЖЕЦЬ МАТЧУ ВВ Team #5000 1.37 ПРОФИТ ЗАГАЛЬНА СУМА';
    expect(parseTgPost('взяв таку ставку на доту сьогодні\n' + ocr, '2026-08-04T14:05:00Z', [])).toMatchObject({ kind: 'bet', match: { team1: 'OG', team2: 'BB Team', game: 'dota2' }, market: 'Match Winner', pick: 'BB Team', odds: 1.37 });
  });
  it('teams from «A vs B» stop at scores and ticket words', () => {
    expect(teamsFromText('Team OG vs Aurora Gaming 0:0 и!')).toEqual(['Team OG', 'Aurora Gaming']);
    expect(teamsFromText('просто текст без матчу')).toBeNull();
  });
  it('page: a poll is marked', () => {
    const html = `<div class="tgme_widget_message" data-post="ch/9"><div class="tgme_widget_message_poll js-poll"><div class="tgme_widget_message_poll_question">Хто виграє?</div></div><time datetime="2026-11-26T10:00:00+00:00"></time></div>`;
    expect(parseTgPage(html).posts[0]).toMatchObject({ id: 9, poll: true, text: 'Хто виграє?' });
  });
});

import { slipFromOcr } from './tgOcr';
describe('slip money from OCR', () => {
  it('reads the stake across the spaces OCR puts into numbers', () => {
    const t = '26 ноября 2026 г. в 16:06 4\nID 415437741 Фу\nОткрыта Ординар (1573)\nСумма ставки 1 55,00 USDT\nВозможный выигрыш\n2 43,35 USDT\nСобытие 1';
    expect(slipFromOcr(t)).toEqual({ status: 'pending', stake: 155, currency: 'USDT', payout: 243.35, odds: 1.57 });
  });
  it('a won slip', () => {
    expect(slipFromOcr('Выиграна • Ординар 1.57\nСумма ставки 155,00 USDT\nВыигрыш 243,35 USDT')).toMatchObject({ status: 'won', stake: 155, payout: 243.35 });
  });
  it('no stake — no slip', () => { expect(slipFromOcr('NAVI — Spirit 1.85')).toBe(null); });
});

describe('OCR money split by spaces', () => {
  it('is joined back', () => {
    expect(cleanOcr('Сумма ставки 1 55,00 USDT\nВыигрыш 2 43,35 USDT\nWildcard 13 1')).toBe('Сумма ставки 155,00 USDT\nВыигрыш 243,35 USDT\nWildcard 13 1');
  });
});
