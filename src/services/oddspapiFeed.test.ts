import { describe, expect, it } from 'vitest';
import { oddsTournaments, pickWinnerMarkets, toMatch, winnerPrices, type RawFixture } from './oddspapiFeed';
import { applySeries, buildSeries } from './opendotaScores';

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const fixture = (o: Partial<RawFixture> = {}): RawFixture => ({
  fixtureId: 'id1',
  sportId: 17,
  tournamentId: 51216,
  statusId: 0,
  startTime: inHours(5),
  participant1Name: 'NAVI',
  participant2Name: 'FaZe',
  tournamentName: 'IEM Chengdu',
  bookmakerOdds: {
    '1xbet': { markets: { '171': { outcomes: { '171': { players: { '0': { price: 1.9, active: true } } }, '172': { players: { '0': { price: 1.95, active: true } } } } } } },
    pinnacle: { markets: { '171': { outcomes: { '172': { players: { '0': { price: 2.1, active: true } } }, '171': { players: { '0': { price: 1.75, active: true } } } } } } },
  },
  ...o,
});

describe('OddsPapi → match', () => {
  it('takes the winner price from Pinnacle first, team 1 = lower outcome id', () => {
    expect(winnerPrices(fixture(), ['171'])).toEqual({ coeff1: 1.75, coeff2: 2.1 });
  });

  it('skips a bookmaker whose price is inactive', () => {
    const f = fixture();
    f.bookmakerOdds!.pinnacle.markets!['171'].outcomes!['171'].players!['0'].active = false;
    expect(winnerPrices(f, ['171'])).toEqual({ coeff1: 1.9, coeff2: 1.95 });
  });

  it('has no odds when no winner market is present', () => {
    expect(winnerPrices(fixture(), ['999'])).toEqual({ coeff1: null, coeff2: null });
  });

  it('maps the fixture to the tips.gg match shape', () => {
    const m = toMatch(fixture(), ['171'])!;
    expect(m.id).toBe('op-id1');
    expect(m.nameTeam1).toBe('NAVI');
    expect(m.tournament).toBe('IEM Chengdu');
    expect(m.status).toBe('upcoming');
    expect(m.performer).toBe('NAVI');
    expect(m.date).toBe(m.startDate.slice(0, 10));
  });

  it('drops cancelled fixtures and treats long-started ones as finished', () => {
    expect(toMatch(fixture({ statusId: 3 }), ['171'])).toBeNull();
    expect(toMatch(fixture({ startTime: inHours(-1) }), ['171'])!.status).toBe('live');
    expect(toMatch(fixture({ startTime: inHours(-7), statusId: 1 }), ['171'])!.status).toBe('finished');
  });

  it('asks odds only for tournaments playing in the next 36 h, busiest first, at most 10', () => {
    const fx = (id: string, t: number, h: number, statusId = 0) => fixture({ fixtureId: id, tournamentId: t, startTime: inHours(h), statusId });
    const list = [fx('a', 1, 3), fx('b', 2, 5), fx('c', 2, 8), fx('d', 3, 60), fx('e', 4, -5), fx('f', 5, 2, 3)];
    expect(oddsTournaments(list)).toEqual([2, 1]);
    const many = Array.from({ length: 14 }, (_, i) => fx(`m${i}`, 100 + i, 4));
    expect(oddsTournaments(many)).toHaveLength(10);
  });

  it('finds full-match winner markets by name, not map or handicap ones', () => {
    const rows = [
      { marketId: 171, marketName: 'Winner', sportId: 17 },
      { marketId: 180, marketName: 'Map 1 Winner', sportId: 17 },
      { marketId: 190, marketName: 'Handicap', sportId: 17 },
      { marketId: 101, marketName: '1X2', sportId: 10 },
      { marketId: 160, marketName: 'Winner', sportId: 16 },
    ];
    expect(pickWinnerMarkets(rows)).toEqual(['171', '160']);
  });
});

describe('OpenDota series scores', () => {
  const t0 = Math.floor(Date.now() / 1000) - 3600;
  const games = [
    { match_id: 1, start_time: t0, radiant_name: 'Team Spirit', dire_name: 'Tundra Esports', series_id: 9, series_type: 1, radiant_win: true },
    { match_id: 2, start_time: t0 + 2400, radiant_name: 'Tundra Esports', dire_name: 'Team Spirit', series_id: 9, series_type: 1, radiant_win: true },
  ];

  it('counts wins per team across sides and knows a BO3 at 1:1 is still on', () => {
    const [s] = buildSeries(games, [{ team_name_radiant: 'Team Spirit', team_name_dire: 'Tundra Esports' }]);
    expect(s).toMatchObject({ team1: 'Team Spirit', score1: 1, score2: 1, type: 'BO3', finished: false, live: true });
  });

  it('finishes a BO3 at 2 wins and puts the score on the scheduled match in its order', () => {
    const done = buildSeries([...games, { match_id: 3, start_time: t0 + 4800, radiant_name: 'Team Spirit', dire_name: 'Tundra Esports', series_id: 9, series_type: 1, radiant_win: false }], []);
    expect(done[0]).toMatchObject({ score1: 1, score2: 2, finished: true });
    const m = toMatch(fixture({ sportId: 16, participant1Name: 'Tundra Esports', participant2Name: 'Team Spirit', startTime: new Date(t0 * 1000).toISOString() }), [])!;
    expect(applySeries([m], done)).toBe(1);
    expect(m).toMatchObject({ score1: 2, score2: 1, status: 'finished', type: 'BO3' });
  });

  it('ends a BO2 after both games, even at 1:1', () => {
    const bo2 = games.map((g) => ({ ...g, series_type: 3 }));
    expect(buildSeries(bo2, [])[0]).toMatchObject({ type: 'BO2', score1: 1, score2: 1, finished: true });
  });
});
