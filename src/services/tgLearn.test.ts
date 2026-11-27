import { describe, it, expect } from 'vitest';
import { marketToAi, surelyNotTip, templateTrusted, wrongRead } from './tgLearn';
import { inviteHash, privateHandle, privateId } from './tgAccount';
import { readerAccuracy, readerOrder } from './tgAi';
import { parseTgPost } from './tgPostParser';

const at = '2026-11-26T14:05:00Z';
describe('tg learning', () => {
  it('rules: plain news is not a tip, anything with odds or bet words goes to the reader', () => {
    const p = (t: string) => parseTgPost(t, at, []);
    expect(surelyNotTip('Всім привіт! Сьогодні стрім о 20:00 🔥', p('Всім привіт! Сьогодні стрім о 20:00 🔥'))).toBe(true);
    expect(surelyNotTip('NAVI 1.85 заходимо', p('NAVI 1.85 заходимо'))).toBe(false);
    expect(surelyNotTip('Беру Spirit сьогодні', p('Беру Spirit сьогодні'))).toBe(false);
    expect(surelyNotTip('Сьогодні П1 без сумнівів', p('Сьогодні П1 без сумнівів'))).toBe(false);
    expect(surelyNotTip('Друга карта за нами', p('Друга карта за нами'))).toBe(false);
  });
  it('our market as the reader answer', () => {
    expect(marketToAi('Map 2 Winner', 'NiP', 1.52)).toMatchObject({ isTip: true, market: 'map_winner', map: 2, pick: 'NiP', odds: 1.52 });
    expect(marketToAi('Total Maps Under 2.5', '', 1.9)).toMatchObject({ market: 'total_maps', line: 2.5, over: false, pick: null });
    expect(marketToAi('Handicap -1.5', 'MOUZ', 2.4)).toMatchObject({ market: 'handicap', line: -1.5 });
  });
  it('a reader is wrong only when it read another bet', () => {
    const right = marketToAi('Map 2 Winner', 'Ninjas in Pyjamas', 1.52);
    expect(wrongRead({ isTip: true, team1: 'NiP', team2: 'Liquid', market: 'map_winner', map: 2, pick: 'NiP', odds: 1.52 }, right, 'Ninjas in Pyjamas', 'Team Liquid')).toBe(false);
    expect(wrongRead({ isTip: true, team1: 'Liquid', team2: 'NiP', market: 'map_winner', map: 2, pick: 'NiP', odds: 1.52 }, right, 'Ninjas in Pyjamas', 'Team Liquid')).toBe(false);
    expect(wrongRead({ isTip: true, team1: 'NiP', team2: 'Liquid', market: 'map_winner', map: 2, pick: 'Liquid', odds: 1.52 }, right, 'Ninjas in Pyjamas', 'Team Liquid')).toBe(true);
    expect(wrongRead({ isTip: true, team1: 'NiP', team2: 'Liquid', market: 'map_winner', map: 1, pick: 'NiP', odds: 1.52 }, right, 'Ninjas in Pyjamas', 'Team Liquid')).toBe(true);
    expect(wrongRead({ isTip: true, team1: 'NiP', team2: 'Liquid', market: 'map_winner', map: 2, pick: 'NiP', odds: 15.2 }, right, 'Ninjas in Pyjamas', 'Team Liquid')).toBe(true);
    expect(wrongRead({ isTip: false }, { isTip: false })).toBe(false);
    expect(wrongRead({ isTip: true, market: 'match_winner', pick: 'X' }, { isTip: false })).toBe(true);
  });
  it('a channel template is trusted after 10 agreements', () => {
    expect(templateTrusted({ agree: 9 })).toBe(false);
    expect(templateTrusted({ agree: 10, disagree: 1 })).toBe(true);
    expect(templateTrusted({ agree: 10, disagree: 2 })).toBe(false);
  });
  it('invites and private handles', () => {
    expect(inviteHash('https://t.me/+AbCdEfGhIjKl123')).toBe('AbCdEfGhIjKl123');
    expect(inviteHash('t.me/joinchat/AbCdEfGhIjKl123')).toBe('AbCdEfGhIjKl123');
    expect(inviteHash('https://t.me/cs_2_bets')).toBe(null);
    expect(privateId(privateHandle('1234567'))).toBe('1234567');
    expect(privateId('cs_2_bets')).toBe(null);
  });
  it('a clearly more accurate reader goes first', () => {
    expect(readerOrder().map((p) => p.id)).toEqual(['gemini', 'github', 'cloudflare', 'gemini-lite']);
    readerAccuracy.gemini = { read: 100, wrong: 20 }; readerAccuracy.github = { read: 50, wrong: 2 };
    expect(readerOrder().map((p) => p.id)).toEqual(['github', 'gemini', 'cloudflare', 'gemini-lite']);
    readerAccuracy.github = { read: 10, wrong: 0 }; // too few reads to judge
    expect(readerOrder().map((p) => p.id)).toEqual(['gemini', 'github', 'cloudflare', 'gemini-lite']);
  });
});

import { jsonIn } from './tgAi';
describe('JSON in a model text', () => {
  it('finds the object among words, braces in strings and a trailing comma', () => {
    expect(jsonIn('Here is it: {"isTip": true, "pick": "a{b}", "odds": 1.5,} hope it helps {x}')).toBe('{"isTip": true, "pick": "a{b}", "odds": 1.5}');
    expect(jsonIn('no json')).toBe(null);
  });
});

describe('readerScore', () => {
  it('uses the checked posts once there are 10', async () => {
    const { readerScore } = await import('./tgLearn');
    expect(readerScore(100, 2, 5, 2)).toEqual({ read: 100, wrong: 2 }); // too few checks: corrections only
    expect(readerScore(100, 2, 20, 2)).toEqual({ read: 100, wrong: 10 }); // 10% wrong of what was checked
    expect(readerScore(100, 0, 20, 0)).toEqual({ read: 100, wrong: 0 }); // all confirmed right
  });
});
