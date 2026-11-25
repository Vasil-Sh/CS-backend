/**
 * Reading a channel post with an AI model that sees the screenshot (Google Gemini, free tier): is it a tip, which match,
 * which market, which side, the odds. Turned on by GEMINI_API_KEY (the admin adds it in Railway); without it — OCR + rules.
 * The answer is written back as a plain tip line («A vs B / Перемога X @1.72») and goes through the same parser,
 * so matching to our feed, synthetic matches and settlement stay in one place.
 */
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
export const aiEnabled = () => !!process.env.GEMINI_API_KEY;
export const aiStats = { calls: 0, failed: 0, lastError: null as string | null, lastAt: null as string | null, model: '' };
let nextAt = 0; // free tier: ~10–15 requests a minute — one call per 6 s

export interface AiTip {
  isTip: boolean; game?: 'cs2' | 'dota2' | 'other' | null; team1?: string | null; team2?: string | null;
  market?: 'match_winner' | 'map_winner' | 'total_maps' | 'handicap' | 'express' | 'other' | null;
  map?: number | null; pick?: string | null; line?: number | null; over?: boolean | null; odds?: number | null;
}

const PROMPT = `You read posts of a Telegram channel about esports betting (CS2, Dota 2). A post has a caption and maybe a screenshot of a bet slip or of an app.
Decide if the post itself gives a betting tip / a placed bet (a "tip"). News, app updates, chat, results talk, screenshots of an app UI or of a list of matches are NOT tips.
For a tip, read: game, the two teams exactly as written, the market, the side picked, the line and the decimal odds.
Markets: match_winner (the series winner), map_winner (winner of map N — set "map"), total_maps (over/under N.5 maps — set "line" and "over"), handicap (map handicap — set "pick" and "line" like -1.5), express (several matches in one bet), other.
Football, basketball and other non-esports bets: isTip=false. Answer JSON only.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isTip: { type: 'BOOLEAN' }, game: { type: 'STRING', nullable: true, enum: ['cs2', 'dota2', 'other'] },
    team1: { type: 'STRING', nullable: true }, team2: { type: 'STRING', nullable: true },
    market: { type: 'STRING', nullable: true, enum: ['match_winner', 'map_winner', 'total_maps', 'handicap', 'express', 'other'] },
    map: { type: 'INTEGER', nullable: true }, pick: { type: 'STRING', nullable: true }, line: { type: 'NUMBER', nullable: true },
    over: { type: 'BOOLEAN', nullable: true }, odds: { type: 'NUMBER', nullable: true },
  },
  required: ['isTip'],
};

/** The post read by the model, or null (no key, quota, network) — then OCR + rules take over. */
export async function aiReadPost(caption: string, photos: string[]): Promise<AiTip | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const wait = nextAt - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  nextAt = Date.now() + 6_000;
  try {
    const parts: unknown[] = [{ text: `${PROMPT}\n\nCaption:\n${caption || '(no caption)'}` }];
    for (const url of photos.slice(0, 2)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) continue;
      parts.push({ inline_data: { mime_type: r.headers.get('content-type') || 'image/jpeg', data: buf.toString('base64') } });
    }
    aiStats.model = MODEL();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(40_000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA } }),
    });
    aiStats.calls++; aiStats.lastAt = new Date().toISOString();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const txt = body.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return JSON.parse(txt) as AiTip;
  } catch (e) {
    aiStats.failed++; aiStats.lastError = (e as Error).message.slice(0, 200);
    console.warn('[tg] ai:', aiStats.lastError);
    return null;
  }
}

const n2 = (x: number) => String(x).replace(',', '.');
/** The model's answer as a tip line for the parser; '' for «not a tip». */
export function aiLine(a: AiTip): string {
  if (!a.isTip || a.game === 'other') return '';
  const head = a.team1 && a.team2 ? `${a.team1} vs ${a.team2}` : a.team1 || a.team2 || '';
  const kf = a.odds ? ` @${n2(a.odds)}` : '';
  const game = a.game === 'dota2' ? 'Dota 2' : a.game === 'cs2' ? 'CS2' : '';
  let bet = '';
  if (a.market === 'express') bet = 'Експрес';
  else if (a.market === 'map_winner') bet = `Карта ${a.map || 1} переможець ${a.pick || ''}`;
  else if (a.market === 'total_maps' && a.line) bet = `${a.over === false ? 'ТМ' : 'ТБ'} ${n2(a.line)}`;
  else if (a.market === 'handicap' && a.line != null) bet = `Фора ${a.pick || ''} ${a.line > 0 ? '+' : ''}${n2(a.line)}`;
  else if (a.pick) bet = `Перемога ${a.pick}`;
  return [game, head, `${bet}${kf}`].filter(Boolean).join('\n');
}
