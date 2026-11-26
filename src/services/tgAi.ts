/**
 * Reading a channel post with an AI model that sees the screenshot (Google Gemini, free tier): is it a tip, which match,
 * which market, which side, the odds. Turned on by GEMINI_API_KEY (the admin adds it in Railway); without it — OCR + rules.
 * The answer is written back as a plain tip line («A vs B / Перемога X @1.72») and goes through the same parser,
 * so matching to our feed, synthetic matches and settlement stay in one place.
 */
import { createHash } from 'crypto';
import { pool } from '../db/client';
import { accountMedia } from './tgAccount';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest'; // Flash reads slips better than Flash-Lite; Lite is the fallback
export const aiEnabled = () => ['GEMINI_API_KEY', 'GITHUB_MODELS_TOKEN'].some((k) => !!process.env[k]);
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

const FIELDS = `Answer with ONE JSON object: {"isTip": boolean, "game": "cs2"|"dota2"|"other"|null, "team1": string|null, "team2": string|null,
"market": "match_winner"|"map_winner"|"total_maps"|"handicap"|"map_total"|"map_handicap"|"express"|"other"|null, "map": number|null, "pick": string|null,
"line": number|null, "over": boolean|null, "odds": number|null, "status": "won"|"lost"|"pending"|"void"|"cashout"|null, "stake": number|null, "currency": string|null,
"payout": number|null, "bookmaker": string|null, "report": {"won": number|null, "total": number|null, "period": string|null}|null,
"legs": [{"team1","team2","market","map","pick","line","over","odds"}]|null}. No other text.`;

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
// ── the readers, in order: Gemini Flash → GitHub Models → Cloudflare AI → Gemini Flash-Lite (each on its own key) ──
export type Img = { mime: string; b64: string };
interface Provider { id: string; label: string; key: () => string | undefined; keyName: string; model: () => string; call: (prompt: string, imgs: Img[], model: string, key: string, schema?: object) => Promise<Response> }
const openAi = (url: string, json = true) => (prompt: string, imgs: Img[], model: string, key: string) => fetch(url, {
  method: 'POST', signal: AbortSignal.timeout(90_000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, temperature: 0, max_tokens: 1200, ...(json ? { response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } }))] }] }),
});
const gemini = (prompt: string, imgs: Img[], model: string, key: string, schema: object = SCHEMA) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST', signal: AbortSignal.timeout(90_000), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, ...imgs.map((i) => ({ inline_data: { mime_type: i.mime, data: i.b64 } }))] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }),
});
export const PROVIDERS: Provider[] = [
  { id: 'gemini', label: 'Gemini Flash', keyName: 'GEMINI_API_KEY', key: () => process.env.GEMINI_API_KEY, model: () => MODEL(), call: gemini },
  { id: 'github', label: 'GitHub Models', keyName: 'GITHUB_MODELS_TOKEN', key: () => process.env.GITHUB_MODELS_TOKEN, model: () => process.env.GITHUB_VISION_MODEL || 'openai/gpt-4o-mini', call: openAi('https://models.github.ai/inference/chat/completions') },
  // Cloudflare Workers AI: a free daily allocation (10 000 neurons ≈ a few hundred screenshots); the token and the account id
  { id: 'cloudflare', label: 'Cloudflare AI', keyName: 'CLOUDFLARE_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID', key: () => (process.env.CLOUDFLARE_ACCOUNT_ID ? process.env.CLOUDFLARE_AI_TOKEN : undefined),
    model: () => process.env.CLOUDFLARE_VISION_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct',
    call: (prompt, imgs, model, key) => openAi(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`, false)(prompt, imgs, model, key) },
  { id: 'gemini-lite', label: 'Gemini Flash-Lite', keyName: 'GEMINI_API_KEY', key: () => process.env.GEMINI_API_KEY, model: () => 'gemini-flash-lite-latest', call: gemini },
];
/** Per reader: today's requests, its last error, and until when it rests (a daily quota → the next Pacific day, a minute limit / overload → a few minutes). */
export const readerState: Record<string, { ok: number; failed: number; lastError: string | null; restUntil: number }> = {};
const st = (id: string) => (readerState[id] ||= { ok: 0, failed: 0, lastError: null, restUntil: 0 });
const nextPacificMidnight = () => { const d = new Date(Date.now() - 8 * 3_600_000); d.setUTCHours(24, 0, 0, 0); return d.getTime() + 8 * 3_600_000; };

/** The text of an answer (Gemini or OpenAI-style), its JSON object only. */
function answerText(body: unknown): string {
  const b = body as Resp & { choices?: { message?: { content?: string } }[] };
  const c = b.choices?.[0]?.message?.content as unknown;
  const t = b.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || (c && typeof c === 'object' ? JSON.stringify(c) : (c as string)) || '';
  const m = /\{[\s\S]*\}/.exec(t.replace(/<think>[\s\S]*?<\/think>/g, ''));
  return m ? m[0] : t;
}

/** One reader on one post: the parsed answer, or why not. */
async function ask(p: Provider, prompt: string, imgs: Img[], schema: object = SCHEMA, check: (txt: string) => string = (t) => answerProblem({ candidates: [{ content: { parts: [{ text: t }] } }] })): Promise<{ tip?: AiTip; raw?: unknown; why?: string }> {
  const key = p.key(), s = st(p.id), model = p.model();
  if (!key) return { why: 'немає ключа' };
  if (Date.now() < s.restUntil) return { why: 'відпочиває' };
  if (p.id === 'gemini' && aiQuota().used >= aiQuota().limit * 0.9) return { why: 'денний ліміт майже вичерпано' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 5_000));
    let res: Response;
    try { res = await p.call(prompt, imgs, p.model(), key, schema); } catch (e) {
      s.failed++; s.lastError = (e as Error).name === 'TimeoutError' ? 'не відповів за 90 с' : (e as Error).message.slice(0, 120); return { why: s.lastError };
    }
    aiStats.calls++; aiStats.lastAt = new Date().toISOString(); count(p.id === 'gemini' || p.id === 'gemini-lite' ? model : p.id);
    if (res.ok) {
      const txt = answerText(await res.json());
      const why = check(txt);
      if (why) { s.failed++; s.lastError = why; return { why }; }
      s.ok++; aiStats.model = `${p.label}`;
      const raw = JSON.parse(txt) as unknown;
      return { tip: raw as AiTip, raw };
    }
    const raw = await res.text();
    let msg = raw;
    try { const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }; msg = (typeof j.error === 'string' ? j.error : j.error?.message) || j.message || raw; } catch { /* not JSON */ }
    s.failed++; s.lastError = `${res.status}: ${msg.replace(/\s+/g, ' ').slice(0, 140)}`;
    // Cloudflare's free allocation used up for the day (it resets at 00:00 UTC)
    if (/neurons|free allocation/i.test(msg)) { const d = new Date(); d.setUTCHours(24, 0, 0, 0); s.restUntil = d.getTime(); return { why: `${s.lastError} — денний безкоштовний ліміт` }; }
    if (res.status === 429) { s.restUntil = /day|daily|per.?day|quota/i.test(msg) ? nextPacificMidnight() : Date.now() + 10 * 60_000; return { why: s.lastError }; }
    if (res.status === 401 || res.status === 403) { s.restUntil = Date.now() + 6 * 3_600_000; return { why: s.lastError }; }
    if (res.status === 402) { s.restUntil = nextPacificMidnight(); return { why: `${s.lastError} — потрібна платна підписка` }; } // not free on this account
    if (res.status === 404) { s.restUntil = Date.now() + 3 * 3_600_000; return { why: `${s.lastError} — модель недоступна` }; }
    if (![500, 502, 503, 504].includes(res.status)) return { why: s.lastError };
  }
  s.restUntil = Date.now() + 5 * 60_000; // overloaded twice: let it rest
  return { why: s.lastError || 'перевантажений' };
}

/** Two readings of a slip with money on it disagree: market, map, pick or odds. */
export function disagree(a: AiTip, b: AiTip): boolean {
  if (a.isTip !== b.isTip) return true;
  if (!a.isTip) return false;
  const n = (x?: string | null) => (x || '').toLowerCase().replace(/[^a-z0-9а-яіїєґё]/g, '');
  const pickSame = !a.pick || !b.pick || n(a.pick).includes(n(b.pick)) || n(b.pick).includes(n(a.pick));
  return a.market !== b.market || (a.map ?? null) !== (b.map ?? null) || !pickSame || (a.odds != null && b.odds != null && Math.abs(a.odds - b.odds) > 0.02);
}

/** How often the admin corrected each reader (last 30 days) — set by tgSources; a reader that is clearly more accurate goes first. */
export const readerAccuracy: Record<string, { read: number; wrong: number }> = {};
const acc = (id: string) => { const a = readerAccuracy[id]; return a && a.read >= 30 ? 1 - a.wrong / a.read : null; };
/** The readers in the order to ask: as listed, but one with ≥ 30 reads and ≥ 5 points more accurate than the one before it swaps ahead. */
export function readerOrder(): Provider[] {
  const list = [...PROVIDERS];
  for (let i = 1; i < list.length; i++) for (let j = i; j > 0; j--) {
    const a = acc(list[j].id), b = acc(list[j - 1].id);
    if (a != null && b != null && a - b >= 0.05) [list[j - 1], list[j]] = [list[j], list[j - 1]]; else break;
  }
  return list;
}

/** Screenshots of a post: downloaded, small ones scaled up and sharpened (t.me/s gives ≈380 px), and one hash of the originals (the same slip posted again is not read twice). */
export async function loadImages(photos: string[]): Promise<{ imgs: Img[]; hash: string | null }> {
  const imgs: Img[] = [], h = createHash('sha1');
  let any = false;
  for (const url of photos.slice(0, 4)) { // an album: up to 4 screenshots
    let buf: Buffer | null = null, mime = 'image/jpeg';
    if (url.startsWith('tgacc://')) buf = await accountMedia(url); // a private channel: through our Telegram account
    else {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (r?.ok) { buf = Buffer.from(await r.arrayBuffer()); mime = r.headers.get('content-type') || mime; }
    }
    if (!buf?.length || buf.length > 4 * 1024 * 1024) continue;
    h.update(buf); any = true;
    imgs.push(await sharpen(buf, mime));
  }
  return { imgs, hash: any ? h.digest('hex') : null };
}
async function sharpen(buf: Buffer, mime: string): Promise<Img> {
  try {
    const sharp = (await import('sharp')).default;
    const w = (await sharp(buf).metadata()).width || 0;
    if (!w || w >= 700) return { mime, b64: buf.toString('base64') };
    const out = await sharp(buf).resize({ width: Math.min(1400, w * 2), kernel: 'lanczos3' }).normalise().sharpen({ sigma: 0.8 }).jpeg({ quality: 90 }).toBuffer();
    return { mime: 'image/jpeg', b64: out.toString('base64') };
  } catch { return { mime, b64: buf.toString('base64') }; }
}

const buildPrompt = (caption: string, hint: string, examples: string) =>
  `${PROMPT}${hint ? `\n\nAbout this channel: ${hint}` : ''}${examples ? `\n\n${examples}` : ''}\n\n${FIELDS}\n\nCaption:\n${caption || '(no caption)'}`;
async function pace(): Promise<void> {
  const wait = nextAt - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  nextAt = Date.now() + 6_000;
  await loadUsage();
}
export type AiRead = AiTip & { by?: string; byId?: string; doubt?: string };

/** The post read by the first reader that answers well; a slip with money is read by a second one too — they must agree.
 *  `imgs` — screenshots already loaded (loadImages); `examples` — earlier posts of the channel the admin corrected. */
export async function aiReadPost(caption: string, photos: string[], hint = '', opts: { imgs?: Img[]; examples?: string } = {}): Promise<AiRead | null> {
  if (!PROVIDERS.some((p) => p.key())) return null;
  if (!readerReady()) { aiStats.lastError = 'усі читачі на ліміті — пост прочитає OCR, а ШІ перечитає пізніше'; return null; } // no 6 s wait for nothing
  await pace();
  try {
    const prompt = buildPrompt(caption, hint, opts.examples || '');
    const imgs = opts.imgs ?? (await loadImages(photos)).imgs;
    let first: { tip: AiTip; p: Provider } | null = null;
    const whys: string[] = [];
    for (const p of readerOrder()) {
      const r = await ask(p, prompt, imgs);
      if (!r.tip) { if (r.why !== 'немає ключа') whys.push(`${p.label}: ${r.why}`); continue; }
      if (!first) {
        first = { tip: r.tip, p };
        // a slip with money on it: one more reader must read the same
        if (!(r.tip.isTip && r.tip.stake)) break;
        continue;
      }
      if (disagree(first.tip, r.tip)) {
        const show = (t: AiTip) => t.isTip ? `${t.market}${t.map ? ` ${t.map}` : ''} · ${t.pick || '—'} @${t.odds ?? '—'}` : 'не прогноз';
        return { ...first.tip, by: first.p.label, byId: first.p.id, doubt: `${first.p.label}: ${show(first.tip)} | ${p.label}: ${show(r.tip)}` };
      }
      return { ...first.tip, by: `${first.p.label} + ${p.label}`, byId: first.p.id };
    }
    if (first) return { ...first.tip, by: first.p.label, byId: first.p.id };
    throw new Error(whys.join(' · ') || 'жоден читач не відповів');
  } catch (e) {
    aiStats.failed++; aiStats.lastError = (e as Error).message.slice(0, 300);
    console.warn('[tg] ai:', aiStats.lastError);
    return null;
  }
}

/** Several text-only posts in one request (up to 5): an answer per post, in order — or null, then each is read on its own. */
export async function aiReadBatch(captions: string[], hint = '', examples = ''): Promise<AiRead[] | null> {
  if (!PROVIDERS.some((p) => p.key()) || captions.length < 2) return null;
  await pace();
  const prompt = `${PROMPT}${hint ? `\n\nAbout this channel: ${hint}` : ''}${examples ? `\n\n${examples}` : ''}

You get ${captions.length} separate posts (text only, no screenshots). Read each on its own and answer with ONE JSON object {"posts": [...]} — exactly ${captions.length} items, in the same order, each item as described:
${FIELDS.replace('Answer with ONE JSON object: ', '')}

${captions.map((c, i) => `Post ${i + 1}:\n${c.slice(0, 1500)}`).join('\n\n')}`;
  const schema = { type: 'OBJECT', properties: { posts: { type: 'ARRAY', items: SCHEMA } }, required: ['posts'] };
  const check = (txt: string) => {
    let j: { posts?: unknown[] };
    try { j = JSON.parse(txt) as { posts?: unknown[] }; } catch { return 'відповідь не JSON'; }
    if (!Array.isArray(j.posts) || j.posts.length !== captions.length) return 'не та кількість відповідей';
    for (const x of j.posts) { const w = answerProblem({ candidates: [{ content: { parts: [{ text: JSON.stringify(x) }] } }] }); if (w) return w; }
    return '';
  };
  for (const p of readerOrder()) {
    const r = await ask(p, prompt, [], schema, check);
    if (r.raw) { batchStats.requests++; batchStats.posts += captions.length; return ((r.raw as { posts: AiTip[] }).posts).map((t) => ({ ...t, by: `${p.label} · пакетом`, byId: p.id })); }
  }
  return null;
}
export const batchStats = { requests: 0, posts: 0 };

/** One reader on one post, for the reference check: its answer or why not. */
export async function askOne(id: string, caption: string, imgs: Img[]): Promise<{ tip?: AiTip; why?: string }> {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) return { why: 'немає такого читача' };
  await pace();
  const r = await ask(p, buildPrompt(caption, '', ''), imgs);
  return { tip: r.tip, why: r.why };
}

/** Some reader with a key is not resting now (a post read by OCR can be read again by the AI). */
export const readerReady = () => PROVIDERS.some((p) => p.key() && st(p.id).restUntil <= Date.now());

/** Every reader for the admin: key present, today's requests, resting until, last error. */
export function readersInfo() {
  const by = aiQuota().byModel;
  return PROVIDERS.map((p) => {
    const s = st(p.id), today = p.id === 'gemini' || p.id === 'gemini-lite' ? by[p.model()] || 0 : by[p.id] || 0;
    const a = readerAccuracy[p.id];
    return { id: p.id, label: p.label, model: p.model(), hasKey: !!p.key(), keyName: p.keyName, today, ok: s.ok, failed: s.failed,
      read30: a?.read ?? 0, wrong30: a?.wrong ?? 0, accuracy: a && a.read ? Math.round((1 - a.wrong / a.read) * 100) : null,
      restUntil: s.restUntil > Date.now() ? new Date(s.restUntil).toISOString() : null, lastError: s.lastError };
  });
}

/** What is wrong with an answer, or '' when it can be used. */
export function answerProblem(r: Resp): string {
  const txt = r.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let a: AiTip;
  try { a = JSON.parse(txt) as AiTip; } catch { return 'відповідь не JSON'; }
  const bad = (x?: string | null) => !!x && (x.length > 40 || /[{}"]|error|json|schema|fallback|pipeline/i.test(x));
  if (bad(a.team1) || bad(a.team2) || bad(a.pick)) return 'зіпсована назва команди у відповіді';
  if (a.isTip && !a.market) return 'прогноз без ринку';
  if (a.isTip && a.market !== 'express' && a.market !== 'total_maps' && a.market !== 'map_total' && !a.pick) return 'прогноз без вибору';
  // a decimal odd is 1.01…50: «152» or «0.52» is a misread «1.52» — the next reader reads it again
  if (a.isTip && a.odds != null && (a.odds < 1.01 || a.odds > 50)) return 'неправдоподібний коефіцієнт';
  return '';
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
  // the team only: «Chinggis Warriors (+1.5)», «MOUZ -1.5» → the name; digits inside a name stay («M80», «G2», «9z»)
  const pick = (a.pick || '').replace(/\([^)]*\)/g, '').replace(/(^|\s)[+\-−]?\d+[.,]\d+(?=\s|$)/g, ' ').replace(/(^|\s)[+\-−]\d+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim() || null;
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
