import type { Context, Next } from 'hono';

/**
 * Helmet-like security headers middleware.
 * Uses relaxed CSP for Swagger docs route, strict CSP for API.
 */
export async function securityHeaders(c: Context, next: Next) {
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-XSS-Protection', '0');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Relaxed CSP for Swagger docs, strict for everything else
  if (c.req.path === '/api/docs') {
    // Swagger UI needs external CDN scripts, inline styles, and blob: for rendering
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "img-src 'self' data: https:; " +
      "connect-src 'self' https:; " +
      "frame-ancestors 'self'"
    );
    // Don't block framing for docs (needed by Swagger UI)
    c.res.headers.set('X-Frame-Options', 'SAMEORIGIN');
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  } else {
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; connect-src 'self' http://localhost:* https://api.deepseek.com https://api.telegram.org; " +
      "frame-ancestors 'none'"
    );
    c.res.headers.set('X-Frame-Options', 'DENY');
    // NOTE: No Cross-Origin-Resource-Policy on API — CORS handles cross-origin
  }

  c.res.headers.set('X-DNS-Prefetch-Control', 'off');

  await next();
}
