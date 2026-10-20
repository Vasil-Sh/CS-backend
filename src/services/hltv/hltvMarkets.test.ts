import { describe, expect, it } from 'vitest';
import { applyHltvMarket, findMarketUrl, hltvMatchUrl, parseHltvMarket,
  parseHltvMarketListing } from './hltvMarkets';
import type { TipsGgMatch } from '../tipsggScraper';

const teams = '<div class="teamsBox"><span class="teamName">FaZe</span><span class="teamName">ASTRAL</span></div>';
const votes = (a: string, b: string) => `<span class="pick-a-winner-team-percentage team-1">${a}</span><span class="pick-a-winner-team-percentage team-2">${b}</span>`;
const row = (provider: string, a: string, b: string) => `<tr class="provider"><td><a class="betting-logo-link" aria-label="Go to ${provider}"></a></td><td class="odds-cell">${a}</td><td class="odds-cell">${b}</td></tr>`;
const odds = (...rows: string[]) => `<section class="betting-section"><table>${rows.join('')}</table></section>`;
const match = { nameTeam1: 'FaZe', nameTeam2: 'ASTRAL', startDate: '2026-10-20T11:00:00Z',
  link: '/matches/counter-strike/faze-astral/', pred1: null, pred2: null,
  coeff1: null, coeff2: null } as TipsGgMatch;

describe('HLTV market parsing and alignment', () => {
  it('extracts community votes independently from odds', () => {
    expect(parseHltvMarket(teams + votes('92.1%', '7.9%') + odds(row('ggua', '1.09', '6.60'))))
      .toMatchObject({ pred1: 92.1, pred2: 7.9, coeff1: 1.09, coeff2: 6.6, provider: 'ggua' });
  });
  it('keeps absent data unknown, not zero or 50/50', () => {
    expect(parseHltvMarket(teams)).toMatchObject({ pred1: null, pred2: null, coeff1: null, coeff2: null });
    expect(parseHltvMarket('<title>Just a moment...</title>')).toBeNull();
  });
  it('allows real 0/100 and decimal commas, rejects incomplete percentages', () => {
    expect(parseHltvMarket(teams + votes('0%', '100%'))?.pred1).toBe(0);
    expect(parseHltvMarket(teams + votes('92,1%', '7,9%'))?.pred1).toBe(92.1);
    expect(parseHltvMarket(teams + votes('92%', ''))?.pred1).toBeNull();
    expect(parseHltvMarket(teams + votes('0%', '0%'))?.pred1).toBeNull();
  });
  it('falls back to another complete provider without mixing sides', () => {
    expect(parseHltvMarket(teams + odds(row('ggua', '1.09', '-'), row('other', '1,15', '5.00'))))
      .toMatchObject({ coeff1: 1.15, coeff2: 5, provider: 'other' });
  });
  it('swaps both pairs when source team order is reversed', () => {
    const market = parseHltvMarket(teams + votes('92.1%', '7.9%') + odds(row('ggua', '1.09', '6.60')))!;
    expect(applyHltvMarket({ ...match, nameTeam1: 'ASTRAL', nameTeam2: 'FaZe' }, market))
      .toMatchObject({ pred1: 7.9, pred2: 92.1, coeff1: 6.6, coeff2: 1.09 });
    expect(applyHltvMarket({ ...match, nameTeam1: 'FaZe Academy' }, market).pred1).toBeNull();
  });
  it('does not erase existing values when source has no market', () => {
    expect(applyHltvMarket({ ...match, coeff1: 2, coeff2: 3 }, parseHltvMarket(teams)!))
      .toMatchObject({ coeff1: 2, coeff2: 3 });
  });
  it('only permits canonical public HLTV match URLs', () => {
    expect(hltvMatchUrl('/matches/2399610/faze-vs-astral')).toBe('https://www.hltv.org/matches/2399610/faze-vs-astral');
    for (const url of ['https://evil.test/matches/123/x', 'http://localhost/matches/123/x',
      'https://www.hltv.org.evil.test/matches/123/x', '/matches/counter-strike/test'])
      expect(hltvMatchUrl(url)).toBeNull();
  });
  it('resolves listing by teams and time, rejects ambiguous rematches', () => {
    const listing = parseHltvMarketListing(`<div class="match-wrapper"><a class="match-teams" href="/matches/2399610/faze-vs-astral"></a><span class="match-teamname">FaZe</span><span class="match-teamname">ASTRAL</span><span class="match-time" data-unix="${Date.parse(match.startDate)}"></span></div>`);
    expect(findMarketUrl(match, listing)).toContain('2399610');
    expect(findMarketUrl(match, [...listing, ...listing])).toBeNull();
    expect(findMarketUrl({ ...match, startDate: '2026-10-22T11:00:00Z' }, listing)).toBeNull();
  });
});
