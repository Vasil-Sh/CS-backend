/**
 * Server errors kept in Postgres for the admin — Railway's log scrolls away.
 * Errors of one kind (source + message with numbers/ids blanked) become one row with a counter;
 * writes are batched every 30 s, so a burst of the same error costs one query.
 */
import { pool } from '../db/client';

export type ErrorSource = 'api' | 'process' | 'console';
interface Pending { source: ErrorSource; message: string; detail: string; path: string; status: number | null; count: number; at: Date }

const pending = new Map<string, Pending>();
const FLUSH_MS = 30_000;
const KEEP_DAYS = 30;
let timer: NodeJS.Timeout | null = null;
let lastCleanup = 0;
const warn = console.warn.bind(console); // never the wrapped console.error — no loops

/** Same kind of error → same key: numbers, ids, hex and quoted values blanked. */
export function errorKey(source: string, message: string): string {
  const m = String(message || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"|'[^']*'/g, '<v>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${source}:${m}`.slice(0, 300);
}

export function recordServerError(source: ErrorSource, message: string, detail = '', path = '', status: number | null = null): void {
  const msg = String(message || '').trim().slice(0, 1000);
  if (!msg) return;
  const key = errorKey(source, msg);
  const p = pending.get(key);
  if (p) { p.count++; p.detail = detail.slice(0, 4000) || p.detail; p.path = path || p.path; p.status = status ?? p.status; p.at = new Date(); }
  else {
    if (pending.size > 200) return; // a storm: the first 200 kinds are enough
    pending.set(key, { source, message: msg, detail: detail.slice(0, 4000), path: path.slice(0, 300), status, count: 1, at: new Date() });
  }
  if (!timer) { timer = setTimeout(() => { timer = null; void flushServerErrors(); }, FLUSH_MS); timer.unref?.(); }
}

export async function flushServerErrors(): Promise<void> {
  const batch = [...pending.entries()];
  pending.clear();
  for (const [key, p] of batch) {
    await pool.query(
      `INSERT INTO server_errors(key, source, message, detail, path, count, first_at, last_at, status) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)
       ON CONFLICT(key) DO UPDATE SET count = server_errors.count + EXCLUDED.count, message = EXCLUDED.message,
         detail = CASE WHEN EXCLUDED.detail <> '' THEN EXCLUDED.detail ELSE server_errors.detail END,
         path = CASE WHEN EXCLUDED.path <> '' THEN EXCLUDED.path ELSE server_errors.path END, last_at = EXCLUDED.last_at,
         status = COALESCE(EXCLUDED.status, server_errors.status)`,
      [key, p.source, p.message, p.detail, p.path, p.count, p.at, p.status],
    ).catch((e) => warn('[serverErrors] save failed:', (e as Error).message));
  }
  if (Date.now() - lastCleanup > 3_600_000) {
    lastCleanup = Date.now();
    await pool.query(`DELETE FROM server_errors WHERE last_at < now() - INTERVAL '${KEEP_DAYS} days'`).catch(() => {});
  }
}

const text = (x: unknown): string => (x instanceof Error ? x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })());

/** console.error → also kept; unhandled rejections and exceptions → kept (the process keeps its usual behaviour). */
export function captureServerErrors(): void {
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    try {
      const err = args.find((a) => a instanceof Error) as Error | undefined;
      const msg = args.filter((a) => !(a instanceof Error)).map(text).join(' ').trim() || err?.message || '';
      recordServerError('console', err && msg && !msg.includes(err.message) ? `${msg} ${err.message}` : msg, err?.stack || '');
    } catch { /* never break logging */ }
  };
  process.on('unhandledRejection', (r) => recordServerError('process', `Unhandled rejection: ${text(r)}`, r instanceof Error ? r.stack || '' : ''));
  process.on('uncaughtExceptionMonitor', (e) => { recordServerError('process', `Uncaught exception: ${e.message}`, e.stack || ''); void flushServerErrors(); });
}

export type Severity = 'critical' | 'warning' | 'info';

/** How bad an error is, with one plain line on what it means — so the admin list reads without the stack. */
export function severityOf(source: string, message: string, status: number | null = null): { severity: Severity; hint: string } {
  const m = String(message || '');
  if (/connection terminated|ECONNREFUSED|too many clients|terminating connection|database system is|Connection terminated unexpectedly|pool.*(ended|timeout)|could not connect to server/i.test(m))
    return { severity: 'critical', hint: 'База даних обірвала з’єднання — запити в цей момент не проходили' };
  if (/heap out of memory|ENOMEM|JavaScript heap/i.test(m))
    return { severity: 'critical', hint: 'Серверу забракло пам’яті — він міг перезапуститися' };
  if (source === 'process' && /^Uncaught exception/i.test(m))
    return { severity: 'critical', hint: 'Сервер упав з необробленою помилкою — Railway перезапустив його' };
  if (source === 'api')
    return { severity: 'critical', hint: `Користувач отримав помилку${status ? ` ${status}` : ''} замість відповіді — запит не виконався` };
  if (/liquipedia|oddspapi|opendota|parser|force refresh|feed|scores|odds/i.test(m))
    return { severity: 'warning', hint: 'Парсер не оновив дані — спробує знову сам, матчі поки зі старими даними' };
  if (/timeout|timed out|ETIMEDOUT|fetch failed|ECONNRESET|ENOTFOUND|socket hang up|\b429\b|\b5\d\d\b/i.test(m))
    return { severity: 'warning', hint: 'Зовнішній сервіс не відповів — зазвичай минає саме' };
  if (source === 'process')
    return { severity: 'warning', hint: 'Фонова задача завершилась помилкою — сервер працює далі' };
  return { severity: 'info', hint: 'Запис у журналі — на роботу користувачів не вплинуло' };
}

export async function listServerErrors(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, source, message, detail, path, status, count, first_at, last_at FROM server_errors ORDER BY last_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r: any) => ({ id: Number(r.id), source: r.source, message: r.message, detail: r.detail, path: r.path, status: r.status == null ? null : Number(r.status), ...severityOf(r.source, r.message, r.status == null ? null : Number(r.status)), count: Number(r.count), firstAt: new Date(r.first_at).toISOString(), lastAt: new Date(r.last_at).toISOString() }));
}

export async function resolveServerError(id: number | 'all'): Promise<number> {
  const r = id === 'all' ? await pool.query('DELETE FROM server_errors') : await pool.query('DELETE FROM server_errors WHERE id = $1', [id]);
  return r.rowCount ?? 0;
}
