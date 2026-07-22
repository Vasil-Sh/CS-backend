import { describe, it, expect } from "vitest";

// ── Bankroll pure logic — extracted from bankrollBackendService ──

/** Calculate profit from bet array (pure function) */
function calculateTotalProfit(bets: Array<{ result: string; profit?: number; odds?: number; amount?: number }>): number {
  return bets
    .filter((b) => b.result !== "Pending")
    .reduce((sum, b) => sum + (b.profit || 0), 0);
}

describe("calculateTotalProfit (bankroll core)", () => {
  it("empty bets → 0", () => {
    expect(calculateTotalProfit([])).toBe(0);
  });

  it("single win", () => {
    expect(calculateTotalProfit([{ result: "Win", profit: 500, odds: 2, amount: 500 }])).toBe(500);
  });

  it("single loss", () => {
    expect(calculateTotalProfit([{ result: "Loss", profit: -200, odds: 1.5, amount: 200 }])).toBe(-200);
  });

  it("mixed wins and losses", () => {
    const bets = [
      { result: "Win", profit: 500, odds: 2, amount: 500 },
      { result: "Loss", profit: -300, odds: 2, amount: 300 },
      { result: "Win", profit: 200, odds: 3, amount: 100 },
    ];
    expect(calculateTotalProfit(bets)).toBe(400);
  });

  it("ignores Pending", () => {
    expect(calculateTotalProfit([{ result: "Pending", profit: 0, odds: 2, amount: 100 }])).toBe(0);
  });

  it("handles missing profit field", () => {
    expect(calculateTotalProfit([{ result: "Win" }])).toBe(0);
  });
});

/** Calculate ROI */
function calculateRoi(totalProfit: number, totalStake: number): number {
  return totalStake > 0 ? Math.round((totalProfit / totalStake) * 10000) / 100 : 0;
}

describe("calculateRoi", () => {
  it("100% ROI", () => expect(calculateRoi(100, 100)).toBe(100));
  it("50% ROI", () => expect(calculateRoi(50, 100)).toBe(50));
  it("-25% ROI", () => expect(calculateRoi(-25, 100)).toBe(-25));
  it("zero stake → 0", () => expect(calculateRoi(100, 0)).toBe(0));
  it("zero profit", () => expect(calculateRoi(0, 500)).toBe(0));
  it("fractional ROI (2 decimal)", () => expect(calculateRoi(33, 100)).toBe(33));
});

/** Validate bet amount */
function validateBetAmount(amount: number, currentBank: number, maxPercent: number): { valid: boolean; reason?: string } {
  if (amount <= 0) return { valid: false, reason: "Amount must be positive" };
  if (currentBank <= 0) return { valid: false, reason: "Bankroll not initialized" };
  const maxAllowed = (currentBank * maxPercent) / 100;
  if (amount > maxAllowed) return { valid: false, reason: `Exceeds ${maxPercent}% of bankroll (max ${maxAllowed})` };
  if (amount > currentBank) return { valid: false, reason: "Insufficient bankroll" };
  return { valid: true };
}

describe("validateBetAmount", () => {
  it("allows small bet", () => {
    expect(validateBetAmount(500, 10000, 10).valid).toBe(true);
  });

  it("rejects negative amount", () => {
    expect(validateBetAmount(-100, 10000, 10).valid).toBe(false);
  });

  it("rejects zero amount", () => {
    expect(validateBetAmount(0, 10000, 10).valid).toBe(false);
  });

  it("rejects when exceeding max percent", () => {
    expect(validateBetAmount(600, 1000, 50).valid).toBe(false);
  });

  it("allows exactly at max percent", () => {
    expect(validateBetAmount(500, 1000, 50).valid).toBe(true);
  });

  it("rejects when bankroll not initialized (0)", () => {
    expect(validateBetAmount(100, 0, 10).valid).toBe(false);
  });

  it("rejects when amount > bankroll", () => {
    expect(validateBetAmount(1100, 1000, 100).valid).toBe(false);
  });
});

/** Monthly profit aggregation */
interface BetRecord { date: string; profit: number; result: string }
function aggregateByMonth(bets: BetRecord[]): Array<{ month: string; profit: number }> {
  const map = new Map<string, number>();
  for (const b of bets) {
    if (b.result === "Pending") continue;
    const month = (b.date || "").substring(0, 7);
    if (!month) continue;
    map.set(month, (map.get(month) || 0) + (b.profit || 0));
  }
  return Array.from(map.entries())
    .map(([month, profit]) => ({ month, profit: Math.round(profit * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

describe("aggregateByMonth", () => {
  it("empty → empty", () => {
    expect(aggregateByMonth([])).toEqual([]);
  });

  it("single month", () => {
    const bets = [
      { date: "2026-07-21", profit: 500, result: "Win" },
      { date: "2026-07-15", profit: -200, result: "Loss" },
    ];
    expect(aggregateByMonth(bets)).toEqual([{ month: "2026-07", profit: 300 }]);
  });

  it("multiple months", () => {
    const bets = [
      { date: "2026-06-10", profit: 1000, result: "Win" },
      { date: "2026-07-05", profit: 500, result: "Win" },
      { date: "2026-06-20", profit: -300, result: "Loss" },
    ];
    const result = aggregateByMonth(bets);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ month: "2026-06", profit: 700 });
    expect(result[1]).toEqual({ month: "2026-07", profit: 500 });
  });

  it("sorted by month", () => {
    const bets = [
      { date: "2026-12-01", profit: 100, result: "Win" },
      { date: "2026-01-01", profit: 200, result: "Win" },
    ];
    const result = aggregateByMonth(bets);
    expect(result[0].month).toBe("2026-01");
    expect(result[1].month).toBe("2026-12");
  });

  it("ignores Pending", () => {
    const bets = [{ date: "2026-07-21", profit: 100, result: "Pending" }];
    expect(aggregateByMonth(bets)).toEqual([]);
  });
});
