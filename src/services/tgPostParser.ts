/**
 * «Telegram-джерела»: a channel post → a tip (match, market, pick, odds) or «not a tip» / «not recognized».
 * Matches come from our own feed, so a post is a tip only when both teams of a real match are in it.
 * Markets the series score decides: Match Winner, Total Maps Over/Under N.5, Handicap ±N.5 (as in bet hints).
 */
import { normalizeTeam } from '../utils/matchUtils';

export interface TgCandidate { id: string; game: 'cs2' | 'dota2'; team1: string; team2: string; start: string; aliases1?: string[]; aliases2?: string[] }
export interface TgRules { oddsOnly?: 'p1' | 'p2' }
export type TgParsed =
  | { kind: 'other' }
  | { kind: 'unknown'; reason: string; match?: TgCandidate; odds?: number | null }
  | { kind: 'bet'; match: TgCandidate; market: string; pick: string; odds: number | null };

// JS \b knows only latin letters: Cyrillic words get explicit letter look-arounds
const L = 'a-zа-яіїєґё0-9';
const re = (src: string) => new RegExp(src.replace(/<B/g, `(?<![${L}])`).replace(/B>/g, `(?![${L}])`), 'iu');
const ODDS = re(String.raw`(?:@|<Bкф\.?|<Bкоэф\.?|<Bкоеф\.?|<Bкэф|<Bкоэффициент|<Bкоефіцієнт|<Bodds|<Bk\.?)\s*:?\s*(\d{1,2}[.,]\d{1,3})`);
const BARE_ODDS = /(?:^|\s)([1-9][.,]\d{1,2})(?=\s|$|[^\d])/;
const EXPRESS = re(String.raw`экспресс|експрес|<BexpressB>|<BparlayB>`);
const INDIVIDUAL = re(String.raw`<B[иі]т[бм]|індивідуальн|индивидуальн`);
const TOTAL = re(String.raw`(?:<B(тб|тм|tb|tm)B>|<Bтотал\s*(больше|більше|меньше|менше|over|under)|<B(over|under)B>)\s*\(?\s*(\d+[.,]5)`);
const HCP = re(String.raw`(?:<Bф(?:ора)?|<Bhandicap|<Bhcp)\s*(?:([12])|([^\d+\-−–@\n]{0,30}?))\s*\(?\s*([+\-−–]\s?\d+[.,]5)`);
const P12 = re(String.raw`<B(п|w|p)\s?([12])(?![${L}]|[.,]\d)`);
const WIN = re(String.raw`перемо[гж]|побед|<BwinB>|виграє|выиграет|забира|візьм|возьм|ставка на|ставлю на|<BберуB>`);

/** Lowercase, emoji and punctuation out, spaces kept — for whole-word team lookups. */
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9а-яіїєґё+\-.,@]+/gi, ' ').replace(/\s+/g, ' ').trim()} `;

/** Where a team name appears in the text (word positions), [] if not. Short names (≤3) must be whole words. */
function teamAt(text: string, names: string[]): number[] {
  const w = words(text), compact = normalizeTeam(text), out: number[] = [];
  for (const n of names) {
    const nw = words(n).trim(), k = normalizeTeam(n);
    if (!nw) continue;
    const needle = nw.length <= 3 || k.length <= 3 ? ` ${nw} ` : nw;
    for (let i = w.indexOf(needle); i >= 0; i = w.indexOf(needle, i + 1)) out.push(i);
    if (!out.length && k.length >= 4 && compact.includes(k)) out.push(10_000 + compact.indexOf(k)); // «NatusVincere» written together
  }
  return out.sort((x, y) => x - y);
}
const num = (s: string) => Number(s.replace(',', '.').replace(/[−–]/, '-').replace(/\s/g, ''));

export function parseTgPost(text: string, postedAt: string, cands: TgCandidate[], rules: TgRules = {}): TgParsed {
  const t = text.replace(/\u00a0/g, ' ');
  const oddsM = ODDS.exec(t) || null;
  let odds = oddsM ? num(oddsM[1]) : null;
  const marketWords = TOTAL.test(t) || HCP.test(t) || P12.test(t) || WIN.test(t) || EXPRESS.test(t);
  if (odds == null && marketWords) { const b = BARE_ODDS.exec(t); if (b) odds = num(b[1]); }
  if (odds != null && (odds < 1.01 || odds > 50)) odds = null;
  const betLike = odds != null || marketWords;

  // the match: both teams of a feed match in the post, the start no earlier than a day before the post
  const at = Date.parse(postedAt);
  let match: TgCandidate | undefined, p1: number[] = [], p2: number[] = [], half: TgCandidate | undefined;
  for (const c of cands) {
    const st = Date.parse(c.start);
    if (Number.isFinite(st) && Number.isFinite(at) && (st < at - 6 * 3600_000 || st > at + 4 * 86_400_000)) continue;
    const i1 = teamAt(t, [c.team1, ...(c.aliases1 || [])]), i2 = teamAt(t, [c.team2, ...(c.aliases2 || [])]);
    if (i1.length && i2.length) { if (!match || Math.abs(st - at) < Math.abs(Date.parse(match.start) - at)) { match = c; p1 = i1; p2 = i2; } }
    else if ((i1.length || i2.length) && !half) half = c;
  }
  if (!betLike) return { kind: 'other' };
  if (EXPRESS.test(t)) return { kind: 'unknown', reason: 'Експреси поки не рахуємо', match, odds };
  if (INDIVIDUAL.test(t)) return { kind: 'unknown', reason: 'Індивідуальні тотали поки не рахуємо', match, odds };
  if (!match) return { kind: 'unknown', reason: half ? 'Матч не знайдено — немає суперника' : 'Матч не знайдено', match: half, odds };

  const tot = TOTAL.exec(t);
  if (tot) {
    const w = (tot[1] || tot[2] || tot[3] || '').toLowerCase();
    const over = /тб|tb|больше|більше|over/.test(w);
    return { kind: 'bet', match, market: `Total Maps ${over ? 'Over' : 'Under'} ${num(tot[4])}`, pick: '', odds };
  }
  const hcp = HCP.exec(t);
  if (hcp) {
    const line = num(hcp[3]);
    let side = hcp[1] ? Number(hcp[1]) : 0;
    if (!side && hcp[2]?.trim()) { // «Фора MOUZ −1.5»: the team between the word and the line
      const g = hcp[2];
      side = teamAt(g, [match.team1, ...(match.aliases1 || [])]).length ? 1 : teamAt(g, [match.team2, ...(match.aliases2 || [])]).length ? 2 : 0;
    }
    if (!side) { // the team written next to the handicap
      const pos = words(t).indexOf(words(hcp[0]).trim());
      const near = (ps: number[]) => Math.min(...ps.map((x) => Math.abs(pos - x)));
      const d1 = near(p1), d2 = near(p2);
      side = pos >= 0 && d1 !== d2 ? (d1 < d2 ? 1 : 2) : 0;
    }
    if (!side) return { kind: 'unknown', reason: 'Фора без команди', match, odds };
    return { kind: 'bet', match, market: `Handicap ${line > 0 ? '+' : ''}${line}`, pick: side === 1 ? match.team1 : match.team2, odds };
  }
  const p = P12.exec(t);
  if (p) { const side = Number(p[2]); return { kind: 'bet', match, market: 'Match Winner', pick: side === 1 ? match.team1 : match.team2, odds }; }
  if (WIN.test(t)) {
    // the team named right after «перемога / ставка на …»
    const k = words(t).search(WIN);
    const after = (ps: number[]) => Math.min(...ps.map((x) => (x >= k ? x - k : 1e6 + k - x)));
    const side = after(p1) <= after(p2) ? 1 : 2;
    return { kind: 'bet', match, market: 'Match Winner', pick: side === 1 ? match.team1 : match.team2, odds };
  }
  if (odds != null && rules.oddsOnly) return { kind: 'bet', match, market: 'Match Winner', pick: rules.oddsOnly === 'p1' ? match.team1 : match.team2, odds };
  return { kind: 'unknown', reason: 'Не вказано, на кого ставка', match, odds };
}

/** Text of a t.me/s/<handle> page: channel info and its last ~20 posts (newest last). */
export interface TgPage { title: string | null; subscribers: number | null; posts: { id: number; at: string; text: string }[]; isPublic: boolean }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
export function htmlText(h: string): string {
  return h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
    ENT[e] ?? (e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1), 10)) : m)).replace(/[ \t]+\n/g, '\n').trim();
}
export function parseTgPage(html: string): TgPage {
  const title = (/class="tgme_channel_info_header_title"[^>]*>(?:<span[^>]*>)?([\s\S]*?)<\/(?:span|div)>/.exec(html) || [])[1];
  let subscribers: number | null = null;
  const sm = /<span class="counter_value">([\d.,\s]+)([KkMm]?)<\/span>\s*<span class="counter_type">subscribers?<\/span>/.exec(html);
  if (sm) { const n = Number(sm[1].replace(/[\s,]/g, '')); subscribers = Math.round(n * (/k/i.test(sm[2]) ? 1000 : /m/i.test(sm[2]) ? 1e6 : 1)); }
  const posts: TgPage['posts'] = [];
  const re = /data-post="[^"/]+\/(\d+)"[\s\S]*?(?=data-post="|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const block = m[0];
    const tm = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const dt = /<time[^>]+datetime="([^"]+)"/.exec(block);
    if (!dt) continue;
    posts.push({ id: Number(m[1]), at: new Date(dt[1]).toISOString(), text: tm ? htmlText(tm[1]) : '' });
  }
  return { title: title ? htmlText(title) : null, subscribers, posts, isPublic: /tgme_channel_info|tgme_widget_message/.test(html) };
}
