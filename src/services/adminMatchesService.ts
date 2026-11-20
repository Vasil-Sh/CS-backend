/**
 * Admin Matches Service — manual match edits, created matches, merge decisions,
 * team aliases and parser event log. All persisted in Postgres and applied to
 * the schedule feed at read time (see overlayAdminMatches).
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import type { TipsGgMatch } from './tipsggScraper';

export type Game = 'cs2' | 'dota2';
export type MatchStatus = 'upcoming' | 'live' | 'finished' | 'postponed' | 'cancelled';
export type LinkDecision = 'pending' | 'merged' | 'different';
export type ParserEventKind = 'success' | 'failure' | 'rerun';

export interface TeamAlias {
  id: number;
  game: string;
  canonical: string;
  alias: string;
  createdBy: string;
  createdAt: string;
}

export interface MatchOverride {
  id: number;
  game: string;
  matchId: string;
  status: MatchStatus | null;
  startDate: string | null;
  score1: number | null;
  score2: number | null;
  decidedBy: string;
}

export interface ManualMatch {
  id: string;
  game: Game;
  team1: string;
  team2: string;
  tournament: string;
  bo: string;
  startDate: string;
  status: MatchStatus;
  score1: number | null;
  score2: number | null;
  createdBy: string;
  createdAt: string;
}

export interface MatchLink {
  id: number;
  game: string;
  team1: string;
  team2: string;
  matchDate: string;
  linkKey: string;
  officialId: string | null;
  decision: LinkDecision;
  decidedBy: string;
}

export interface ParserEvent {
  id: number;
  source: string;
  event: ParserEventKind;
  message: string;
  createdAt: string;
}

const GAME_RE = /^(cs2|dota2)$/;
const STATUS_RE = /^(upcoming|live|finished|postponed|cancelled)$/;
const DECISION_RE = /^(pending|merged|different)$/;

function cleanGame(game: unknown): Game | null {
  return typeof game === 'string' && GAME_RE.test(game) ? (game as Game) : null;
}

/** Deterministic key for a manual (user-entered) match, mirroring the frontend grouping. */
export function makeLinkKey(game: string, team1: string, team2: string, date: string): string {
  const norm = (s: string) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(team|esports?|gaming|club|academy)\b/g, (w) => (w === 'academy' ? 'academy' : ''))
      .replace(/[^a-z0-9а-яіїєґ]+/g, '');
  const pair = [norm(team1), norm(team2)].sort().join('|');
  return `${game}:${pair}@${String(date).slice(0, 10)}`;
}

export interface HiddenTeam { id: number; game: string; name: string; createdBy: string; createdAt: string }
function rowToHiddenTeam(r: any): HiddenTeam {
  return { id: Number(r.id), game: r.game, name: r.name, createdBy: r.created_by || '', createdAt: new Date(r.created_at).toISOString() };
}

function rowToTeamAlias(r: any): TeamAlias {
  return {
    id: Number(r.id),
    game: r.game,
    canonical: r.canonical,
    alias: r.alias,
    createdBy: r.created_by || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

function rowToOverride(r: any): MatchOverride {
  return {
    id: Number(r.id),
    game: r.game,
    matchId: r.match_id,
    status: r.status,
    startDate: r.start_date ? new Date(r.start_date).toISOString() : null,
    score1: r.score1 == null ? null : Number(r.score1),
    score2: r.score2 == null ? null : Number(r.score2),
    decidedBy: r.decided_by || '',
  };
}

function rowToManualMatch(r: any): ManualMatch {
  return {
    id: String(r.id),
    game: r.game,
    team1: String(r.team1),
    team2: String(r.team2),
    tournament: String(r.tournament || ''),
    bo: String(r.bo || ''),
    startDate: r.start_date ? new Date(r.start_date).toISOString() : '',
    status: r.status,
    score1: r.score1 == null ? null : Number(r.score1),
    score2: r.score2 == null ? null : Number(r.score2),
    createdBy: r.created_by || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

function rowToLink(r: any): MatchLink {
  let matchDate = '';
  if (r.match_date instanceof Date) {
    matchDate = r.match_date.toISOString().slice(0, 10);
  } else if (r.match_date) {
    matchDate = String(r.match_date).slice(0, 10);
  }
  return {
    id: Number(r.id),
    game: r.game,
    team1: r.team1,
    team2: r.team2,
    matchDate,
    linkKey: r.link_key,
    officialId: r.official_id || null,
    decision: r.decision,
    decidedBy: r.decided_by || '',
  };
}

function rowToParserEvent(r: any): ParserEvent {
  return {
    id: Number(r.id),
    source: r.source,
    event: r.event,
    message: r.message || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export const adminMatchesService = {
  // ══════════════════════════ Team aliases ══════════════════════════

  async listTeamAliases(game?: string): Promise<TeamAlias[]> {
    const q = game && GAME_RE.test(game)
      ? { text: 'SELECT * FROM team_aliases WHERE game = $1 ORDER BY canonical, alias', values: [game] }
      : { text: 'SELECT * FROM team_aliases ORDER BY game, canonical, alias', values: [] as unknown[] };
    const { rows } = await pool.query(q);
    return rows.map(rowToTeamAlias);
  },

  async createTeamAlias(input: { game: string; canonical: string; alias: string; createdBy: string }): Promise<TeamAlias> {
    const game = cleanGame(input.game);
    if (!game) throw new Error('Невідома гра');
    const canonical = String(input.canonical || '').trim().slice(0, 200);
    const alias = String(input.alias || '').trim().slice(0, 200);
    if (!canonical || !alias) throw new Error('Назва й псевдонім обов’язкові');
    if (canonical === alias) throw new Error('Псевдонім має відрізнятися від назви');
    const { rows } = await pool.query(
      `INSERT INTO team_aliases(game, canonical, alias, created_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (game, alias) DO UPDATE SET canonical = EXCLUDED.canonical, created_by = EXCLUDED.created_by, updated_at = now()
       RETURNING *`,
      [game, canonical, alias, String(input.createdBy || '').slice(0, 100)],
    );
    return rowToTeamAlias(rows[0]);
  },

  async deleteTeamAlias(id: number): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM team_aliases WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ══════════════════════════ Hidden teams (removed from the directory) ══════════════════════════

  async listHiddenTeams(): Promise<HiddenTeam[]> {
    const { rows } = await pool.query('SELECT * FROM hidden_teams ORDER BY game, name');
    return rows.map(rowToHiddenTeam);
  },

  async hideTeam(input: { game: string; name: string; createdBy: string }): Promise<HiddenTeam> {
    const game = cleanGame(input.game);
    if (!game) throw new Error('Невідома гра');
    const name = String(input.name || '').trim().slice(0, 200);
    if (!name) throw new Error('Назва команди обов’язкова');
    const { rows } = await pool.query(
      `INSERT INTO hidden_teams(game, name, created_by) VALUES($1,$2,$3)
       ON CONFLICT (game, name) DO UPDATE SET created_by = EXCLUDED.created_by
       RETURNING *`,
      [game, name, String(input.createdBy || '').slice(0, 100)],
    );
    return rowToHiddenTeam(rows[0]);
  },

  async unhideTeam(id: number): Promise<HiddenTeam | null> {
    const { rows } = await pool.query('DELETE FROM hidden_teams WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? rowToHiddenTeam(rows[0]) : null;
  },

  // ══════════════════════════ Match overrides ══════════════════════════

  async listOverrides(game?: string): Promise<MatchOverride[]> {
    const q = game && GAME_RE.test(game)
      ? { text: 'SELECT * FROM match_overrides WHERE game = $1 ORDER BY updated_at DESC', values: [game] }
      : { text: 'SELECT * FROM match_overrides ORDER BY updated_at DESC', values: [] as unknown[] };
    const { rows } = await pool.query(q);
    return rows.map(rowToOverride);
  },

  async upsertOverride(input: {
    game: string;
    matchId: string;
    status?: MatchStatus | null;
    startDate?: string | null;
    score1?: number | null;
    score2?: number | null;
    decidedBy: string;
  }): Promise<MatchOverride> {
    const game = cleanGame(input.game);
    if (!game) throw new Error('Невідома гра');
    const matchId = String(input.matchId || '').trim().slice(0, 500);
    if (!matchId) throw new Error('matchId обов’язковий');
    if (input.status != null && !STATUS_RE.test(input.status)) throw new Error('Невідомий статус');
    const startDate = input.startDate ? new Date(input.startDate).toISOString() : null;
    const { rows } = await pool.query(
      `INSERT INTO match_overrides(game, match_id, status, start_date, score1, score2, decided_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (game, match_id) DO UPDATE
         SET status = EXCLUDED.status, start_date = EXCLUDED.start_date,
             score1 = EXCLUDED.score1, score2 = EXCLUDED.score2,
             decided_by = EXCLUDED.decided_by, updated_at = now()
       RETURNING *`,
      [game, matchId, input.status ?? null, startDate, input.score1 ?? null, input.score2 ?? null, String(input.decidedBy || '').slice(0, 100)],
    );
    return rowToOverride(rows[0]);
  },

  async deleteOverride(game: string, matchId: string): Promise<boolean> {
    const g = cleanGame(game);
    if (!g) throw new Error('Невідома гра');
    const { rowCount } = await pool.query('DELETE FROM match_overrides WHERE game = $1 AND match_id = $2', [g, matchId]);
    return (rowCount ?? 0) > 0;
  },

  // ══════════════════════════ Manual matches ══════════════════════════

  async listManualMatches(game?: string): Promise<ManualMatch[]> {
    const q = game && GAME_RE.test(game)
      ? { text: 'SELECT * FROM manual_matches WHERE game = $1 ORDER BY start_date ASC', values: [game] }
      : { text: 'SELECT * FROM manual_matches ORDER BY start_date ASC', values: [] as unknown[] };
    const { rows } = await pool.query(q);
    return rows.map(rowToManualMatch);
  },

  async createManualMatch(input: {
    game: string;
    team1: string;
    team2: string;
    tournament?: string;
    bo?: string;
    startDate: string;
    status?: MatchStatus;
    score1?: number | null;
    score2?: number | null;
    createdBy: string;
  }): Promise<ManualMatch> {
    const game = cleanGame(input.game);
    if (!game) throw new Error('Невідома гра');
    const team1 = String(input.team1 || '').trim().slice(0, 200);
    const team2 = String(input.team2 || '').trim().slice(0, 200);
    if (!team1 || !team2) throw new Error('Назви обох команд обов’язкові');
    const startDate = new Date(input.startDate);
    if (Number.isNaN(startDate.getTime())) throw new Error('Невірна дата початку');
    const status = input.status && STATUS_RE.test(input.status) ? input.status : 'upcoming';
    const id = `manual-${randomUUID()}`;
    const { rows } = await pool.query(
      `INSERT INTO manual_matches(id, game, team1, team2, tournament, bo, start_date, status, score1, score2, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, game, team1, team2, String(input.tournament || '').slice(0, 500), String(input.bo || '').slice(0, 20), startDate.toISOString(), status, input.score1 ?? null, input.score2 ?? null, String(input.createdBy || '').slice(0, 100)],
    );
    return rowToManualMatch(rows[0]);
  },

  async deleteManualMatch(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM manual_matches WHERE id = $1', [String(id)]);
    return (rowCount ?? 0) > 0;
  },

  // ══════════════════════════ Merge decisions ══════════════════════════

  async listLinks(game?: string): Promise<MatchLink[]> {
    const q = game && GAME_RE.test(game)
      ? { text: 'SELECT * FROM match_links WHERE game = $1 ORDER BY updated_at DESC', values: [game] }
      : { text: 'SELECT * FROM match_links ORDER BY updated_at DESC', values: [] as unknown[] };
    const { rows } = await pool.query(q);
    return rows.map(rowToLink);
  },

  async linkMatch(input: {
    game: string;
    team1: string;
    team2: string;
    date: string;
    officialId?: string | null;
    decision: LinkDecision;
    decidedBy: string;
  }): Promise<MatchLink> {
    const game = cleanGame(input.game);
    if (!game) throw new Error('Невідома гра');
    if (!DECISION_RE.test(input.decision)) throw new Error('Невідоме рішення');
    const team1 = String(input.team1 || '').trim().slice(0, 200);
    const team2 = String(input.team2 || '').trim().slice(0, 200);
    const date = String(input.date || '').slice(0, 10);
    if (!team1 || !team2 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Неповні дані матчу');
    const linkKey = makeLinkKey(game, team1, team2, date);
    const officialId = input.decision === 'merged' ? String(input.officialId || '').slice(0, 500) || null : null;
    const { rows } = await pool.query(
      `INSERT INTO match_links(game, team1, team2, match_date, link_key, official_id, decision, decided_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (link_key) DO UPDATE
         SET official_id = EXCLUDED.official_id, decision = EXCLUDED.decision,
             decided_by = EXCLUDED.decided_by, updated_at = now()
       RETURNING *`,
      [game, team1, team2, date, linkKey, officialId, input.decision, String(input.decidedBy || '').slice(0, 100)],
    );
    return rowToLink(rows[0]);
  },

  // ══════════════════════════ Parser events ══════════════════════════

  /** Fire-and-forget log — never blocks the scraper. */
  logParserEvent(source: string, event: ParserEventKind, message = ''): void {
    const src = String(source || '').slice(0, 50);
    if (!src) return;
    void pool
      .query('INSERT INTO parser_events(source, event, message) VALUES($1,$2,$3)', [src, event, String(message || '').slice(0, 2000)])
      .catch((err) => console.warn('[adminMatches] logParserEvent failed:', (err as Error).message));
  },

  async listParserEvents(source?: string, limit = 100): Promise<ParserEvent[]> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const q = source
      ? { text: 'SELECT * FROM parser_events WHERE source = $1 ORDER BY created_at DESC LIMIT $2', values: [String(source).slice(0, 50), n] }
      : { text: 'SELECT * FROM parser_events ORDER BY created_at DESC LIMIT $1', values: [n] };
    const { rows } = await pool.query(q);
    return rows.map(rowToParserEvent);
  },

  /** Hourly availability: success / failure counts per hour over the last N hours. */
  async parserAvailability(source: string, hours = 48): Promise<{ hour: string; success: number; failure: number }[]> {
    const h = Math.min(Math.max(Number(hours) || 48, 1), 24 * 30);
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD"T"HH24:00') AS hour,
              COUNT(*) FILTER (WHERE event = 'success')::int AS success,
              COUNT(*) FILTER (WHERE event IN ('failure'))::int AS failure
       FROM parser_events
       WHERE source = $1 AND created_at > now() - ($2 || ' hours')::interval
       GROUP BY 1 ORDER BY 1`,
      [String(source).slice(0, 50), h],
    );
    return rows.map((r: any) => ({ hour: r.hour, success: Number(r.success), failure: Number(r.failure) }));
  },

  // ══════════════════════════ Feed overlay ══════════════════════════

  /**
   * Apply admin data to a schedule feed at read time:
   *  1. Manual overrides (status / time / score) win over scraper data.
   *  2. Manually created matches are appended to the schedule.
   */
  async overlayAdminMatches(game: Game, matches: TipsGgMatch[]): Promise<TipsGgMatch[]> {
    try {
      const [overrides, manual] = await Promise.all([
        this.listOverrides(game),
        this.listManualMatches(game),
      ]);

      // Matches in `matches` are the scraper cache's own objects: copy before
      // applying an override, so deleting the override shows the scraper data
      // again on the next read instead of waiting for a cache refresh.
      const overrideMap = new Map(overrides.map((o) => [o.matchId, o]));
      for (let i = 0; i < matches.length; i++) {
        const o = overrideMap.get(matches[i].id);
        if (!o) continue;
        const m = { ...matches[i] };
        if (o.status) (m as { status: string }).status = o.status;
        if (o.score1 != null) m.score1 = o.score1;
        if (o.score2 != null) m.score2 = o.score2;
        if (o.startDate) { m.startDate = o.startDate; m.date = o.startDate.slice(0, 10); }
        matches[i] = m;
      }

      // Same window as the feed: today (UTC) and later.
      const today = new Date().toISOString().slice(0, 10);
      for (const mm of manual) {
        if (mm.startDate && mm.startDate.slice(0, 10) < today) continue;
        const feedStatus: TipsGgMatch['status'] =
          mm.status === 'live' ? 'live' : mm.status === 'finished' ? 'finished' : 'upcoming';
        matches.push({
          id: mm.id,
          date: mm.startDate ? mm.startDate.slice(0, 10) : '',
          link: '',
          type: mm.bo || 'BO3',
          score1: mm.score1,
          score2: mm.score2,
          nameTeam1: mm.team1,
          nameTeam2: mm.team2,
          logoTeam1: null,
          logoTeam2: null,
          tournament: mm.tournament,
          stage: '',
          status: feedStatus,
          tipsCount: 0,
          performer: null,
          startDate: mm.startDate,
          pred1: null,
          pred2: null,
          coeff1: null,
          coeff2: null,
          positionTeam1: null,
          positionTeam2: null,
          tournamentLogo: null,
        } as TipsGgMatch);
      }
    } catch (err) {
      console.error(`[adminMatches] overlay ${game} failed:`, (err as Error).message);
    }
    return matches;
  },
};
