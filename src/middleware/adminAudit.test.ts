import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../db/client", () => ({ pool: { query: vi.fn() } }));
import { pool } from "../db/client";
import { adminAudit } from "./adminAudit";
function app(role = "admin", status: 200 | 400 = 200) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { userId: 1, username: "operator", role } as never);
    await next();
  });
  app.use("*", adminAudit);
  app.put("/api/v1/auth/users/2", async (c) =>
    c.json(await c.req.json(), status),
  );
  app.post("/api/banners/", async (c) => c.json(await c.req.json(), status));
  return app;
}
beforeEach(() => {
  vi.mocked(pool.query).mockReset();
  vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "41", username: "test_user" }] } as never);
});
describe("admin audit", () => {
  it("keeps request body readable, records actor, excludes secrets", async () => {
    const response = await app().request("/api/v1/auth/users/2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endDate: "2026-11-28",
        password: "secret",
        token: "secret",
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).endDate).toBe("2026-11-28");
    const args = vi.mocked(pool.query).mock.calls[1][1] as unknown as unknown[];
    expect(args.slice(0, 4)).toEqual([1, "operator", "PUT", "/auth/users/2"]);
    expect(JSON.parse(args[4] as string)).toEqual({ endDate: "2026-11-28", targetUsername: "test_user" });
    const finalArgs=vi.mocked(pool.query).mock.calls[3][1] as unknown as unknown[];
    expect(finalArgs.slice(0,2)).toEqual(["success","41"]);
    expect(JSON.parse(finalArgs[2] as string)._targetUserId).toBe('2');
    expect(JSON.stringify(finalArgs)).not.toContain('secret');
  });
  it("records rejected operations as failed and supports trailing slash", async () => {
    await app("admin", 400).request("/api/banners/", {
      method: "POST",
      body: "{}",
    });
    expect((vi.mocked(pool.query).mock.calls[1][1] as unknown as unknown[]).slice(0,2)).toEqual(["failed", "41"]);
  });
  it("captures actual before and after subscription values",async()=>{
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValueOnce({rows:[{username:'test_user',endDate:'2026-10-28',priceMonth:'250.00'}]} as never)
      .mockResolvedValueOnce({rows:[{id:'41'}]} as never)
      .mockResolvedValueOnce({rows:[{username:'test_user',endDate:'2026-11-28',priceMonth:'250.00'}]} as never)
      .mockResolvedValueOnce({rows:[]} as never);
    const res=await app().request('/api/v1/auth/users/2',{method:'PUT',body:JSON.stringify({endDate:'2026-11-28'})});
    expect(res.status).toBe(200);
    const values=vi.mocked(pool.query).mock.calls[3][1] as unknown as unknown[];
    expect(JSON.parse(values[2] as string)._changes).toEqual({endDate:{before:'2026-10-28',after:'2026-11-28'}});
  });
  it("does not record normal users", async () => {
    await app("user").request("/api/v1/auth/users/2", {
      method: "PUT",
      body: "{}",
    });
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("does not perform mutation if initial audit write fails", async () => {
    vi.mocked(pool.query).mockRejectedValueOnce(new Error("DB unavailable"));
    const response = await app().request("/api/v1/auth/users/2", {
      method: "PUT",
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
