import type { Context, Next } from 'hono';

/**
 * Rejects requests with body larger than the specified limit.
 * Reads Content-Length header before parsing, preventing memory exhaustion.
 */
export function bodyLimit(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    if (contentLength > maxBytes) {
      return c.json(
        { error: 'Payload too large', maxBytes, received: contentLength },
        413
      );
    }
    await next();
  };
}
