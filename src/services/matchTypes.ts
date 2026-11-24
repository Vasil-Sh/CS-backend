/**
 * One match in the schedule feed (the shape the app has always received).
 * The name stays from the tips.gg days; the data now comes from Liquipedia + OddsPapi (+ manual matches).
 */
export interface TipsGgMatch {
  id: string;
  date: string;
  link: string;
  type: string; // e.g. "BO2"
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
  performer: string | null; // predicted winner
  startDate: string; // ISO 8601
  pred1: number | null; // tipster prediction % (0-100); null = no real data yet
  pred2: number | null;
  coeff1: number | null; // real bookmaker coefficient from predictions page
  coeff2: number | null;
  positionTeam1: number | null; // HLTV ranking position
  positionTeam2: number | null;
  tournamentLogo: string | null; // operator/tournament logo CDN URL
  /** Liquipedia page of the tournament («PGL/2026/Singapore») — where a missing final score is looked up. */
  tournamentPage?: string;
  /** First prices OddsPapi gave for this match — with coeff1/coeff2 they show how the line moved. */
  openCoeff1?: number | null;
  openCoeff2?: number | null;
  /** Last prices before the start (closing line) — compared with a bet's odds in the journal. */
  closeCoeff1?: number | null;
  closeCoeff2?: number | null;
  /** Best price across the bookmakers OddsPapi returned, and whose it is. */
  bestCoeff1?: number | null;
  bestCoeff2?: number | null;
  bestBook1?: string | null;
  bestBook2?: string | null;
  /** OddsPapi fixture matched to this match (for its score lookup). */
  oddsFixtureId?: string;
  /** Liquipedia tier: S (1) … D (5); null when the page does not say. */
  tier?: 'S' | 'A' | 'B' | 'C' | 'D' | null;
  /** Liquipedia match page («Match:ID_…») — where live map scores are read. */
  matchPage?: string;
  /** Map-by-map score (CS2 live/finished), team1 first. */
  maps?: { map: string; score1: number | null; score2: number | null }[];
}
