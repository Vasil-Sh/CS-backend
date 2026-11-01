/**
 * Middleware: converts all numeric strings in API JSON responses to actual numbers.
 * Fixes "toFixed is not a function" everywhere — one place, not 30+ files.
 *
 * Drizzle returns Postgres NUMERIC as strings in JSON.
 * This normalizer walks the response and converts them back to numbers.
 */
/**
 * Free-text / identity fields are never converted: a username or Telegram
 * handle like "12345" must stay a string (the admin panel calls string
 * methods on them), and a team called "Infinity" must not become null.
 */
const TEXT_KEYS = new Set([
  'username', 'telegram', 'password', 'name', 'title', 'description', 'note', 'notes',
  'actor_name', 'actorName', 'target_username', 'targetUsername', 'actor_telegram',
  'createdBy', 'cancelledBy', 'cancelReason', 'reason', 'href', 'imageUrl',
]);

export function numericNormalizer(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (typeof result === 'string') {
    // Convert numeric strings like "85.00", "1.850", "0" to numbers
    const n = Number(result);
    if (!Number.isFinite(n)) return result; // "Infinity", "NaN" stay text
    if (!isNaN(n) && String(n) === result.replace(/\.?0+$/, '')) return n;
    // Handle trailing zeros: "85.00" → 85, "1.850" → 1.85
    if (/^-?\d+\.\d+$/.test(result)) return n;
    return result;
  }
  if (Array.isArray(result)) return result.map(numericNormalizer);
  if (typeof result === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      out[key] = TEXT_KEYS.has(key) ? value : numericNormalizer(value);
    }
    return out;
  }
  return result;
}
