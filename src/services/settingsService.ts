// ═══════════════════════════════════════════
// App settings service — admin-managed key/value store.
// ═══════════════════════════════════════════

import { pool } from '../db/client';

export interface AppSettings {
  defaultMonthlyPrice: number;
  subscriptionDays: number;
  bannerSpecText: string;
  /** Plan prices (UAH/month). */
  basicPrice: number;
  proPrice: number;
  /** Plan feature lists (JSON string arrays). */
  basicFeatures: string[];
  proFeatures: string[];
  /** Trial period config. */
  trialEnabled: boolean;
  trialDays: number;
  trialPlan: string;
  /** AI usage limits (per user per day). */
  aiDailyLimit: number;
  /** Warning thresholds. */
  warningThreshold: number;
  /** Receipt fields (JSON string array). */
  receiptFields: string[];
  /** Disclaimer text. */
  disclaimerText: string;
  /** USD → UAH exchange rate for AI cost (default 41.5). */
  aiUsdUah: number;
  /** Churn: inactive for N days (default 14). */
  churnInactiveDays: number;
  /** Churn: consecutive losses threshold (default 5). */
  churnLossStreak: number;
}

const DEFAULTS: AppSettings = {
  defaultMonthlyPrice: 0,
  subscriptionDays: 30,
  bannerSpecText: '',
  basicPrice: 300,
  proPrice: 600,
  basicFeatures: [],
  proFeatures: [],
  trialEnabled: false,
  trialDays: 7,
  trialPlan: 'basic',
  aiDailyLimit: 5,
  warningThreshold: 3,
  receiptFields: [],
  disclaimerText: '',
  aiUsdUah: 41.5,
  churnInactiveDays: 14,
  churnLossStreak: 5,
};

/** Normalize a raw DB row set into a typed settings object. */
function toSettings(rows: { key: string; value: string }[]): AppSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const raw = map.get(key);
    if (raw == null) return fallback;
    return raw === 'true' || raw === '1';
  };
  const jsonArr = (key: string, fallback: string[]) => {
    const raw = map.get(key);
    if (raw == null) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    defaultMonthlyPrice: num('default_monthly_price', DEFAULTS.defaultMonthlyPrice),
    subscriptionDays: num('subscription_days', DEFAULTS.subscriptionDays),
    bannerSpecText: map.get('banner_spec_text') ?? DEFAULTS.bannerSpecText,
    basicPrice: num('basic_price', DEFAULTS.basicPrice),
    proPrice: num('pro_price', DEFAULTS.proPrice),
    basicFeatures: jsonArr('basic_features', DEFAULTS.basicFeatures),
    proFeatures: jsonArr('pro_features', DEFAULTS.proFeatures),
    trialEnabled: bool('trial_enabled', DEFAULTS.trialEnabled),
    trialDays: num('trial_days', DEFAULTS.trialDays),
    trialPlan: map.get('trial_plan') ?? DEFAULTS.trialPlan,
    aiDailyLimit: num('ai_daily_limit', DEFAULTS.aiDailyLimit),
    warningThreshold: num('warning_threshold', DEFAULTS.warningThreshold),
    receiptFields: jsonArr('receipt_fields', DEFAULTS.receiptFields),
    disclaimerText: map.get('disclaimer_text') ?? DEFAULTS.disclaimerText,
    aiUsdUah: num('ai_usd_uah', DEFAULTS.aiUsdUah),
    churnInactiveDays: num('churn_inactive_days', DEFAULTS.churnInactiveDays),
    churnLossStreak: num('churn_loss_streak', DEFAULTS.churnLossStreak),
  };
}

export class SettingsService {
  /** Read all settings (falls back to defaults for missing keys). */
  async get(): Promise<AppSettings> {
    const { rows } = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM app_settings',
    );
    return toSettings(rows);
  }

  /** Upsert the provided settings (only known keys are written). */
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entries: [string, string][] = [];
      if (patch.defaultMonthlyPrice !== undefined) {
        const n = Number(patch.defaultMonthlyPrice);
        if (!Number.isFinite(n) || n < 0) throw new Error('invalid price');
        entries.push(['default_monthly_price', String(n)]);
      }
      if (patch.subscriptionDays !== undefined) {
        const n = Number(patch.subscriptionDays);
        if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('invalid days');
        entries.push(['subscription_days', String(n)]);
      }
      if (patch.bannerSpecText !== undefined) {
        if (typeof patch.bannerSpecText !== 'string' || patch.bannerSpecText.length > 10000)
          throw new Error('invalid spec text');
        entries.push(['banner_spec_text', patch.bannerSpecText]);
      }
      const pushNum = (key: string, value: number | undefined, min = 0, max = 1_000_000) => {
        if (value === undefined) return;
        const n = Number(value);
        if (!Number.isFinite(n) || n < min || n > max) throw new Error('invalid number');
        entries.push([key, String(n)]);
      };
      pushNum('basic_price', patch.basicPrice);
      pushNum('pro_price', patch.proPrice);
      if (patch.basicFeatures !== undefined) entries.push(['basic_features', JSON.stringify(patch.basicFeatures)]);
      if (patch.proFeatures !== undefined) entries.push(['pro_features', JSON.stringify(patch.proFeatures)]);
      if (patch.trialEnabled !== undefined) entries.push(['trial_enabled', String(Boolean(patch.trialEnabled))]);
      pushNum('trial_days', patch.trialDays, 1, 365);
      if (patch.trialPlan !== undefined) entries.push(['trial_plan', String(patch.trialPlan)]);
      pushNum('ai_daily_limit', patch.aiDailyLimit, 0, 1000);
      pushNum('warning_threshold', patch.warningThreshold, 0, 100);
      if (patch.receiptFields !== undefined) entries.push(['receipt_fields', JSON.stringify(patch.receiptFields)]);
      if (patch.disclaimerText !== undefined) entries.push(['disclaimer_text', String(patch.disclaimerText)]);
      if (patch.aiUsdUah !== undefined) {
        const n = Number(patch.aiUsdUah);
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('invalid ai usd/uah rate');
        entries.push(['ai_usd_uah', String(n)]);
      }
      if (patch.churnInactiveDays !== undefined) {
        const n = Number(patch.churnInactiveDays);
        if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('churnInactiveDays має бути від 1 до 365');
        entries.push(['churn_inactive_days', String(n)]);
      }
      if (patch.churnLossStreak !== undefined) {
        const n = Number(patch.churnLossStreak);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('churnLossStreak має бути від 1 до 50');
        entries.push(['churn_loss_streak', String(n)]);
      }
      for (const [key, value] of entries) {
        await client.query(
          `INSERT INTO app_settings(key, value) VALUES($1, $2)
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, value],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.get();
  }
}

export const settingsService = new SettingsService();
