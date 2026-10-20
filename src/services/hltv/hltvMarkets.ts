import { load } from 'cheerio';
import type { TipsGgMatch } from '../tipsggScraper';

export interface HltvMarket {
  team1: string;
  team2: string;
  pred1: number | null;
  pred2: number | null;
  coeff1: number | null;
  coeff2: number | null;
  provider: string | null;
}

// Do not strip "academy"/"youth": those are different teams.
export const teamKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const numeric = (text: string) => {
  const value = Number(text.trim().replace('%', '').replace(',', '.'));
  return text.trim() && Number.isFinite(value) ? value : null;
};
export function hltvMatchUrl(value: string): string | null {
  try {
    const url = new URL(value, 'https://www.hltv.org');
    return url.protocol === 'https:' && url.hostname === 'www.hltv.org'
      && /^\/matches\/\d+\//.test(url.pathname)
      ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}

export function parseHltvMarket(html: string): HltvMarket | null {
  const $ = load(html);
  const teams = $('.teamsBox .teamName').map((_, el) => $(el).text().trim()).get();
  if (teams.length !== 2 || teams.some(t => !t)) return null;
  const result: HltvMarket = {
    team1: teams[0], team2: teams[1], pred1: null, pred2: null,
    coeff1: null, coeff2: null, provider: null,
  };
  const p1 = numeric($('.pick-a-winner-team-percentage.team-1').first().text());
  const p2 = numeric($('.pick-a-winner-team-percentage.team-2').first().text());
  if (p1 != null && p2 != null && p1 >= 0 && p2 >= 0 && p1 <= 100
    && p2 <= 100 && Math.abs(p1 + p2 - 100) <= 1) {
    result.pred1 = p1; result.pred2 = p2;
  }
  // Prefer GG when available, otherwise a complete pair from ONE provider.
  const rows = $('.betting-section tr.provider').toArray().sort((a, b) =>
    Number($(b).find('.betting-logo-link').attr('aria-label') === 'Go to ggua')
    - Number($(a).find('.betting-logo-link').attr('aria-label') === 'Go to ggua'));
  for (const row of rows) {
    const cells = $(row).find('.odds-cell');
    const c1 = numeric(cells.eq(0).text()), c2 = numeric(cells.eq(1).text());
    if (c1 != null && c2 != null && c1 > 1 && c2 > 1) {
      result.coeff1 = c1; result.coeff2 = c2;
      result.provider = $(row).find('.betting-logo-link').attr('aria-label')?.replace(/^Go to /, '') || null;
      break;
    }
  }
  return result;
}

export function applyHltvMarket(match: TipsGgMatch, market: HltvMarket): TipsGgMatch {
  const a = teamKey(match.nameTeam1), b = teamKey(match.nameTeam2);
  const x = teamKey(market.team1), y = teamKey(market.team2);
  if (!a || !b || a === b) return match;
  const reverse = a === y && b === x;
  if (!reverse && !(a === x && b === y)) return match;
  return {
    ...match,
    ...(market.pred1 != null && market.pred2 != null ? {
      pred1: reverse ? market.pred2 : market.pred1,
      pred2: reverse ? market.pred1 : market.pred2,
      predictionSource: 'hltv-votes',
    } : {}),
    ...(market.coeff1 != null && market.coeff2 != null ? {
      coeff1: reverse ? market.coeff2 : market.coeff1,
      coeff2: reverse ? market.coeff1 : market.coeff2,
      oddsSource: market.provider,
    } : {}),
  };
}

export interface ListingMatch { url: string; team1: string; team2: string; time: number }
export function parseHltvMarketListing(html: string): ListingMatch[] {
  const $ = load(html);
  const result: ListingMatch[] = [];
  $('.match-wrapper').each((_, el) => {
    const item = $(el);
    const url = hltvMatchUrl(item.find('a.match-teams').attr('href') || '');
    const teams = item.find('.match-teamname').map((_, t) => $(t).text().trim()).get();
    const time = Number(item.find('.match-time[data-unix]').attr('data-unix'));
    if (url && teams.length === 2 && Number.isFinite(time) && time > 0)
      result.push({ url, team1: teams[0], team2: teams[1], time });
  });
  return result;
}
export function findMarketUrl(match: TipsGgMatch, listing: ListingMatch[]): string | null {
  const direct = hltvMatchUrl(match.link);
  if (direct) return direct;
  const time = Date.parse(match.startDate);
  if (!Number.isFinite(time)) return null;
  const a = teamKey(match.nameTeam1), b = teamKey(match.nameTeam2);
  const candidates = listing.filter(m => Math.abs(m.time - time) <= 3 * 3600_000
    && ((teamKey(m.team1) === a && teamKey(m.team2) === b)
      || (teamKey(m.team1) === b && teamKey(m.team2) === a)));
  return candidates.length === 1 ? candidates[0].url : null;
}
