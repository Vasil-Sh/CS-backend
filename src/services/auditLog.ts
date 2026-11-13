// ═══════════════════════════════════════════
// Audit log helper — record admin actions with a safe before/after diff.
// Only whitelisted (non-secret) fields are stored; never passwords/tokens.
// ═══════════════════════════════════════════

import { pool } from '../db/client';

export interface AuditActor {
  userId: number;
  username: string;
}

/** Fields we allow into the before/after diff (no secrets, no uploads). */
const ALLOWED_FIELDS = new Set([
  'code', 'discountPercent', 'plan', 'startsOn', 'endsOn', 'usageLimit', 'active',
  'name', 'licenseNumber', 'moderationText', 'showOddsInList', 'showMatchDetails',
  'moderationStatus', 'rejectReason', 'status', 'subject',
  'basicPrice', 'proPrice', 'trialEnabled', 'trialDays', 'trialPlan', 'aiDailyLimit', 'warningThreshold', 'disclaimerText',
  'aiUsdUah', 'churnInactiveDays', 'churnLossStreak', 'basicFeatures', 'proFeatures', 'receiptFields', 'defaultMonthlyPrice', 'subscriptionDays',
  'endDate', 'priceMonth', 'periodDays', 'amount', 'refundedAmount', 'extendSubscription', 'paymentMethod', 'promoCode',
]);

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 200);
  if (Array.isArray(value)) return value.map(sanitize).slice(0, 50);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ALLOWED_FIELDS.has(k)) out[k] = sanitize(v);
    }
    return out;
  }
  return null;
}

export interface AuditOptions {
  /** Diff before/after objects (only whitelisted keys survive). */
  changes?: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };
  /** Extra allowed scalar fields to record verbatim. */
  fields?: Record<string, unknown>;
}

/** Insert a single audit-log entry. Returns the new row id. */
export async function recordAudit(
  actor: AuditActor,
  action: string,
  target: string,
  options: AuditOptions = {},
): Promise<string> {
  const details: Record<string, unknown> = { ...(options.fields || {}) };
  if (options.changes) {
    const before = sanitize(options.changes.before ?? null);
    const after = sanitize(options.changes.after ?? null);
    details._changes = { before, after };
  }
  const result = await pool.query(
    `INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status)
     VALUES($1,$2,$3,$4,$5,'success') RETURNING id::text`,
    [actor.userId, actor.username, action, target, JSON.stringify(details)],
  );
  return result.rows[0].id;
}

/** Quick helper: wrap an admin action with before/after diffing. */
export async function recordAction(
  actor: AuditActor,
  action: string,
  target: string,
  extra: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; fields?: Record<string, unknown> } = {},
): Promise<void> {
  await recordAudit(actor, action, target, {
    changes: extra.before !== undefined || extra.after !== undefined ? { before: extra.before ?? null, after: extra.after ?? null } : undefined,
    fields: extra.fields,
  });
}
