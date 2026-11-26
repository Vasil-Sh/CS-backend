/**
 * Rough exchange rates to US dollars, to compare channels that stake in different currencies («≈ $»).
 * Fetched once a day from open.er-api.com (free, no key); until then (or when it fails) fixed rates close to the real ones.
 */
const FALLBACK: Record<string, number> = { USD: 1, USDT: 1, EUR: 1.08, UAH: 0.024, RUB: 0.011, KZT: 0.002 };
let rates: Record<string, number> = { ...FALLBACK }, at = 0, loading: Promise<void> | null = null;

async function load(): Promise<void> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10_000) });
    const j = await r.json() as { result?: string; rates?: Record<string, number> };
    if (j.result === 'success' && j.rates) {
      const next: Record<string, number> = { USD: 1, USDT: 1 };
      for (const [k, v] of Object.entries(j.rates)) if (v > 0) next[k] = 1 / v; // dollars per unit
      rates = { ...FALLBACK, ...next };
    }
  } catch { /* keep the last rates */ }
  at = Date.now();
}
/** Dollars for an amount in a currency (null when the currency is unknown); refreshes the rates once a day in the background. */
export function toUsd(amount: number, currency: string | null | undefined): number | null {
  if (Date.now() - at > 86_400_000 && !loading) loading = load().finally(() => { loading = null; });
  const r = currency ? rates[currency.toUpperCase()] : undefined;
  return r ? Math.round(amount * r * 100) / 100 : null;
}
