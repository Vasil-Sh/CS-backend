import { describe, expect, it } from "vitest";
import {
  buildPublicProfileStats,
  normalizeProfileGame,
  toNumber,
  type ProfileBet,
} from "./publicProfileStats";
const now = new Date("2026-10-12T12:00:00Z");
const bet = (overrides: Partial<ProfileBet> = {}): ProfileBet => ({
  match: "A vs B",
  result: "Win",
  amount: 100,
  profit: 100,
  odds: 2,
  game: "CS2",
  currency: "UAH",
  date: "2026-10-03",
  createdAt: "2026-10-03T12:00:00Z",
  ...overrides,
});
const scope = { game: "all", period: "all", exchangeRate: 45.13, now } as const;
describe("Public profile aggregates", () => {
  it("converts native currency amounts at the explicitly supplied profile rate", () => {
    const data = buildPublicProfileStats(
      [
        bet({ profit: 200 }),
        bet({
          currency: "USD",
          originalProfit: 33,
          originalAmount: 100,
          exchangeRate: 40,
          profit: 1320,
          amount: 4000,
        }),
        bet({ profit: 178.65, date: "2026-08-17" }),
      ],
      scope,
    );
    expect(data.stats.displayProfit).toBe(1867.94);
    expect(data.stats.profitUAH).toBe(378.65);
    expect(data.stats.profitUSD).toBe(33);
    expect(
      data.monthlyProfit.reduce((sum, row) => sum + row.profit!, 0),
    ).toBeCloseTo(1867.94);
    expect(data.recentBets.find((b) => b.currency === "USD")?.profit).toBe(33);
  });
  it("filters ALL bets before aggregates and the recent-five limit", () => {
    const bets = Array.from({ length: 8 }, () => bet());
    bets.push(
      bet({
        game: "Dota 2",
        profit: -50,
        result: "Loss",
        createdAt: "2026-08-01",
        date: "2026-08-01",
      }),
    );
    const data = buildPublicProfileStats(bets, { ...scope, game: "dota2" });
    expect(data.stats.totalBets).toBe(1);
    expect(data.stats.displayProfit).toBe(-50);
    expect(data.stats.wins).toBe(0);
    expect(data.stats.losses).toBe(1);
    expect(data.recentBets).toHaveLength(1);
    expect(data.monthlyProfit).toEqual([
      { month: "2026-08", profit: -50, count: 1 },
    ]);
  });
  it("counts complete history while exposing only the last five public records", () => {
    const data = buildPublicProfileStats(
      Array.from({ length: 12 }, () => bet()),
      scope,
    );
    expect(data.stats.completedBets).toBe(12);
    expect(data.recentBets).toHaveLength(5);
    expect(data.stats.displayProfit).toBe(1200);
  });
  it("applies inclusive UTC day boundaries to every part of a period response", () => {
    const data = buildPublicProfileStats(
      [
        bet({ date: "2026-09-13" }),
        bet({ date: "2026-09-12" }),
        bet({ date: "2026-10-12" }),
        bet({ date: "2026-10-13" }),
      ],
      { ...scope, period: "30d" },
    );
    expect(data.stats.totalBets).toBe(2);
    expect(data.stats.displayProfit).toBe(200);
    expect(data.monthlyProfit).toHaveLength(2);
  });
  it("combines period and game scope", () => {
    const data = buildPublicProfileStats(
      [
        bet(),
        bet({ game: "Dota2", date: "2026-08-01" }),
        bet({ game: "Дота 2" }),
      ],
      { ...scope, period: "30d", game: "dota2" },
    );
    expect(data.stats.totalBets).toBe(1);
    expect(data.filters).toEqual({ game: "dota2", period: "30d" });
  });
  it("does not treat pending or unknown statuses as settled wins/losses", () => {
    const data = buildPublicProfileStats(
      [
        bet({ result: "Pending", profit: 9999 }),
        bet({ result: "unknown" }),
        bet(),
      ],
      scope,
    );
    expect(data.stats.pendingBets).toBe(2);
    expect(data.stats.completedBets).toBe(1);
    expect(data.stats.displayProfit).toBe(100);
    expect(data.recentBets[0].profit).toBeNull();
  });
  it("excludes refunds from win-rate and stake-risk denominator", () => {
    const data = buildPublicProfileStats(
      [
        bet(),
        bet({ result: "Loss", profit: -100 }),
        bet({ result: "Refund", profit: 100, amount: 900 }),
      ],
      scope,
    );
    expect(data.stats.winRate).toBe(50);
    expect(data.stats.completedBets).toBe(3);
    expect(data.stats.refunds).toBe(1);
    expect(data.stats.totalStaked).toBe(200);
    expect(data.stats.roi).toBe(0);
  });
  it("does not invent a rate or show partial aggregates as total profit", () => {
    const data = buildPublicProfileStats(
      [
        bet(),
        bet({ currency: "USD", originalProfit: 10, originalAmount: 100 }),
      ],
      { ...scope, exchangeRate: 0 },
    );
    expect(data.exchangeRate).toBeNull();
    expect(data.stats.displayProfit).toBeNull();
    expect(data.stats.roi).toBeNull();
    expect(data.stats.conversionComplete).toBe(false);
    expect(data.monthlyProfit[0].profit).toBeNull();
  });
  it("uses the most recent recorded rate if profile rate is absent", () => {
    const data = buildPublicProfileStats(
      [
        bet({ exchangeRate: 44, createdAt: "2026-09-01" }),
        bet({ exchangeRate: 45, createdAt: "2026-10-01" }),
      ],
      { ...scope, exchangeRate: null },
    );
    expect(data.exchangeRate).toBe(45);
    expect(data.exchangeRateSource).toBe("last-bet");
  });
  it("recovers missing original USD values using each bet historical rate", () => {
    const data = buildPublicProfileStats(
      [bet({ currency: "USD", profit: 400, amount: 800, exchangeRate: 40 })],
      scope,
    );
    expect(data.stats.profitUSD).toBe(10);
    expect(data.stats.displayProfit).toBe(451.3);
    expect(data.recentBets[0].profit).toBe(10);
  });
  it("shows no fabricated metrics in the empty state", () => {
    const data = buildPublicProfileStats([], scope);
    expect(data.stats.winRate).toBeNull();
    expect(data.stats.roi).toBeNull();
    expect(data.stats.avgOdds).toBeNull();
    expect(data.stats.completedBets).toBe(0);
    expect(data.monthlyProfit).toEqual([]);
  });
  it("does not leak private journal fields", () => {
    const row = {
      ...bet(),
      notes: "private note",
      userId: 123,
      selection: "private",
      strategy: "private",
    };
    const result = buildPublicProfileStats([row], scope);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.recentBets[0]).not.toHaveProperty("userId");
  });
  it("handles date objects and decimal comma values without NaN", () => {
    const data = buildPublicProfileStats(
      [
        bet({
          date: new Date("2026-10-03T00:00:00Z"),
          profit: "12,50",
          odds: "1,75",
        }),
      ],
      scope,
    );
    expect(data.monthlyProfit[0].month).toBe("2026-10");
    expect(data.stats.displayProfit).toBe(12.5);
    expect(data.stats.avgOdds).toBe(1.75);
    expect(toNumber("bad")).toBe(0);
  });
  it("normalizes existing app game labels", () => {
    expect(normalizeProfileGame("Dota 2")).toBe("dota2");
    expect(normalizeProfileGame("CS2")).toBe("cs2");
    expect(normalizeProfileGame(null)).toBe("cs2");
  });
});
