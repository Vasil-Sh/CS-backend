import { describe, expect, it } from 'vitest';
import { linkKey, linkState, mainReason, screenText, segments } from './groupScreening';

describe('screenText', () => {
  it('finds fixed-match and scam phrases with positions', () => {
    const t = 'Договорняк 100% на сьогодні, пиши в ЛС за ціною';
    const hits = screenText(t);
    expect(hits.map((h) => h.phrase.toLowerCase())).toEqual(['договорняк', 'пиши в лс за ціною']);
    expect(t.slice(hits[0].from, hits[0].to)).toBe('Договорняк');
    expect(mainReason(hits)).toBe('fixed');
  });
  it('a clean description has no hits', () => expect(screenText('Розбір матчів CS2 щодня: статистика карт')).toEqual([]));
  it('segments keep the whole text', () => {
    const t = 'Злив з першоджерела, гарантований заліз';
    expect(segments(t).map((p) => p.t).join('')).toBe(t);
    expect(segments(t).filter((p) => p.hl).length).toBe(2);
  });
});

describe('links', () => {
  it('states', () => {
    expect(linkState('t.me/cs2prognoz')).toBe('ok');
    expect(linkState('@cs2prognoz')).toBe('ok');
    expect(linkState('https://t.me/+AbCdEf123')).toBe('private');
    expect(linkState('')).toBe('none');
    expect(linkState('instagram.com/x')).toBe('bad');
  });
  it('same group, different spellings', () => {
    expect(linkKey('https://t.me/CS2prognoz/')).toBe('cs2prognoz');
    expect(linkKey('@cs2prognoz')).toBe('cs2prognoz');
  });
});
