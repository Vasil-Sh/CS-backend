import type { Context, Next } from "hono";
import { auditChanges, type AuditSnapshot } from "../services/auditChanges";
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
  let targetId = path.match(/^\/auth\/users\/(\d+)(?:\/reset-password)?$/)?.[1] || path.match(/^\/banners\/(\d+)$/)?.[1] || path.match(/^\/banners\/slots\/([12])$/)?.[1];
  const isUser = path.startsWith('/auth/');
  const isSlot = path.startsWith('/banners/slots/');
  async function snapshot(id?: string): Promise<AuditSnapshot | null> {
    if(!id) return null;
    const query = isUser
     ? 'SELECT username, telegram, role, price_month::text AS "priceMonth", start_date::text AS "startDate", end_date::text AS "endDate" FROM users WHERE id::text=$1'
     : isSlot ? 'SELECT placeholder_enabled AS "placeholderEnabled" FROM banner_slots WHERE slot::text=$1'
     : 'SELECT title, description, href, active, screen, slot, starts_on::text AS "startsOn", ends_on::text AS "endsOn" FROM banners WHERE id::text=$1';
    const result=await pool.query(query,[id]);
    return result.rows[0] || null;
  }
  const before = await snapshot(targetId);
  if (isUser && before?.username) details.targetUsername = before.username;
  // Record the attempt before mutation; never store passwords, tokens or uploaded data.
  const result = await pool.query(
    "INSERT INTO admin_audit_log (actor_id,actor_name,action,target,details) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [actor.userId, actor.username, method, path, JSON.stringify(details)],
  );
  try {
    await next();
  } finally {
    try {
      const status = c.error || c.res.status >= 400 ? "failed" : "success";
      if(status === "success") {
        if(method === "POST" && !targetId) {
          const response = await c.res.clone().json().catch(()=>({})) as {userId?: number; id?: number | string};
          const createdId = response.userId ?? response.id;
          if(createdId != null) targetId=String(createdId);
        }
        const after = method === "DELETE" ? null : await snapshot(targetId);
        if(!path.endsWith('/reset-password')) details._changes=auditChanges(before,after);
        if(isUser && targetId) details._targetUserId=targetId;
        if(isUser && !details.targetUsername && after?.username) details.targetUsername=after.username;
      }
      await pool.query("UPDATE admin_audit_log SET status=$1, details=$3 WHERE id=$2", [status,result.rows[0].id,JSON.stringify(details)]);
    } catch (error) {
      console.error("[Audit] Could not finalize event", result.rows[0].id);
    }
  }
}
