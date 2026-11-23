/**
 * Daily housekeeping: logs that are written every few minutes are kept for 30 days
 * (the parser log in the admin shows the last events; older rows only slow it down).
 */
import { pool } from '../db/client';

export const KEEP_DAYS = 30;
const DAY = 24 * 3_600_000;
export const CLEANUP_SQL = [
  `DELETE FROM parser_events WHERE created_at < now() - INTERVAL '${KEEP_DAYS} days'`,
  `DELETE FROM parser_failures WHERE created_at < now() - INTERVAL '${KEEP_DAYS} days'`,
];

export async function cleanupLogs(): Promise<number> {
  let removed = 0;
  for (const q of CLEANUP_SQL) {
    try { removed += (await pool.query(q)).rowCount ?? 0; }
    catch (e) { console.warn('[maintenance] cleanup failed:', (e as Error).message); }
  }
  if (removed) console.log(`[maintenance] removed ${removed} log rows older than ${KEEP_DAYS} days`);
  return removed;
}

/** First run a few minutes after start (not during the busy start), then once a day. */
export function startMaintenance(): void {
  const first = setTimeout(() => { void cleanupLogs(); }, 5 * 60_000);
  first.unref?.();
  const daily = setInterval(() => { void cleanupLogs(); }, DAY);
  daily.unref?.();
}
