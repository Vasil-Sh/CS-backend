/**
 * One allow-list for both CORS and CSRF.
 *
 * Production: `CORS_ORIGINS` (comma-separated, e.g. "https://matchiq.pro,https://admin.matchiq.pro").
 * Previously CSRF had matchiq.pro hard-coded, so an admin panel on any other
 * domain got 403 on every save even after adding it to CORS_ORIGINS.
 * Matching is exact — `startsWith` also let "https://matchiq.pro.evil.com" through.
 */
const DEFAULT_PROD = 'https://matchiq.pro,https://www.matchiq.pro';
const DEV_ORIGINS = [
  'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
  'http://localhost:5176', 'http://localhost:5199', 'http://localhost:3001',
  'https://matchiq.vercel.app',
];

const normalize = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();

export function isDevEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  if (isDevEnv(env)) return DEV_ORIGINS;
  return (env.CORS_ORIGINS || DEFAULT_PROD).split(',').map(normalize).filter(Boolean);
}

/** True if a browser Origin may call the API with credentials. */
export function isAllowedOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const o = normalize(origin);
  if (isDevEnv(env)) {
    // Any local port and Vercel preview deployments while developing.
    if (/^http:\/\/localhost(:\d+)?$/.test(o)) return true;
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o)) return true;
  }
  return allowedOrigins(env).includes(o);
}
