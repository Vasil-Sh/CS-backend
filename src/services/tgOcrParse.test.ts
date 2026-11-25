import { describe, it, expect } from 'vitest';
import { parseTgPost, parseTgPage, type TgCandidate } from './tgPostParser';
import { cleanOcr } from './tgOcr';

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
    expect(parseTgPost(ocr, at, C)).toMatchObject({ kind: 'unknown', reason: 'Ставки на окрему карту поки не рахуємо', match: { id: 'og-aur' }, odds: 2.35 });
  });
  it('one team on the screen → its match around the post time', () => {
    const ocr = 'SS PGL Major\n< © 00:37:02 363 x\nLiquid\nПобеда на карте #2\nili, СТАТИСТИКА\nх 2.418 = =\nКОЭФФИЦИЕНТ ВЫИГРЫШ';
    expect(parseTgPost(ocr, at, C)).toMatchObject({ kind: 'unknown', reason: 'Ставки на окрему карту поки не рахуємо', match: { id: 'nip-liq' }, odds: 2.418 });
    expect(parseTgPost('Liquid\nПобеда\nх 2.418', at, C)).toMatchObject({ kind: 'bet', match: { id: 'nip-liq' }, pick: 'Team Liquid', odds: 2.418 });
  });
  it('the caption «Камбек на 2карту від ЗдМакс» is a map bet', () => {
    expect(parseTgPost('Камбек на 2карту від ЗдМакс\nКарта 2: Переможець карти: 3DMAX 1.90', at, C)).toMatchObject({ kind: 'unknown', reason: 'Ставки на окрему карту поки не рахуємо' });
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
  it('OCR noise lines are dropped', () => {
    expect(cleanOcr('  Liquid \n\n| ~ \n x 2.418 = = ')).toBe('Liquid\nx 2.418 = =');
  });
});
