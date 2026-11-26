/**
 * Reading a channel post with an AI model that sees the screenshot (Google Gemini, free tier): is it a tip, which match,
 * which market, which side, the odds. Turned on by GEMINI_API_KEY (the admin adds it in Railway); without it — OCR + rules.
 * The answer is written back as a plain tip line («A vs B / Перемога X @1.72») and goes through the same parser,
 * so matching to our feed, synthetic matches and settlement stay in one place.
 */
import { pool } from '../db/client';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest'; // Flash reads slips better than Flash-Lite; Lite is the fallback
export const aiEnabled = () => !!process.env.GEMINI_API_KEY;
export const aiStats = { calls: 0, failed: 0, lastError: null as string | null, lastAt: null as string | null, model: '' };

// ── the free tier's daily quota (Google resets it at midnight Pacific): requests per model today, kept across restarts ──
const DAILY = () => Math.max(10, Number(process.env.GEMINI_DAILY_LIMIT) || 250); // the main model's requests a day (see AI Studio → Rate limits)
const pacificDay = () => new Date(Date.now() - 8 * 3_600_000).toISOString().slice(0, 10);
export const aiUsage: { day: string; byModel: Record<string, number> } = { day: '', byModel: {} };
let usageLoaded = false;
async function loadUsage(): Promise<void> {
  if (usageLoaded) return;
  usageLoaded = true;
  try {
    const r = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'tg_ai_usage'`)).rows[0];
    if (r) Object.assign(aiUsage, JSON.parse(r.value));
  } catch { /* first run */ }
}
function count(model: string): void {
  if (aiUsage.day !== pacificDay()) { aiUsage.day = pacificDay(); aiUsage.byModel = {}; }
  aiUsage.byModel[model] = (aiUsage.byModel[model] || 0) + 1;
  void pool.query(`INSERT INTO app_settings(key, value) VALUES('tg_ai_usage', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(aiUsage)]).catch(() => {});
}
/** Requests left today for the main model; near the end of it the reader moves to Flash-Lite (its own, larger quota). */
export function aiQuota(): { used: number; limit: number; day: string; byModel: Record<string, number> } {
  const day = pacificDay(), by = aiUsage.day === day ? aiUsage.byModel : {};
  return { used: by[MODEL()] || 0, limit: DAILY(), day, byModel: by };
}
let nextAt = 0; // free tier: ~10–15 requests a minute — one call per 6 s

export interface AiTip {
  isTip: boolean; game?: 'cs2' | 'dota2' | 'other' | null; team1?: string | null; team2?: string | null;
  market?: 'match_winner' | 'map_winner' | 'total_maps' | 'handicap' | 'map_total' | 'map_handicap' | 'express' | 'other' | null;
  map?: number | null; pick?: string | null; line?: number | null; over?: boolean | null; odds?: number | null;
  /** What the slip itself shows: its state and the money on it (in the slip's currency). */
  status?: 'won' | 'lost' | 'pending' | 'void' | 'cashout' | null; stake?: number | null; currency?: string | null; payout?: number | null;
  /** An express: its legs (each a single bet), odds = the total odds. */
  legs?: AiTip[] | null;
  /** The bookmaker of the slip (BC.GAME, 1win…) — what the channel usually posts. */
  bookmaker?: string | null;
  /** A results summary the channel posted («вчора 5/6 ✅»): its claim, checked against ours. */
  report?: { won?: number | null; total?: number | null; period?: string | null } | null;
}

const PROMPT = `You read posts of a Telegram channel about esports betting (CS2, Dota 2). A post has a caption and maybe a screenshot of a bet slip or of an app.
Decide if the post itself shows or gives a betting tip / a placed bet (a "tip"). A screenshot of ONE bet slip / ticket / coupon (team names, a market, odds, often a stake) IS a tip, even when the caption is a joke, a short comment or empty — also when the slip already shows the result (won/lost) and when the same slip was posted before (a repost or the result of an earlier tip is still isTip=true).
NOT tips: news, app updates, chat, a scoreboard or a live score without a bet, an announcement of upcoming matches without a pick,
and screenshots of an app UI: a dashboard, a table or list of matches or of records (columns like Тип / Сума / Коеф / Профіт / Матч), a form («Новий запис», «Додати запис»), settings — even when odds or a team name appear in it. A slip is ONE bet shown as a ticket/card/coupon, not a row of a table.
For a tip, read: game, the two teams exactly as written, the market, the side picked, the line and the decimal odds.
"pick" is the team name only (no numbers, no brackets). For a handicap give the signed line of the picked team (+1.5 or -1.5).
From the slip also read: status — read the words on the slip and its button/badge first: won (Виграш, Виграно, Выигрыш, Выиграна, Won, «Профіт +…» shown as gained, a green ticket whose button says the bet won), lost (Програш, Проигрыш, Lost, red), pending (Очікується, Ожидается, Открыта, Pending, "possible win" only), cashout (sold / Продано / cash out), void (returned / refund); null when there is no slip;
stake — the amount staked, currency — its code or sign as written (₴, UAH, ₽, RUB, $, USD, USDT, €), payout — the total paid or to be paid (stake × odds), all as plain numbers.
Markets: match_winner (the series winner), map_winner (winner of map N — set "map"), total_maps (over/under N.5 maps — set "line" and "over"), handicap (map handicap — set "pick" and "line" like -1.5),
map_total (rounds / kills total on map N — set "map", "line", "over"), map_handicap (rounds handicap on map N — set "map", "pick", "line"), express (several matches in one bet — then list every match in "legs" with its own market, pick and odds, and give the total odds in "odds"), other.
Football, basketball and other non-esports bets: isTip=false. A tip written only in text («беру NAVI П1 за 1.85», «ставлю на Spirit 1.7») is a tip too.
A poll («хто виграє?») is not a tip. A summary of results («вчора 5/6 ✅», «за тиждень +12 юнітів») is not a tip: set "report" with won / total and the period.
"bookmaker": the bookmaker of the slip when it is shown (BC.GAME, 1win, Stake, Roobet, Pinnacle…). Answer JSON only.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isTip: { type: 'BOOLEAN' }, game: { type: 'STRING', nullable: true, enum: ['cs2', 'dota2', 'other'] },
    team1: { type: 'STRING', nullable: true }, team2: { type: 'STRING', nullable: true },
    market: { type: 'STRING', nullable: true, enum: ['match_winner', 'map_winner', 'total_maps', 'handicap', 'map_total', 'map_handicap', 'express', 'other'] },
    bookmaker: { type: 'STRING', nullable: true },
    report: { type: 'OBJECT', nullable: true, properties: { won: { type: 'INTEGER', nullable: true }, total: { type: 'INTEGER', nullable: true }, period: { type: 'STRING', nullable: true } } },
    map: { type: 'INTEGER', nullable: true }, pick: { type: 'STRING', nullable: true }, line: { type: 'NUMBER', nullable: true },
    over: { type: 'BOOLEAN', nullable: true }, odds: { type: 'NUMBER', nullable: true },
    status: { type: 'STRING', nullable: true, enum: ['won', 'lost', 'pending', 'void', 'cashout'] },
    stake: { type: 'NUMBER', nullable: true }, currency: { type: 'STRING', nullable: true }, payout: { type: 'NUMBER', nullable: true },
    legs: { type: 'ARRAY', nullable: true, items: { type: 'OBJECT', properties: {
      team1: { type: 'STRING', nullable: true }, team2: { type: 'STRING', nullable: true },
      market: { type: 'STRING', nullable: true, enum: ['match_winner', 'map_winner', 'total_maps', 'handicap', 'other'] },
      map: { type: 'INTEGER', nullable: true }, pick: { type: 'STRING', nullable: true }, line: { type: 'NUMBER', nullable: true }, over: { type: 'BOOLEAN', nullable: true }, odds: { type: 'NUMBER', nullable: true },
    } } },
  },
  required: ['isTip'],
};

/** The post read by the model, or null (no key, quota, network) — then OCR + rules take over. */
export async function aiReadPost(caption: string, photos: string[], hint = ''): Promise<AiTip | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const wait = nextAt - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  nextAt = Date.now() + 6_000;
  try {
    const parts: unknown[] = [{ text: `${PROMPT}${hint ? `\n\nAbout this channel: ${hint}` : ''}\n\nCaption:\n${caption || '(no caption)'}` }];
    for (const url of photos.slice(0, 4)) { // an album: up to 4 screenshots
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) continue;
      parts.push({ inline_data: { mime_type: r.headers.get('content-type') || 'image/jpeg', data: buf.toString('base64') } });
    }
    // «high demand» (503) / quota (429) are usually short: wait and retry, then the other Flash model
    await loadUsage();
    const q = aiQuota();
    let models = [...new Set([MODEL(), 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
    if (q.used >= q.limit * 0.9) models = models.filter((m) => m !== MODEL()).concat(MODEL()); // the main model's quota is nearly spent
    let body = null as Resp | null, lastErr = '';
    for (const model of models) {
      for (let attempt = 0; attempt < 3 && !body; attempt++) {
        if (attempt) await new Promise((ok) => setTimeout(ok, attempt * 5_000));
        let res: Response;
        try {
          // Flash «thinks» before answering — up to ~1.5 min on a busy day
          res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST', signal: AbortSignal.timeout(90_000),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA } }),
          });
        } catch (e) {
          // a timeout / dropped connection: not a quota — the next model answers faster
          aiStats.calls++; lastErr = `Gemini ${model}: ${(e as Error).name === 'TimeoutError' ? 'не відповів за 90 с' : (e as Error).message.slice(0, 120)}`;
          break;
        }
        aiStats.calls++; aiStats.lastAt = new Date().toISOString(); aiStats.model = model; count(model);
        if (res.ok) { body = await res.json() as Resp; break; }
        const raw = await res.text();
        let msg = raw;
        try { msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message || raw; } catch { /* not JSON */ }
        lastErr = `Gemini ${res.status}: ${msg.replace(/\s+/g, ' ').slice(0, 140)}`;
        if (![429, 500, 503].includes(res.status)) throw new Error(lastErr);
      }
      if (body) break;
    }
    if (!body) throw new Error(lastErr || 'Gemini: no answer');
    const txt = (body as Resp).candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return JSON.parse(txt) as AiTip;
  } catch (e) {
    aiStats.failed++; aiStats.lastError = (e as Error).message.slice(0, 200);
    console.warn('[tg] ai:', aiStats.lastError);
    return null;
  }
}

type Resp = { candidates?: { content?: { parts?: { text?: string }[] } }[] };
/** The slip's currency as one code: ₴/грн → UAH, ₽/руб → RUB, $ → USD, € → EUR, USDT stays. */
export function currencyCode(c?: string | null): string | null {
  const x = (c || '').trim().toUpperCase();
  if (!x) return null;
  if (/₴|ГРН|UAH/.test(x)) return 'UAH';
  if (/₽|РУБ|RUB|Р$/.test(x)) return 'RUB';
  if (/USDT/.test(x)) return 'USDT';
  if (/\$|USD/.test(x)) return 'USD';
  if (/€|EUR/.test(x)) return 'EUR';
  if (/₸|KZT/.test(x)) return 'KZT';
  return /^[A-Z]{3,4}$/.test(x) ? x : null;
}

const n2 = (x: number) => String(x).replace(',', '.');
/** The model's answer as a tip line for the parser; '' for «not a tip». */
export function aiLine(a: AiTip): string {
  if (!a.isTip || a.game === 'other') return '';
  const pick = (a.pick || '').replace(/\([^)]*\)/g, '').replace(/[+\-−]?\d+(?:[.,]\d+)?/g, '').replace(/\s+/g, ' ').trim() || null;
  a = { ...a, pick };
  const head = a.team1 && a.team2 ? `${a.team1} vs ${a.team2}` : a.team1 || a.team2 || '';
  const kf = a.odds ? ` @${n2(a.odds)}` : '';
  const game = a.game === 'dota2' ? 'Dota 2' : a.game === 'cs2' ? 'CS2' : '';
  let bet = '';
  if (a.market === 'express') bet = 'Експрес';
  else if (a.market === 'map_winner' || a.market === 'map_total' || a.market === 'map_handicap') bet = `Карта ${a.map || 1} переможець ${a.pick || a.team1 || ''}`; // the market itself is set from the answer
  else if (a.market === 'total_maps' && a.line) bet = `${a.over === false ? 'ТМ' : 'ТБ'} ${n2(a.line)}`;
  else if (a.market === 'handicap' && a.line != null) bet = `Фора ${a.pick || ''} ${a.line > 0 ? '+' : ''}${n2(a.line)}`;
  else if (a.pick) bet = `Перемога ${a.pick}`;
  return [game, head, `${bet}${kf}`].filter(Boolean).join('\n');
}
