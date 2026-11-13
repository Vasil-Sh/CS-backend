// ═══════════════════════════════════════════
// Admin actions on a subscription (pure date helpers + the periodic Pro expiry).
// ═══════════════════════════════════════════

import { pool } from '../db/client';

/** YYYY-MM-DD in Europe/Kyiv for "today". */
export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Grant Pro for N days: Pro runs from today for `days` days (inclusive end = today + days − 1 … we keep
 * the design's wording «до <date>» = today + days). The paid subscription end moves by the same number of days
 * so the user does not lose paid time.
 */
export function grantProDates(today: string, days: number, endDate: string | null): { proUntil: string; newEndDate: string } {
  const proUntil = addDays(today, days);
  const base = endDate && endDate > today ? endDate : today;
  return { proUntil, newEndDate: addDays(base, days) };
}

/** Switch users whose granted Pro ran out back to their previous plan. Returns how many were switched. */
export async function expireGrantedPro(): Promise<number> {
  const r = await pool.query(
    `UPDATE users SET plan = COALESCE(pro_base_plan, plan), pro_until = NULL, pro_base_plan = NULL
      WHERE pro_until IS NOT NULL AND pro_until < (now() AT TIME ZONE 'Europe/Kyiv')::date`,
  );
  return r.rowCount ?? 0;
}

/** Run the Pro expiry every 30 minutes (and once shortly after start). */
export function startProExpiry(): void {
  if (!process.env.DATABASE_URL) return;
  const tick = () => { expireGrantedPro().catch((e) => console.warn('[pro-expiry]', (e as Error).message)); };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}
