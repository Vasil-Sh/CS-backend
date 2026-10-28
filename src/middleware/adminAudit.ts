import type { Context, Next } from "hono";
import { pool } from "../db/client";

export async function adminAudit(c: Context, next: Next) {
  const actor = c.get("user");
  const path = c.req.path.replace(/^\/api(?:\/v1)?/, "").replace(/\/$/, "");
  const method = c.req.method;
  const tracked =
    /^\/auth\/(register|users\/\d+(?:\/reset-password)?)$/.test(path) ||
    /^\/banners(?:\/\d+|\/slots\/[12])?$/.test(path);
  if (
    actor?.role !== "admin" ||
    !tracked ||
    !["POST", "PUT", "DELETE"].includes(method)
  )
    return next();
  let body: Record<string, unknown> = {};
  if (method !== "DELETE") {
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed;
    } catch {}
  }
  const details: Record<string, unknown> = {};
  for (const key of [
    "username",
    "endDate",
    "startDate",
    "priceMonth",
    "role",
    "title",
    "active",
    "screen",
    "slot",
    "startsOn",
    "endsOn",
    "placeholderEnabled",
  ]) {
    const value = body[key];
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    )
      details[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  const targetUserId = path.match(/^\/auth\/users\/(\d+)(?:\/reset-password)?$/)?.[1];
  if (targetUserId) {
    const user = await pool.query('SELECT username FROM users WHERE id::text = $1', [targetUserId]);
    if (user.rows[0]?.username) details.targetUsername = user.rows[0].username;
  }
  // Record the attempt before mutation; never store passwords, tokens or uploaded data.
  const result = await pool.query(
    "INSERT INTO admin_audit_log (actor_id,actor_name,action,target,details) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [actor.userId, actor.username, method, path, JSON.stringify(details)],
  );
  try {
    await next();
  } finally {
    try {
      await pool.query("UPDATE admin_audit_log SET status=$1 WHERE id=$2", [
        c.error || c.res.status >= 400 ? "failed" : "success",
        result.rows[0].id,
      ]);
    } catch (error) {
      console.error("[Audit] Could not finalize event", result.rows[0].id);
    }
  }
}
