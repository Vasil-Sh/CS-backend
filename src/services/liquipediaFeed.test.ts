import { describe, expect, it } from 'vitest';
import { parseTicker } from './liquipediaFeed';
import { addOdds } from './matchFeed';
import { toMatch } from './oddspapiFeed';

// Markup of Liquipedia's «match-info» ticker (MatchTicker module), trimmed to what we read.
const team = (name: string, short = name, cls = '') =>
  `<div class="match-info-header-opponent${cls}"><div class="block-team"><span class="team-template-image-icon"><a href="/counterstrike/${name.replace(/ /g, '_')}" title="${name}"><img src="/x.png"/></a></span><span class="name"><a href="/counterstrike/${name.replace(/ /g, '_')}" title="${name}">${short}</a></span></div></div>`;
const block = (ts: number, t1: string, t2: string, score: string, bo: string, finished = false, tour = 'IEM Chengdu 2026 - Playoffs') => `
<div class="match-info"><span class="match-info-countdown"><span class="timer-object" data-format="full" data-timestamp="${ts}"${finished ? ' data-finished="finished"' : ''}>date</span></span>
<div class="match-info-header">${team(t1, t1.split(' ')[0], ' match-info-header-opponent-left')}
<div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper">${score}</span><span class="match-info-header-scoreholder-lower">(${bo})</span></span></div>
${team(t2)}</div>
<div class="match-info-tournament"><span class="match-info-tournament-name"><a href="/counterstrike/IEM" title="IEM"><span>${tour}</span></a></span></div></div>`;
const sc = (a: number, b: number) => `<span class="match-info-header-scoreholder-score">${a}</span><span class="match-info-header-scoreholder-divider">:</span><span class="match-info-header-scoreholder-score">${b}</span>`;

describe('Liquipedia ticker', () => {
  const now = Date.UTC(2026, 10, 22, 15, 0) ;
  const s = now / 1000;
  const html = [
    block(s + 3600, 'G2 Esports', 'Astralis', 'vs', 'Bo3'),
    block(s - 1800, 'Natus Vincere', 'FaZe Clan', sc(1, 0), 'Bo3'),
    block(s - 7200, 'Team Spirit', 'MOUZ', sc(2, 1), 'Bo3', true),
    block(s - 7200, 'Team Spirit', 'MOUZ', sc(1, 1), 'Bo3'), // same match in «upcoming» before Liquipedia caught up
    block(s + 9000, 'TBD', 'Vitality', 'vs', 'Bo5'),
  ].join('');
  const list = parseTicker(html, 'cs2', now);

  it('reads teams by their full page title, time, BO and tournament', () => {
    const g2 = list.find((m) => m.nameTeam1 === 'G2 Esports')!;
    expect(g2).toMatchObject({ nameTeam2: 'Astralis', type: 'BO3', status: 'upcoming', score1: null, tournament: 'IEM Chengdu 2026 - Playoffs' });
    expect(g2.startDate).toBe(new Date((s + 3600) * 1000).toISOString());
    expect(g2.id).toMatch(/^lp-cs2-2026-11-22-g2-esports-vs-astralis$/);
  });

  it('started without «finished» is live with its series score; «finished» wins over a stale copy', () => {
    expect(list.find((m) => m.nameTeam1 === 'Natus Vincere')).toMatchObject({ status: 'live', score1: 1, score2: 0 });
    const spirit = list.filter((m) => m.nameTeam1 === 'Team Spirit');
    expect(spirit).toHaveLength(1);
    expect(spirit[0]).toMatchObject({ status: 'finished', score1: 2, score2: 1 });
  });

  it('skips matches with an undecided team', () => {
    expect(list.some((m) => /tbd/i.test(m.nameTeam1))).toBe(false);
    expect(list).toHaveLength(3);
  });

  it('gets odds from OddsPapi for the same match, sides swapped', () => {
    const g2 = list.find((m) => m.nameTeam1 === 'G2 Esports')!;
    const odds = toMatch({
      fixtureId: 'x', sportId: 17, statusId: 0, startTime: new Date((s + 3600 + 600) * 1000).toISOString(),
      participant1Name: 'Astralis', participant2Name: 'G2 Esports',
      bookmakerOdds: { pinnacle: { markets: { '171': { outcomes: { '171': { players: { '0': { price: 2.4 } } }, '172': { players: { '0': { price: 1.55 } } } } } } } },
    }, ['171'])!;
    expect(addOdds([g2], [odds])).toBe(1);
    expect(g2).toMatchObject({ coeff1: 1.55, coeff2: 2.4, performer: 'G2 Esports' });
  });
});
