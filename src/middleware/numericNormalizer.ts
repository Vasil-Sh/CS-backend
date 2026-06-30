/**
 * Middleware: converts all numeric strings in API JSON responses to actual numbers.
 * Fixes "toFixed is not a function" everywhere — one place, not 30+ files.
 *
 * Drizzle returns Postgres NUMERIC as strings in JSON.
 * This normalizer walks the response and converts them back to numbers.
 */
export function numericNormalizer(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (typeof result === 'string') {
    // Convert numeric strings like "85.00", "1.850", "0" to numbers
    const n = Number(result);
    if (!isNaN(n) && String(n) === result.replace(/\.?0+$/, '')) return n;
    // Handle trailing zeros: "85.00" → 85, "1.850" → 1.85
    if (/^-?\d+\.\d+$/.test(result)) return n;
    return result;
  }
  if (Array.isArray(result)) return result.map(numericNormalizer);
  if (typeof result === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      out[key] = numericNormalizer(value);
    }
    return out;
  }
  return result;
}
