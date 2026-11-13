// ═══════════════════════════════════════════
// Subscription plan names — map price_month → plan
// ═══════════════════════════════════════════

export type PlanKey = 'trial' | 'basic' | 'pro';
export type PlanName = 'Пробний' | 'Базова' | 'Pro';

const PLAN_LABELS: Record<PlanKey, PlanName> = {
  trial: 'Пробний',
  basic: 'Базова',
  pro: 'Pro',
};

/** Normalize any stored plan value to a valid key (falls back to 'trial'). */
export function planKey(value: string | null | undefined): PlanKey {
  return value === 'basic' || value === 'pro' ? value : 'trial';
}

/** Map a stored plan key to a human-readable label. */
export function planLabel(value: string | null | undefined): PlanName {
  return PLAN_LABELS[planKey(value)];
}

/**
 * Map a monthly price (₴) to a plan key — used only as a fallback when the
 * stored `plan` column is missing/legacy. 0 → trial, <600 → basic, ≥600 → pro.
 */
export function planKeyFromPrice(price: number): PlanKey {
  if (price >= 600) return 'pro';
  if (price > 0) return 'basic';
  return 'trial';
}

/** Legacy helper — returns the label for a price (falls back through planKeyFromPrice). */
export function planName(price: number): PlanName {
  return PLAN_LABELS[planKeyFromPrice(price)];
}
