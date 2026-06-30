import type { Context, Next } from 'hono';

/**
 * Helmet-like security headers middleware.
 * Protects against XSS, clickjacking, MIME sniffing, and other common attacks.
 */
export async function securityHeaders(c: Context, next: Next) {
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '0'); // Deprecated, but disables legacy filter
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; connect-src 'self' https://api.deepseek.com https://api.telegram.org; frame-ancestors 'none'"
  );
  c.res.headers.set('X-DNS-Prefetch-Control', 'off');
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  c.res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  await next();
}
