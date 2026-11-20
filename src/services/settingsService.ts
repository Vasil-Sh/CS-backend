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
  adsOddsInList: boolean;
  adsMatchDetails: boolean;
  /** Step of the «+N днів» button (7 / 14 / 30). */
  trialStepDays: number;
  /** AI: words that make the answer be rewritten, and the wording rule shown to the model. */
  aiStopWords: string[];
  aiWordingRule: string;
  /** Texts shown in the app. */
  footerDisclaimer: string;
  addictionHelp: string;
  beforeAiText: string;
  /** «Потребує уваги»: subscription ends within N days. */
  expiringDays: number;
  /** Payment receipt. */
  receiptSupport: string;
  receiptThanks: string;
  receiptPrefix: string;
  /** Message templates opened by «Написати». */
  tplExpiring: string;
  tplInactive: string;
  tplPaid: string;
  tplLapsed: string;
}

/** When and by whom a setting was last written (keys are AppSettings field names). */
export type SettingsMeta = Record<string, { at: string; by: string }>;

/** camelCase field → app_settings key. */
const KEY: Record<keyof AppSettings, string> = {
  defaultMonthlyPrice: 'default_monthly_price', subscriptionDays: 'subscription_days', bannerSpecText: 'banner_spec_text',
  basicPrice: 'basic_price', proPrice: 'pro_price', basicFeatures: 'basic_features', proFeatures: 'pro_features',
  trialEnabled: 'trial_enabled', trialDays: 'trial_days', trialPlan: 'trial_plan', aiDailyLimit: 'ai_daily_limit',
  warningThreshold: 'warning_threshold', receiptFields: 'receipt_fields', disclaimerText: 'disclaimer_text', aiUsdUah: 'ai_usd_uah',
  churnInactiveDays: 'churn_inactive_days', churnLossStreak: 'churn_loss_streak', adsOddsInList: 'ads_odds_in_list', adsMatchDetails: 'ads_match_details',
  trialStepDays: 'trial_step_days', aiStopWords: 'ai_stop_words', aiWordingRule: 'ai_wording_rule',
  footerDisclaimer: 'footer_disclaimer', addictionHelp: 'addiction_help', beforeAiText: 'before_ai_text', expiringDays: 'expiring_days',
  receiptSupport: 'receipt_support', receiptThanks: 'receipt_thanks', receiptPrefix: 'receipt_prefix',
  tplExpiring: 'tpl_expiring', tplInactive: 'tpl_inactive', tplPaid: 'tpl_paid', tplLapsed: 'tpl_lapsed',
};

const DEFAULTS: AppSettings = {
  defaultMonthlyPrice: 0,
  subscriptionDays: 30,
  bannerSpecText: '',
  basicPrice: 300,
  proPrice: 600,
  basicFeatures: ['Журнал ставок і банк', 'Матчі й календар', 'Аналітика: прибуток, коефіцієнти, періоди', 'Цілі та стратегії'],
  proFeatures: ['Усе з Базової', 'AI-аналіз матчів', 'Telegram-групи: розбір прогнозів', 'Ризиковані команди: імпорт і масові дії', 'Публічний профіль з ціллю'],
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
  adsOddsInList: true,
  adsMatchDetails: true,
  trialStepDays: 30,
  aiStopWords: ['ставте', 'гарантовано', 'впевнений виграш', '100%'],
  aiWordingRule: 'Описуй лише те, що показують дані: форма команд, особисті зустрічі, коефіцієнти, історія записів користувача. Не радь ставити, не обіцяй результат.',
  footerDisclaimer: 'MatchIQ не приймає ставки й не зберігає кошти. Лише для осіб 21+.',
  addictionHelp: 'Гаряча лінія та посилання: gamblingtherapy.org/uk',
  beforeAiText: 'Аналіз описує дані й не є порадою щодо ставок.',
  expiringDays: 7,
  receiptSupport: '@cs2beet',
  receiptThanks: 'Дякуємо, що обираєш MatchIQ!',
  receiptPrefix: 'MIQ',
  tplExpiring: 'Привіт, {логін}! Ваша підписка MatchIQ закінчується {дата_закінчення}. Продовження на {тариф} — {сума}. Напишіть, якщо зручно оплатити — надішлю реквізити.',
  tplInactive: 'Привіт, {логін}! Давно не бачили ваших ставок — уже {днів_без_ставок} днів. Щось не працює? Напишіть — розберемося.',
  tplPaid: 'Дякуємо, {логін}! Оплату {сума} отримали, {тариф} діє до {дата_закінчення}.',
  tplLapsed: 'Привіт, {логін}! Підписка закінчилась {дата_закінчення}. Повернути {тариф} за {сума}? Напишіть — надішлю реквізити.',
};

/** Variables a message template may use. */
export const TEMPLATE_VARS = ['{логін}', '{дата_закінчення}', '{тариф}', '{сума}', '{днів_без_ставок}'];

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
    adsOddsInList: bool('ads_odds_in_list', DEFAULTS.adsOddsInList),
    adsMatchDetails: bool('ads_match_details', DEFAULTS.adsMatchDetails),
    trialStepDays: num('trial_step_days', DEFAULTS.trialStepDays),
    aiStopWords: jsonArr('ai_stop_words', DEFAULTS.aiStopWords),
    aiWordingRule: map.get('ai_wording_rule') ?? DEFAULTS.aiWordingRule,
    footerDisclaimer: map.get('footer_disclaimer') ?? DEFAULTS.footerDisclaimer,
    addictionHelp: map.get('addiction_help') ?? DEFAULTS.addictionHelp,
    beforeAiText: map.get('before_ai_text') ?? DEFAULTS.beforeAiText,
    expiringDays: num('expiring_days', DEFAULTS.expiringDays),
    receiptSupport: map.get('receipt_support') ?? DEFAULTS.receiptSupport,
    receiptThanks: map.get('receipt_thanks') ?? DEFAULTS.receiptThanks,
    receiptPrefix: map.get('receipt_prefix') ?? DEFAULTS.receiptPrefix,
    tplExpiring: map.get('tpl_expiring') ?? DEFAULTS.tplExpiring,
    tplInactive: map.get('tpl_inactive') ?? DEFAULTS.tplInactive,
    tplPaid: map.get('tpl_paid') ?? DEFAULTS.tplPaid,
    tplLapsed: map.get('tpl_lapsed') ?? DEFAULTS.tplLapsed,
  };
}

/** Values for a message template; missing ones stay as the variable. */
export interface TemplateValues { login?: string; endDate?: string; plan?: string; amount?: string; idleDays?: number }

/** «Pro» / «Базову» (as in «Продовження на Базову»). */
export const planAccusative = (plan?: string | null) => (plan === 'pro' ? 'Pro' : 'Базову');

export function fillTemplate(text: string, v: TemplateValues): string {
  const map: Record<string, string | undefined> = {
    '{логін}': v.login, '{дата_закінчення}': v.endDate, '{тариф}': v.plan, '{сума}': v.amount,
    '{днів_без_ставок}': v.idleDays === undefined ? undefined : String(v.idleDays),
  };
  return text.replace(/\{[^{}\s]*\}/g, (m) => map[m] ?? m);
}

/** Check a message template: only known variables, sane length. Returns an error text or ''. */
export function templateError(text: string): string {
  if (!text.trim()) return 'Шаблон не може бути порожнім';
  if (text.length > 1000) return 'Шаблон — до 1000 символів';
  const unknown = (text.match(/\{[^{}]*\}/g) || []).filter((v) => !TEMPLATE_VARS.includes(v));
  return unknown.length ? `Змінної ${unknown[0]} немає` : '';
}

/** Short text fields: required, trimmed, capped. */
function textField(value: unknown, label: string, max: number): string {
  const v = String(value ?? '').trim();
  if (!v) throw new Error(`${label}: текст не може бути порожнім`);
  if (v.length > max) throw new Error(`${label}: до ${max} символів`);
  return v;
}

export class SettingsService {
  /** Read all settings (falls back to defaults for missing keys). */
  async get(): Promise<AppSettings> {
    const { rows } = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM app_settings',
    );
    return toSettings(rows);
  }

  /** Who changed each setting and when (only keys that were ever written). */
  async meta(): Promise<SettingsMeta> {
    const { rows } = await pool.query<{ key: string; at: Date; by: string }>(
      'SELECT key, updated_at AS at, updated_by AS by FROM app_settings',
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out: SettingsMeta = {};
    for (const [field, key] of Object.entries(KEY)) {
      const r = byKey.get(key);
      if (r) out[field] = { at: new Date(r.at).toISOString(), by: r.by || '' };
    }
    return out;
  }

  /** Upsert the provided settings (only known keys are written). */
  async update(patch: Partial<AppSettings>, by = ''): Promise<AppSettings> {
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
      const feats = (list: string[], label: string) => {
        const v = list.map((x) => String(x).trim()).filter(Boolean);
        if (!v.length || v.length > 12 || v.some((x) => x.length > 80)) throw new Error(`${label}: від 1 до 12 пунктів, кожен до 80 символів`);
        return JSON.stringify(v);
      };
      if (patch.basicFeatures !== undefined) entries.push(['basic_features', feats(patch.basicFeatures, 'Функції Базової')]);
      if (patch.proFeatures !== undefined) entries.push(['pro_features', feats(patch.proFeatures, 'Функції Pro')]);
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
      if (patch.adsOddsInList !== undefined) entries.push(['ads_odds_in_list', String(Boolean(patch.adsOddsInList))]);
      if (patch.adsMatchDetails !== undefined) entries.push(['ads_match_details', String(Boolean(patch.adsMatchDetails))]);
      if (patch.trialStepDays !== undefined) {
        const n = Number(patch.trialStepDays);
        if (![7, 14, 30].includes(n)) throw new Error('Крок «+N днів» — 7, 14 або 30');
        entries.push(['trial_step_days', String(n)]);
      }
      if (patch.trialPlan !== undefined && !['basic', 'pro'].includes(String(patch.trialPlan))) throw new Error('План пробного — basic або pro');
      if (patch.aiStopWords !== undefined) {
        const words = [...new Set(patch.aiStopWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean))];
        if (words.length > 50 || words.some((w) => w.length > 40)) throw new Error('Заборонені слова: до 50 слів, кожне до 40 символів');
        entries.push(['ai_stop_words', JSON.stringify(words)]);
      }
      if (patch.aiWordingRule !== undefined) entries.push(['ai_wording_rule', textField(patch.aiWordingRule, 'Правило формулювань', 1000)]);
      if (patch.footerDisclaimer !== undefined) entries.push(['footer_disclaimer', textField(patch.footerDisclaimer, 'Дисклеймер у футері', 300)]);
      if (patch.addictionHelp !== undefined) entries.push(['addiction_help', textField(patch.addictionHelp, 'Допомога при залежності', 300)]);
      if (patch.beforeAiText !== undefined) entries.push(['before_ai_text', textField(patch.beforeAiText, 'Перед AI-аналізом', 300)]);
      if (patch.expiringDays !== undefined) {
        const n = Number(patch.expiringDays);
        if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('«Підписка закінчується за» — від 1 до 30 днів');
        entries.push(['expiring_days', String(n)]);
      }
      if (patch.receiptSupport !== undefined) {
        const v = String(patch.receiptSupport).trim().replace(/^@?/, '@');
        if (!/^@[a-zA-Z0-9_]{5,32}$/.test(v)) throw new Error('Telegram підтримки — @логін, 5–32 латинські літери, цифри або _');
        entries.push(['receipt_support', v]);
      }
      if (patch.receiptThanks !== undefined) entries.push(['receipt_thanks', textField(patch.receiptThanks, 'Фраза подяки', 80)]);
      if (patch.receiptPrefix !== undefined) {
        const v = String(patch.receiptPrefix).trim().toUpperCase();
        if (!/^[A-Z0-9]{1,6}$/.test(v)) throw new Error('Префікс чека — 1–6 латинських літер або цифр');
        entries.push(['receipt_prefix', v]);
      }
      for (const [field, key] of [['tplExpiring', 'tpl_expiring'], ['tplInactive', 'tpl_inactive'], ['tplPaid', 'tpl_paid'], ['tplLapsed', 'tpl_lapsed']] as const) {
        const v = patch[field];
        if (v === undefined) continue;
        const err = templateError(String(v));
        if (err) throw new Error(err);
        entries.push([key, String(v).trim()]);
      }
      // Write only values that really changed, so «змінено …» stays honest.
      const { rows: cur } = await client.query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
      const was = new Map(cur.map((r) => [r.key, r.value]));
      for (const [key, value] of entries) {
        if (was.get(key) === value) continue;
        await client.query(
          `INSERT INTO app_settings(key, value, updated_by) VALUES($1, $2, $3)
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [key, value, by],
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
