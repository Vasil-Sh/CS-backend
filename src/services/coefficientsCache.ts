/**
 * CoefficientsCache — File-based cache for Dota2 bookmaker coefficients.
 *
 * Coefficients change slowly (~15-30 min), so caching them separately
 * avoids expensive Puppeteer predictions-page fetches on every refresh.
 *
 * Cache lives in .cache/dota2_coefficients.json, survives server restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'dota2_coefficients.json');
const COEFFICIENTS_TTL_MS = 20 * 60 * 1000; // 20 minutes

interface CoefficientsEntry {
  coeff1: number;
  coeff2: number;
  ts: number;
}

interface CoefficientsCacheData {
  [matchSlug: string]: CoefficientsEntry;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(): CoefficientsCacheData {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeCache(data: CoefficientsCacheData): void {
  try {
    ensureCacheDir();
    const tmp = CACHE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    try { if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE); } catch {}
    renameSync(tmp, CACHE_FILE);
  } catch { /* ignore */ }
}

export function getCachedCoefficients(
  matchSlug: string
): { coeff1: number; coeff2: number } | null {
  const cache = readCache();
  const entry = cache[matchSlug];
  if (!entry) return null;

  const age = Date.now() - entry.ts;
  if (age > COEFFICIENTS_TTL_MS) return null; // expired

  return { coeff1: entry.coeff1, coeff2: entry.coeff2 };
}

export function setCachedCoefficients(
  matchSlug: string,
  coeff1: number,
  coeff2: number
): void {
  const cache = readCache();
  cache[matchSlug] = { coeff1, coeff2, ts: Date.now() };

  // Cleanup expired entries to prevent cache bloat
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (now - cache[key].ts > COEFFICIENTS_TTL_MS * 2) {
      delete cache[key];
    }
  }

  writeCache(cache);
}
