/**
 * HLTV Match Types — shared between hltvMatchesParser and hltvScraper.
 */

/** Raw match from HLTV listing page (MatchesParser.js output). */
export interface HltvMatch {
  dateText: string | null;
  eventName: string | null;
  isLive: boolean;
  type: string | null; // e.g. "bo3"
  team1: string | null;
  team2: string | null;
  url: string | null;
  unixTime: number | null; // milliseconds
  odds1: number | null;
  odds2: number | null;
}

/** Detailed game info from match page (GameParser.js output). */
export interface HltvGameDetail {
  nameTeam1: string;
  nameTeam2: string;
  event: string;
  unixTime: number | null;
  type: string; // "bo3", "bo5", "bo1"
  score1: number;
  score2: number;
  isMatchOver: boolean;
  isLive: boolean;
}

/** Basic details from GameBasicDetailsParser.js */
export interface HltvGameBasicDetail {
  team1: string;
  team2: string;
  score1: number;
  score2: number;
  event: string;
  date: string;
  type: string;
  isLive: boolean;
  isMatchOver: boolean;
}

/** Map vetos from MapsParser.js */
export interface HltvMap {
  name: string;
  result: string; // "picked", "removed", "default", "played"
  team?: string; // which team picked/removed
  score1?: number;
  score2?: number;
}

/** Team basic info from TeamBasicParser.js */
export interface HltvTeamBasic {
  name: string;
  logo: string | null;
  rank: number | null;
}

// ── Actual JS output types (match the .js files exactly) ──

/** TeamBasicParser.js output: HLTV world ranking. */
export interface HltvRankedTeam {
  Position: number;
  Name: string;
  Points: number;
  HltvId: number | null;
  DatePlayersParsed: string | null;
  DateGamesParsed: string | null;
  Comment: string | null;
}

/** MapsParser.js output: team map statistics. */
export interface HltvTeamMapStat {
  id: number;
  name: string;
  timesPlayed: number;
  CtWinsPercent: number;
  TWinsPercent: number;
}

/** GameDetailsParser.js output: per-map scores + coefficients + logos. */
export interface HltvGameDetailsFull {
  Player1Name: string;
  Player2Name: string;
  PredictionPercentTeam1: number;
  PredictionPercentTeam2: number;
  CoefficientTeam1: number;
  CoefficientTeam2: number;
  BettingLink: string;
  LogoTeam1: string | null;  // base64 data URI
  LogoTeam2: string | null;  // base64 data URI
  gameDetails: HltvMapDetail[];
}

/** Per-map detail from GameDetailsParser.js */
export interface HltvMapDetail {
  MapName: string;
  Link: string;
  GameNumber: number;
  Player1Score: number;
  Player1Lost: boolean;
  Player1Won: boolean;
  Player1Pick: boolean;
  Player1Score1: number;
  Player1Side1: string; // "ct" | "t" | "-"
  Player1Score2: number;
  Player1Side2: string;
  Player1Score3: number;
  Player1Side3: string;
  Player2Score: number;
  Player2Lost: boolean;
  Player2Won: boolean;
  Player2Pick: boolean;
  Player2Score1: number;
  Player2Side1: string;
  Player2Score2: number;
  Player2Side2: string;
  Player2Score3: number;
  Player2Side3: string;
}

/** Unified match format returned by our API (compatible with existing frontend). */
export interface HltvUnifiedMatch {
  id: string;
  date: string;
  link: string;
  type: string;
  score1: number | null;
  score2: number | null;
  nameTeam1: string;
  nameTeam2: string;
  logoTeam1: string | null;
  logoTeam2: string | null;
  tournament: string;
  stage: string;
  status: 'upcoming' | 'live' | 'finished';
  tipsCount: number;
  performer: string | null;
  startDate: string;
  pred1: number;
  pred2: number;
  coeff1: number | null;
  coeff2: number | null;
  source: 'hltv'; // distinguish from tips.gg matches
}
