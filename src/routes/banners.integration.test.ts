import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
vi.mock("../services/bannerService", () => ({
  bannerService: {
    listActive: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("../services/adminUsersService", () => ({ adminUsersService: {} }));
vi.mock("../db/client", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
import banners from "./banners";
import adminUsers from "./adminUsers";
import { bannerService } from "../services/bannerService";
import { pool } from "../db/client";
function app(role?: string) {
  const app = new Hono();
  if (role)
    app.use("*", async (c, next) => {
      c.set("user", { userId: 1, username: "test", role } as never);
      await next();
    });
  app.route("/banners", banners);
  app.route("/", adminUsers);
  return app;
}
beforeEach(() => vi.clearAllMocks());
describe("banner and audit API", () => {
  it("defaults to matches and selects each requested screen", async () => {
    expect((await app().request("/banners/active")).status).toBe(200);
    expect(bannerService.listActive).toHaveBeenLastCalledWith("matches");
    for (const screen of [
      "journal",
      "analytics",
      "strategies",
      "risky-teams",
    ]) {
      expect(
        (await app().request("/banners/active?screen=" + screen)).status,
      ).toBe(200);
      expect(bannerService.listActive).toHaveBeenLastCalledWith(screen);
    }
  });
  it("rejects unknown placement without calling service", async () => {
    expect((await app().request("/banners/active?screen=invalid")).status).toBe(
      400,
    );
    expect(bannerService.listActive).not.toHaveBeenCalled();
  });
  it("requires admin for campaigns and audit history", async () => {
    expect((await app().request("/admin/audit")).status).toBe(401);
    expect((await app("user").request("/admin/audit")).status).toBe(403);
    expect(
      (await app("user").request("/banners", { method: "POST", body: "{}" }))
        .status,
    ).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("paginates history for administrators", async () => {
    const response = await app("admin").request("/admin/audit?page=2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], hasMore: false });
    expect(vi.mocked(pool.query).mock.calls[0][1]).toEqual([30, "all", "all", "", null, null, null, false]);
  });
  it("passes audit filters to the database and rejects unknown filters", async () => {
    expect((await app('admin').request('/admin/audit?category=banners&status=failed')).status).toBe(200);
    expect(vi.mocked(pool.query).mock.calls[0][1]).toEqual([0,'banners','failed','',null,null,null,false]);
    expect((await app('admin').request('/admin/audit?category=unknown')).status).toBe(400);
  });
  it("validates audit dates and passes username and subscription filters",async()=>{
    const result=await app('admin').request('/admin/audit?q=test_user&from=2026-10-01&to=2026-10-29&userId=6&history=subscription');
    expect(result.status).toBe(200);
    expect(vi.mocked(pool.query).mock.calls[0][1]).toEqual([0,'all','all','test_user','2026-10-01','2026-10-29','6',true]);
    for(const query of ['from=2026-02-30','from=2026-11-01&to=2026-10-01','userId=bad']) expect((await app('admin').request('/admin/audit?'+query)).status).toBe(400);
  });
  it("rejects invalid dates before saving", async () => {
    const response = await app("admin").request("/banners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Demo", startsOn: "2026-02-30" }),
    });
    expect(response.status).toBe(400);
    expect(bannerService.create).not.toHaveBeenCalled();
  });
});
