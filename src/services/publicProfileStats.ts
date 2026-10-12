export type ProfileGame = 'all' | 'cs2' | 'dota2';
export type ProfilePeriod = 'all' | '30d' | '90d' | '365d';
type Numeric = number | string | null | undefined;

export interface ProfileBet {
  id?: string;
  match: string;
  team1?: string | null;
  team2?: string | null;
  logoTeam1?: string | null;
  logoTeam2?: string | null;
  betType?: string | null;
  result: string;
  profit?: Numeric;
  amount?: Numeric;
  odds?: Numeric;
  currency?: string | null;
  originalProfit?: Numeric;
  originalAmount?: Numeric;
  exchangeRate?: Numeric;
  game?: string | null;
  date?: string | Date | null;
  createdAt?: string | Date | null;
}

export const toNumber = (value: Numeric): number => {
  const result = Number(String(value ?? 0).replace(',', '.'));
  return Number.isFinite(result) ? result : 0;
};
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const settled = new Set(['Win', 'Loss', 'Refund', 'Void', 'Push']);
const refunded = new Set(['Refund', 'Void', 'Push']);
export function normalizeProfileGame(value?: string | null) {
  const game = (value || 'CS2').toLowerCase().replace(/\s/g, '');
  if (['dota2', 'dota', 'дота', 'дота2'].includes(game)) return 'dota2';
  if (['cs2', 'cs:go', 'csgo', 'counterstrike2'].includes(game)) return 'cs2';
  return game;
}
function dateKey(value: ProfileBet['date']) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}
function nativeValue(bet: ProfileBet, field: 'profit' | 'amount') {
  if (field === 'profit' && refunded.has(bet.result)) return 0;
  if (String(bet.currency).toUpperCase() !== 'USD') return toNumber(bet[field]);
  const original = field === 'profit' ? bet.originalProfit : bet.originalAmount;
  if (original !== null && original !== undefined) return toNumber(original);
  const rate = toNumber(bet.exchangeRate);
  return rate > 0 ? toNumber(bet[field]) / rate : null;
}

/** All aggregates and the recent list share one scope, BEFORE the five-row limit.
 * Money is converted at one explicit profile rate; no current-rate API or guessed rate.
 * Only public, allowlisted fields are projected into the response.
 */
export function buildPublicProfileStats(
  allBets: ProfileBet[],
  options: { game: ProfileGame; period: ProfilePeriod; exchangeRate?: Numeric; now?: Date },
) {
  const now = options.now || new Date();
  const ordered = [...allBets].sort((a, b) =>
    String(dateKey(b.createdAt || b.date)).localeCompare(dateKey(a.createdAt || a.date)) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const savedRate = toNumber(options.exchangeRate);
  const lastRate = ordered.map(b => toNumber(b.exchangeRate)).find(rate => rate > 0) || 0;
  const exchangeRate = savedRate > 0 ? savedRate : lastRate;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = options.period === 'all' ? 0 : Number.parseInt(options.period, 10);
  if (days) start.setUTCDate(start.getUTCDate() - days + 1);
  const from = days ? start.toISOString().slice(0, 10) : '';
  const to = now.toISOString().slice(0, 10);
  const bets = ordered.filter(bet => {
    const date = dateKey(bet.date || bet.createdAt);
    return (options.game === 'all' || normalizeProfileGame(bet.game) === options.game) &&
      (!from || (!!date && date >= from && date <= to));
  });
  const completed = bets.filter(bet => settled.has(bet.result));
  const wins = completed.filter(b => b.result === 'Win').length;
  const losses = completed.filter(b => b.result === 'Loss').length;
  const decisions = wins + losses;
  let profitUAH = 0, profitUSD = 0, displayProfit = 0, totalStaked = 0;
  let conversionComplete = true;
  const monthMap = new Map<string, { profit: number; count: number; complete: boolean }>();
  for (const bet of completed) {
    const usd = String(bet.currency).toUpperCase() === 'USD';
    const profit = nativeValue(bet, 'profit');
    const amount = nativeValue(bet, 'amount');
    const canConvert = profit !== null && amount !== null && (!usd || exchangeRate > 0);
    if (!canConvert) conversionComplete = false;
    if (usd) profitUSD += profit || 0;
    else profitUAH += profit || 0;
    const converted = (profit || 0) * (usd ? exchangeRate : 1);
    displayProfit += converted;
    // Refunded stakes have no risk exposure and do not dilute ROI.
    if (!refunded.has(bet.result)) totalStaked += (amount || 0) * (usd ? exchangeRate : 1);
    const month = dateKey(bet.date || bet.createdAt).slice(0, 7);
    if (month) {
      const current = monthMap.get(month) || { profit: 0, count: 0, complete: true };
      monthMap.set(month, { profit: current.profit + converted, count: current.count + 1, complete: current.complete && canConvert });
    }
  }
  return {
    schemaVersion: 2,
    filters: { game: options.game, period: options.period },
    exchangeRate: exchangeRate || null,
    exchangeRateSource: savedRate > 0 ? 'profile' : lastRate > 0 ? 'last-bet' : null,
    stats: {
      totalBets: bets.length,
      completedBets: completed.length,
      pendingBets: bets.length - completed.length,
      wins, losses,
      refunds: completed.length - decisions,
      winRate: decisions ? round(wins / decisions * 100) : null,
      totalProfit: round(completed.reduce((sum, b) => sum + (refunded.has(b.result) ? 0 : toNumber(b.profit)), 0)),
      displayProfit: conversionComplete ? round(displayProfit) : null,
      profitUAH: round(profitUAH),
      profitUSD: round(profitUSD),
      conversionComplete,
      totalStaked: conversionComplete ? round(totalStaked) : null,
      roi: conversionComplete && totalStaked > 0 ? round(displayProfit / totalStaked * 100) : null,
      avgOdds: completed.length ? round(completed.reduce((sum, b) => sum + toNumber(b.odds), 0) / completed.length) : null,
    },
    recentBets: bets.slice(0, 5).map(bet => ({
      match: bet.match,
      team1: bet.team1 || '', team2: bet.team2 || '',
      logoTeam1: bet.logoTeam1 || null, logoTeam2: bet.logoTeam2 || null,
      betType: bet.betType || '',
      result: bet.result,
      profit: settled.has(bet.result) ? nativeValue(bet, 'profit') : null,
      currency: String(bet.currency || 'UAH').toUpperCase(),
      odds: toNumber(bet.odds),
      date: dateKey(bet.date || bet.createdAt),
      game: bet.game || 'CS2',
    })),
    monthlyProfit: [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => ({
      month, profit: value.complete ? round(value.profit) : null, count: value.count,
    })),
  };
}
