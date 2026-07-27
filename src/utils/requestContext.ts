/**
 * Request-scoped context via AsyncLocalStorage.
 * Carries a transactionId across all async operations within a single request.
 *
 * Usage in routes:
 *   import { getRequestContext } from '../utils/requestContext';
 *   const ctx = getRequestContext();
 *   console.log(`[${ctx.transactionId}] Processing...`);
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  transactionId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run callback with a fresh request context. Called by middleware. */
export function runWithRequestContext<T>(fn: () => T): T {
  const ctx: RequestContext = { transactionId: randomUUID() };
  return storage.run(ctx, fn);
}

/** Get the current request context. Returns a stub if called outside a request. */
export function getRequestContext(): RequestContext {
  return storage.getStore() ?? { transactionId: 'no-request' };
}
