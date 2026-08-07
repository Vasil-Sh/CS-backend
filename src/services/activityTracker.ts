/**
 * Tracks last user activity (API requests for matches).
 * Used by live score workers to throttle polling when idle.
 *
 * When no user has requested matches in IDLE_THRESHOLD_MS, workers
 * switch to IDLE_POLL_MS (much slower) to reduce load on tips.gg.
 */

// If no match API requests in 5 minutes, consider idle
const IDLE_THRESHOLD_MS = 5 * 60_000;
// Idle polling: every 2 minutes instead of 20s
export const IDLE_POLL_MS = 120_000;

let _lastActivity = 0;

/** Call this whenever a user requests match data. */
export function touchActivity(): void {
  _lastActivity = Date.now();
}

/** Returns true if no user activity recently. */
export function isIdle(): boolean {
  return Date.now() - _lastActivity > IDLE_THRESHOLD_MS;
}

/** Returns ms since last activity. */
export function idleAge(): number {
  return Date.now() - _lastActivity;
}
