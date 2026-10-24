// ═══════════════════════════════════════════════════════════════
// Proxy pool for tips.gg scraping.
//
// Reads TIPSGG_PROXIES env: comma-separated HTTP/HTTPS/SOCKS proxy URLs.
//   TIPSGG_PROXIES="http://user:pass@host:port,http://user2:pass2@host2:port2"
//
// Rotates proxies round-robin. When a proxy returns 403/429 (Cloudflare
// block), it is temporarily banned and the next one is used instead of
// freezing all traffic. Only when every proxy is banned (or none is
// configured) does the caller fall back to the global hard-ban freeze.
// ═══════════════════════════════════════════════════════════════

import { ProxyAgent } from 'undici';

export interface ProxyEntry {
  url: string;
  agent: ProxyAgent;
  bannedUntil: number;
}

function parseProxies(): ProxyEntry[] {
  const raw = (process.env.TIPSGG_PROXIES || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => {
      try {
        return {
          url,
          agent: new ProxyAgent(url),
          bannedUntil: 0,
        };
      } catch (err) {
        console.warn(`[proxy] Invalid proxy URL ignored: ${url}`, (err as Error).message);
        return null;
      }
    })
    .filter((p): p is ProxyEntry => p !== null);
}

const pool = parseProxies();
let cursor = 0;

export function proxyCount(): number {
  return pool.length;
}

export function hasProxies(): boolean {
  return pool.length > 0;
}

/** Return the first non-banned proxy (advancing the cursor to it). */
export function currentProxy(): ProxyEntry | null {
  if (!pool.length) return null;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const p = pool[(cursor + i) % pool.length];
    if (now >= p.bannedUntil) {
      cursor = (cursor + i) % pool.length;
      return p;
    }
  }
  // All proxies banned — return the one whose ban expires soonest.
  return pool.reduce((a, b) => (a.bannedUntil < b.bannedUntil ? a : b));
}

/** Temporarily mark a proxy as blocked (Cloudflare/rate limit). */
export function banProxy(entry: ProxyEntry | null, ms: number): void {
  if (entry) entry.bannedUntil = Date.now() + ms;
}

/** undici dispatcher for the current proxy (undefined when no proxies). */
export function proxyDispatcher(): ProxyAgent | undefined {
  const p = currentProxy();
  return p ? p.agent : undefined;
}

export function currentProxyUrl(): string | undefined {
  return currentProxy()?.url;
}

/** Extract proxy credentials for Chromium `page.authenticate`. */
export function currentProxyAuth(): { username: string; password: string } | null {
  const url = currentProxyUrl();
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return null;
    return {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}

/** Clear all proxy bans (e.g. environment recovered). */
export function clearProxyBans(): void {
  for (const p of pool) p.bannedUntil = 0;
}
