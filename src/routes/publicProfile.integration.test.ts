import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  where: vi.fn(),
  from: vi.fn(),
  limit: vi.fn(),
  responses: [] as unknown[],
}));
vi.mock("../db/client", () => ({
  db: { select: mocks.select },
  schema: {
    users: { id: "id", username: "username", telegram: "telegram" },
    bets: { userId: "userId" },
    bankroll: { userId: "userId" },
    goals: { userId: "userId", isCompleted: "isCompleted" },
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
}));
vi.mock("../services/createMatchesRouter", () => ({
  generateLogoFallback: (name: string, game: string) => `/logo/${game}/${name}`,
}));
import routes from "./publicProfile";
const app = new Hono().route("/api/public-profile", routes);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.responses.length = 0;
  mocks.select.mockImplementation(() => {
    const value = mocks.responses.shift();
    return {
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(value), {
            limit: () => Promise.resolve(value),
          }),
      }),
    };
  });
});
describe("Public profile read-only route", () => {
  it("validates filters before any database query", async () => {
    const res = await app.request("/api/public-profile/admin?game=invalid");
    expect(res.status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("validates period values", async () => {
    expect(
      (await app.request("/api/public-profile/admin?period=-2")).status,
    ).toBe(400);
  });
  it("returns a clear 404 for missing users", async () => {
    mocks.responses.push([]);
    expect((await app.request("/api/public-profile/absent")).status).toBe(404);
  });
  it("returns scoped results and preserves the existing public contract", async () => {
    mocks.responses.push(
      [{ id: 7, username: "admin", telegram: "" }],
      [
        {
          match: "CS match",
          team1: "A",
          team2: "B",
          result: "Win",
          game: "CS2",
          profit: "100",
          amount: "100",
          odds: "2",
          date: "2026-10-01",
        },
        {
          match: "Dota match",
          team1: "C",
          team2: "D",
          result: "Loss",
          game: "Dota 2",
          profit: "-50",
          amount: "50",
          odds: "2",
          date: "2026-10-01",
        },
      ],
      [{ initialBank: 1000, exchangeRate: 45 }],
      [],
    );
    const res = await app.request("/api/public-profile/admin?game=dota2");
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.schemaVersion).toBe(2);
    expect(data.stats.totalBets).toBe(1);
    expect(data.stats.displayProfit).toBe(-50);
    expect(data.recentBets[0].match).toBe("Dota match");
    expect(data.recentBets[0].logoTeam1).toBe("/logo/dota2/C");
    expect(data.stats).toHaveProperty("activeGoals");
    expect(JSON.stringify(data)).not.toContain("userId");
  });
});
