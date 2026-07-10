/**
 * Simple circuit breaker — protects against repeated failures to tips.gg.
 * After `failureThreshold` consecutive failures, opens for `resetTimeoutMs`.
 */

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT = 5 * 60 * 1000; // 5 min

const circuits = new Map<string, CircuitState>();

function getState(name: string): CircuitState {
  if (!circuits.has(name)) {
    circuits.set(name, { failures: 0, lastFailure: 0, open: false });
  }
  return circuits.get(name)!;
}

export function isOpen(name: string): boolean {
  const s = getState(name);
  if (!s.open) return false;
  if (Date.now() - s.lastFailure > RESET_TIMEOUT) {
    // Half-open: allow one request through
    s.open = false;
    s.failures = 0;
    return false;
  }
  return true;
}

export function recordSuccess(name: string): void {
  const s = getState(name);
  s.failures = 0;
  s.open = false;
}

export function recordFailure(name: string): void {
  const s = getState(name);
  s.failures++;
  s.lastFailure = Date.now();
  if (s.failures >= FAILURE_THRESHOLD) {
    s.open = true;
    console.warn(`[circuit-breaker] ${name} OPEN (${s.failures} failures)`);
  }
}

export function getStatus(name: string): { open: boolean; failures: number } {
  const s = getState(name);
  return { open: s.open, failures: s.failures };
}
