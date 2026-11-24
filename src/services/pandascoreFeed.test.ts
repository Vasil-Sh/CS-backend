import { describe, it, expect } from 'vitest';
import { psToMatch, pandascoreMatches, __setPandaScoreCache, type PsMatch } from './pandascoreFeed';
import { addExtra } from './matchFeed';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ps = (over: Partial<PsMatch> = {}): PsMatch => ({
  id: 1001, status: 'not_started', begin_at: '2026-11-25T15:00:00Z', number_of_games: 3, match_type: 'best_of',
  opponents: [{ type: 'Team', opponent: { id: 1, name: 'Team Spirit', image_url: 'https://cdn.pandascore.co/a.png' } }, { type: 'Team', opponent: { id: 2, name: 'Gaimin Gladiators', image_url: null } }],
  results: [{ team_id: 1, score: 0 }, { team_id: 2, score: 0 }],
  tournament: { name: 'Group A', tier: 'b' }, league: { name: 'DreamLeague', image_url: 'https://cdn.pandascore.co/l.png' }, serie: { full_name: 'Season 27 2026' },
  ...over,
});

describe('psToMatch', () => {
  it('maps teams, format, tier, tournament and stage', () => {
    expect(psToMatch(ps(), NOW)).toMatchObject({
      id: 'ps-1001', type: 'BO3', status: 'upcoming', nameTeam1: 'Team Spirit', nameTeam2: 'Gaimin Gladiators',
      logoTeam1: 'https://cdn.pandascore.co/a.png', logoTeam2: null, tier: 'B', tournament: 'DreamLeague Season 27 2026', stage: 'Group A', score1: null,
    });
  });
  it('running gives the live series score, finished the final one', () => {
    expect(psToMatch(ps({ status: 'running', results: [{ team_id: 1, score: 1 }, { team_id: 2, score: 0 }] }), NOW)).toMatchObject({ status: 'live', score1: 1, score2: 0 });
    expect(psToMatch(ps({ status: 'finished', results: [{ team_id: 1, score: 1 }, { team_id: 2, score: 2 }] }), NOW)).toMatchObject({ status: 'finished', score1: 1, score2: 2 });
  });
  it('drops canceled, TBD and unranked matches', () => {
    expect(psToMatch(ps({ status: 'canceled' }), NOW)).toBeNull();
    expect(psToMatch(ps({ opponents: [ps().opponents![0]] }), NOW)).toBeNull();
    expect(psToMatch(ps({ tournament: { name: 'Showmatch', tier: 'unranked' } }), NOW)).toBeNull();
  });
});

describe('pandascoreMatches + addExtra', () => {
  it('one list per game, no duplicate of a Liquipedia match', () => {
    process.env.PANDASCORE_API_KEY = 'test';
    __setPandaScoreCache({ dota2: { upcoming: [ps(), ps({ id: 1002, opponents: [{ opponent: { id: 3, name: 'Tundra' } }, { opponent: { id: 4, name: 'BetBoom Team' } }] })] } });
    const ours = [{ ...psToMatch(ps(), NOW)!, id: 'lp-x', nameTeam1: 'Gaimin Gladiators', nameTeam2: 'Spirit', logoTeam2: null, startDate: '2026-11-25T16:00:00Z' }];
    const extra = pandascoreMatches('dota2', NOW);
    expect(extra.map((m) => m.id)).toEqual(['ps-1001', 'ps-1002']);
    expect(addExtra(ours, extra)).toBe(1);
    expect(ours.map((m) => m.id).sort()).toEqual(['lp-x', 'ps-1002']);
    expect(ours.find((m) => m.id === 'lp-x')!.logoTeam2).toBe('https://cdn.pandascore.co/a.png'); // swapped: Spirit's logo filled in
    expect(pandascoreMatches('cs2', NOW)).toEqual([]);
    delete process.env.PANDASCORE_API_KEY;
  });
});

describe('aliasPairs', () => {
  const t = (id: number, name: string, acronym: string | null) => ({ type: 'Team', opponent: { id, name, acronym } });
  it('keeps a distinct short name, skips same-as-name, too short, and shared or clashing ones', async () => {
    const { aliasPairs } = await import('./pandascoreFeed');
    const lists = [
      { id: 1, opponents: [t(1, 'PARIVISION', 'PVISION'), t(2, 'Natus Vincere', 'NAVI')] },
      { id: 2, opponents: [t(3, 'G2 Esports', 'G2'), t(4, 'MOUZ', 'MOUZ')] },
      { id: 3, opponents: [t(5, 'Team A', 'ABC'), t(6, 'Team B', 'ABC')] },
      { id: 4, opponents: [t(7, 'Aurora Gaming', 'NAVI2'), t(8, 'BIG', 'NAVI')] }, // NAVI now shared by 2 teams
    ] as any;
    expect(aliasPairs(lists)).toEqual([{ canonical: 'PARIVISION', alias: 'PVISION' }, { canonical: 'Aurora Gaming', alias: 'NAVI2' }]);
  });
});
