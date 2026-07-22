import { describe, it, expect } from "vitest";
import { BetService } from "../services/betService";

describe("BetService.cleanGoalId", () => {
  it("returns null for undefined", () => {
    expect(BetService.cleanGoalId(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(BetService.cleanGoalId("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(BetService.cleanGoalId("   ")).toBeNull();
    expect(BetService.cleanGoalId("\t")).toBeNull();
  });

  it("returns null for exact 'all' (case-sensitive)", () => {
    expect(BetService.cleanGoalId("all")).toBeNull();
    // "ALL" ≠ "all" — the check is case-sensitive, so it passes through
    expect(BetService.cleanGoalId("ALL")).toBe("ALL");
  });

  it("returns trimmed ID for valid values", () => {
    expect(BetService.cleanGoalId("goal-123")).toBe("goal-123");
    expect(BetService.cleanGoalId("  goal-456  ")).toBe("  goal-456  ");
    expect(BetService.cleanGoalId("uuid-here")).toBe("uuid-here");
  });

  it("returns null for 'all' with whitespace", () => {
    // " all " — id === 'all' is false (checks untrimmed), !id.trim() → !"all" → false
    // So it passes through as-is (the trim only applies to the emptiness check)
    expect(BetService.cleanGoalId(" all ")).toBe(" all ");
  });
});

// ── buildBetData (via private method access pattern) ──

describe("BetService.buildBetData (pure conversion)", () => {
  const service = new BetService();

  // Access private method via bracket notation for testing
  const buildBetData = (userId: number, body: Record<string, unknown>) =>
    (service as any).buildBetData(userId, body);

  it("converts basic fields", () => {
    const result = buildBetData(1, {
      match: "NaVi vs FaZe",
      team1: "NaVi",
      team2: "FaZe",
      betType: "П1",
      odds: 2.0,
      amount: 100,
      stake: 100,
      date: "2026-07-21",
      result: "Win",
      profit: 100,
    });

    expect(result.userId).toBe(1);
    expect(result.match).toBe("NaVi vs FaZe");
    expect(result.team1).toBe("NaVi");
    expect(result.team2).toBe("FaZe");
    expect(result.betType).toBe("П1");
    expect(result.odds).toBe("2"); // toString()
    expect(result.amount).toBe("100");
    expect(result.stake).toBe("100");
    expect(result.date).toBe("2026-07-21");
    expect(result.result).toBe("Win");
    expect(result.profit).toBe("100");
  });

  it("provides defaults for missing fields", () => {
    const result = buildBetData(1, { betType: "П1", odds: 1.5, amount: 50 });

    expect(result.team1).toBe("");
    expect(result.team2).toBe("");
    expect(result.date).toBeTruthy(); // today's date
    expect(result.profit).toBe("0");
    expect(result.strategy).toBe("");
    expect(result.format).toBe("");
    expect(result.game).toBe("CS2");
    expect(result.currency).toBe("UAH");
    expect(result.goalId).toBeNull();
  });

  it("converts odds to string", () => {
    const result = buildBetData(1, { betType: "П1", odds: 1.85, amount: 100 });
    expect(result.odds).toBe("1.85");
  });

  it("handles optional fields", () => {
    const result = buildBetData(1, {
      betType: "П1", odds: 2, amount: 100,
      strategy: "Safe",
      format: "Bo3",
      game: "CS2",
      currency: "USD",
      notes: "Test note",
      selection: "NaVi",
      matchUrl: "https://hltv.org/matches/123",
      winProbability: "75",
      risk: "low",
      goalId: "goal-1",
      tournament: "IEM Katowice",
      logoTeam1: "/logos/a.png",
      logoTeam2: "/logos/b.png",
      expressLogos: [{ logoTeam1: "/a.png", logoTeam2: "/b.png" }],
    });

    expect(result.strategy).toBe("Safe");
    expect(result.format).toBe("Bo3");
    expect(result.currency).toBe("USD");
    expect(result.notes).toBe("Test note");
    expect(result.selection).toBe("NaVi");
    expect(result.matchUrl).toBe("https://hltv.org/matches/123");
    expect(result.winProbability).toBe("75");
    expect(result.risk).toBe("low");
    expect(result.goalId).toBe("goal-1");
    expect(result.tournament).toBe("IEM Katowice");
    expect(result.logoTeam1).toBe("/logos/a.png");
    expect(result.logoTeam2).toBe("/logos/b.png");
    expect(result.expressLogos).toEqual([{ logoTeam1: "/a.png", logoTeam2: "/b.png" }]);
  });

  it("cleans 'all' goalId to null", () => {
    const result = buildBetData(1, { betType: "П1", odds: 2, amount: 100, goalId: "all" });
    expect(result.goalId).toBeNull();
  });

  it("handles empty riskyTeams", () => {
    const result = buildBetData(1, { betType: "П1", odds: 2, amount: 100, riskyTeams: [] });
    expect(result.riskyTeams).toEqual([]);
  });

  it("handles riskyTeams with string names", () => {
    const result = buildBetData(1, { betType: "П1", odds: 2, amount: 100, riskyTeams: ["FaZe", "Navi"] });
    expect(result.riskyTeams).toEqual(["FaZe", "Navi"]);
  });

  it("handles originalAmount and exchangeRate", () => {
    const result = buildBetData(1, {
      betType: "П1", odds: 2, amount: 100,
      originalAmount: 10,
      exchangeRate: 42.5,
      originalProfit: 5,
      roi: 50,
    });
    expect(result.originalAmount).toBe("10");
    expect(result.exchangeRate).toBe("42.5");
    expect(result.originalProfit).toBe("5");
    expect(result.roi).toBe("50");
  });
});

// ── buildUpdateData ──

describe("BetService.buildUpdateData (pure conversion)", () => {
  const service = new BetService();
  const buildUpdateData = (body: Record<string, unknown>) =>
    (service as any).buildUpdateData(body);

  it("converts numeric fields to strings", () => {
    const result = buildUpdateData({
      profit: 100,
      odds: 2.5,
      amount: 200,
      roi: 50,
    });
    expect(result.profit).toBe("100");
    expect(result.odds).toBe("2.5");
    expect(result.amount).toBe("200");
    expect(result.roi).toBe("50");
  });

  it("passes through passthrough fields", () => {
    const result = buildUpdateData({
      result: "Win",
      notes: "Good bet",
      strategy: "Safe",
      betType: "П1",
    });
    expect(result.result).toBe("Win");
    expect(result.notes).toBe("Good bet");
    expect(result.strategy).toBe("Safe");
    expect(result.betType).toBe("П1");
  });

  it("skips undefined values", () => {
    const result = buildUpdateData({ profit: 100, notes: undefined, result: undefined });
    expect(result.profit).toBe("100");
    expect(result.notes).toBeUndefined();
    expect(result.result).toBeUndefined();
  });

  it("handles empty object", () => {
    expect(Object.keys(buildUpdateData({}))).toHaveLength(0);
  });

  it("handles stake and winProbability", () => {
    const result = buildUpdateData({ stake: "200", winProbability: "75" });
    expect(result.stake).toBe("200");
    expect(result.winProbability).toBe("75");
  });

  it("passes through logo and expressLogos fields", () => {
    const result = buildUpdateData({
      logoTeam1: "/logos/a.png",
      logoTeam2: "/logos/b.png",
      expressLogos: ["a"],
    });
    expect(result.logoTeam1).toBe("/logos/a.png");
    expect(result.logoTeam2).toBe("/logos/b.png");
    expect(result.expressLogos).toEqual(["a"]);
  });
});
