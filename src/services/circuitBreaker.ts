/**
 * Simple circuit breaker — protects against repeated failures to tips.gg.
 * After `failureThreshold` consecutive failures, opens for `resetTimeoutMs`.
 */

import { recordParserFailure } from './insights';
import { adminMatchesService } from './adminMatchesService';
import { pool } from '../db/client';

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

// Collapse identical parser events within 60s so the log doesn't spam on
// every incremental refresh (120s cadence) or repeated scraper failures.
const lastEvent = new Map<string, { kind: string; at: number }>();
function logEvent(name: string, kind: 'success' | 'failure' | 'rerun', message = ''): void {
  const prev = lastEvent.get(name);
  const now = Date.now();
  if (prev && prev.kind === kind && now - prev.at < 60_000) return;
  lastEvent.set(name, { kind, at: now });
  adminMatchesService.logParserEvent(name, kind, message);
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

// ── Parsers stopped by an admin (persisted in parser_pauses, loaded on start) ──
const paused = new Map<string, { by: string; at: number }>();

export async function loadParserPauses(): Promise<void> {
  try {
    const { rows } = await pool.query('SELECT name, paused_by, paused_at FROM parser_pauses');
    paused.clear();
    rows.forEach((r: any) => paused.set(r.name, { by: r.paused_by || '', at: new Date(r.paused_at).getTime() }));
    if (rows.length) console.log(`[circuit-breaker] stopped by admin: ${rows.map((r: any) => r.name).join(', ')}`);
  } catch (e) {
    console.warn('[circuit-breaker] could not load parser pauses:', (e as Error).message);
  }
}

export function pauseInfo(name: string): { by: string; at: number } | null {
  return paused.get(name) || null;
}

export async function pauseParser(name: string, by: string): Promise<void> {
  await pool.query(
    `INSERT INTO parser_pauses(name, paused_by) VALUES($1,$2)
     ON CONFLICT (name) DO UPDATE SET paused_by = EXCLUDED.paused_by, paused_at = now()`,
    [name, by],
  );
  paused.set(name, { by, at: Date.now() });
  adminMatchesService.logParserEvent(name, 'rerun', `Зупинено вручну · @${by}`);
}

export async function resumeParser(name: string, by: string): Promise<void> {
  await pool.query('DELETE FROM parser_pauses WHERE name = $1', [name]);
  const was = paused.delete(name);
  if (was) adminMatchesService.logParserEvent(name, 'rerun', `Запущено вручну · @${by}`);
}

export function isOpen(name: string): boolean {
  if (paused.has(name)) return true; // stopped by hand: no fetch, the feed keeps its cache
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
  logEvent(name, 'success', 'OK');
}

export function recordFailure(name: string): void {
  if (paused.has(name)) return; // a stopped parser is not failing
  const s = getState(name);
  s.failures++;
  s.lastFailure = Date.now();
  // Persist to parser_failures (best-effort, throttled inside).
  recordParserFailure(name, `Circuit breaker failure #${s.failures}`);
  logEvent(name, 'failure', `Circuit breaker failure #${s.failures}`);
  if (s.failures >= FAILURE_THRESHOLD) {
    s.open = true;
    console.warn(`[circuit-breaker] ${name} OPEN (${s.failures} failures)`);
  }
}

export function getStatus(name: string): { open: boolean; failures: number } {
  const s = getState(name);
  return { open: s.open, failures: s.failures };
}

/** List all registered circuits (for the admin parser status screen). */
export function listCircuits(): { name: string; open: boolean; failures: number; lastFailure: number }[] {
  return [...circuits.entries()].map(([name, s]) => ({
    name,
    open: s.open,
    failures: s.failures,
    lastFailure: s.lastFailure,
  }));
}

/** Force-close a circuit (admin "run again" resets the breaker). */
export function resetCircuit(name: string): void {
  const s = getState(name);
  s.open = false;
  s.failures = 0;
  logEvent(name, 'rerun', 'Admin reset the breaker');
}
