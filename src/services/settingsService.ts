// ═══════════════════════════════════════════
// App settings service — admin-managed key/value store.
// ═══════════════════════════════════════════

import { pool } from '../db/client';

export interface AppSettings {
  defaultMonthlyPrice: number;
  subscriptionDays: number;
  bannerSpecText: string;
}

const DEFAULTS: AppSettings = {
  defaultMonthlyPrice: 0,
  subscriptionDays: 30,
  bannerSpecText: '',
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
  return {
    defaultMonthlyPrice: num('default_monthly_price', DEFAULTS.defaultMonthlyPrice),
    subscriptionDays: num('subscription_days', DEFAULTS.subscriptionDays),
    bannerSpecText: map.get('banner_spec_text') ?? DEFAULTS.bannerSpecText,
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
