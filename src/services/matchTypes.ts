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
}
