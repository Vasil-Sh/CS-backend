/**
 * «Telegram-джерела»: a channel post → a tip (match, market, pick, odds) or «not a tip» / «not recognized».
 * Matches come from our own feed, so a post is a tip only when both teams of a real match are in it.
 * Markets the series score decides: Match Winner, Total Maps Over/Under N.5, Handicap ±N.5 (as in bet hints).
 */
import { normalizeTeam } from '../utils/matchUtils';

export interface TgCandidate { id: string; game: 'cs2' | 'dota2'; team1: string; team2: string; start: string; aliases1?: string[]; aliases2?: string[] }
export interface TgRules { oddsOnly?: 'p1' | 'p2' }
export type TgParsed =
  | { kind: 'other'; reason?: string; repeatOf?: number }
  | { kind: 'unknown'; reason: string; match?: TgCandidate; odds?: number | null }
  | { kind: 'bet'; match: TgCandidate; market: string; pick: string; odds: number | null };

// JS \b knows only latin letters: Cyrillic words get explicit letter look-arounds
const L = 'a-zа-яіїєґё0-9';
const re = (src: string) => new RegExp(src.replace(/<B/g, `(?<![${L}])`).replace(/B>/g, `(?![${L}])`), 'iu');
const ODDS = re(String.raw`(?:@|<Bкф\.?|<Bкоэф\.?|<Bкоеф\.?|<Bкэф|<Bкоэффициент|<Bкоефіцієнт|<Bodds|<Bk\.?)\s*:?\s*(\d{1,2}[.,]\d{1,3})`);
const BARE_ODDS = /(?:^|\s)([1-9][.,]\d{1,3})(?=\s|$|[^\d])/;
const EXPRESS = re(String.raw`экспресс|експрес|<BexpressB>|<BparlayB>`);
const INDIVIDUAL = re(String.raw`<B[иі]т[бм]|індивідуальн|индивидуальн`);
const TOTAL = re(String.raw`(?:<B(тб|тм|tb|tm)B>|<Bтотал\s*(больше|більше|меньше|менше|over|under)|<B(over|under)B>)\s*\(?\s*(\d+[.,]5)`);
const HCP = re(String.raw`(?:<Bф(?:ора)?|<Bhandicap|<Bhcp)\s*(?:([12])|([^\d+\-−–@\n]{0,30}?))\s*\(?\s*([+\-−–]\s?\d+[.,]5)`);
const P12 = re(String.raw`<B(п|w|p)\s?([12])(?![${L}]|[.,]\d)`);
// «1 карта», «1-ая карта», «на 2карту», «Карта 2:», «карте #2», «map 2» — a bet on one map, not the series
const MAP = re(String.raw`(?:перш|перв|друг|втор|трет|четв|п.?ят)\S*\s+карт|(?<![\d.,])[1-5]\s*-?(?:[ая]{1,2}|ша|га|тя|я|й)?\s*карт(?:а|у|е|і)(?![${L}])|<Bкарт(?:а|е|і|ы)\s*(?:#|№)?\s*[1-5](?![\d.,])|<Bmap\s*(?:#|№)?\s*[1-5](?![\d.,])`);
// other sports in the same channels (football screenshots): not ours
const NOT_ESPORTS = re(String.raw`<Bуефа|<Bфутбол|<Bfootball|<Bsoccer|<Bnba|<Bnhl|<Bтайм|<Bполовин|<Bhalf\s?time|<Btotal in time period|<Bтеніс|<Bтеннис|<Bхокей|<Bхоккей|<Bбаскетбол|<B(фк|fc)B>`);
const WIN = re(String.raw`перемо[гж]|побед|<BwinB>|<Bwinner|виграє|выиграет|забира|візьм|возьм|ставка на|ставлю на|<BберуB>`);

/** Lowercase, emoji and punctuation out, spaces kept — for whole-word team lookups. */
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9а-яіїєґё+\-.,@]+/gi, ' ').replace(/\s+/g, ' ').trim()} `;

// OCR reads Latin capitals as Cyrillic look-alikes («ВВ Теат» for «BB Team»): a second look with them folded to Latin
const LOOK: Record<string, string> = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's' };
export const foldLatin = (s: string) => s.toLowerCase().replace(/[авекмнорстухіјѕ]/g, (c) => LOOK[c] || c);

/** Where a team name appears in the text (word positions), [] if not. Short names (≤3) must be whole words. */
function teamAt(text: string, names: string[]): number[] {
  return [...new Set([...teamAt1(text, names), ...teamAt1(foldLatin(text), names)])].sort((x, y) => x - y); // same length: positions line up
}
function teamAt1(text: string, names: string[]): number[] {
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
// a name token: letters/digits (Latin, or Cyrillic team names), not a score, odds or a word of the ticket
const NAME_TOKEN = /^[\p{L}\d][\p{L}\d.'&!_-]*$/u;
const STOP_TOKEN = /^(\d+[:.,]\d+|\d+|bo\d|матч\w*|ставк\w*|сума|сумма|коеф\w*|коэф\w*|id|карт\w*|map|переможець|победитель|winner|та|и|і|and)$/iu;
const EVENT_TOKEN = /^(res|blast|esl|pgl|iem|cct|epl|betboom|pinnacle|thunderpick|fissure|dreamleague|major|qualifier|qualifiers|cup|league|season|showdown|series|open|closed|playoffs|europe|asia|america|na|eu|sa|cis|online|lan|\d+)$/i;
function nameFrom(tokens: string[], fromEnd: boolean): string {
  const seq = fromEnd ? [...tokens].reverse() : tokens, out: string[] = [];
  for (const tk of seq) {
    if (!NAME_TOKEN.test(tk) || STOP_TOKEN.test(tk)) break;
    const latin = /[a-z]/i.test(out.join('')) || /[a-z]/i.test(tk), cyr = /[а-яіїєґё]/i.test(tk);
    if (out.length && latin && cyr) break; // «BB Team ВВ СУМА» → «BB Team»
    if (out.length && out[out.length - 1].toLowerCase() === tk.toLowerCase()) continue; // «OG OG vs …»
    out.push(tk);
    if (out.length === 3) break;
  }
  return (fromEnd ? out.reverse() : out).join(' ');
}
/** «A vs B» in the text or an hltv.org match link — the teams of a match we may not have in our feed. */
export function teamsFromText(t: string): [string, string] | null {
  // OCR glues «OG vs BB Team» into «OGvsBBTeam»
  const unglued = t.replace(/([A-Za-z0-9])vs([A-Z][A-Za-z0-9]*)/g, (_m, a: string, b: string) => `${a} vs ${b.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')}`);
  for (const line of unglued.split('\n')) {
    const m = /(.*?)\s+(?:vs\.?|v\.?|против|проти)\s+(.*)/i.exec(line);
    if (!m) continue;
    const a = nameFrom(m[1].split(/\s+/).filter(Boolean), true), b = nameFrom(m[2].split(/\s+/).filter(Boolean), false);
    if (a && b && a.toLowerCase() !== b.toLowerCase()) return [a, b];
  }
  const h = /hltv\.org\/matches\/\d+\/([a-z0-9-]+?)-vs-([a-z0-9-]+)/i.exec(t);
  if (h) {
    const b: string[] = [];
    for (const tk of h[2].split('-')) { if (EVENT_TOKEN.test(tk) || b.length === 3) break; b.push(tk); }
    const title = (x: string) => x.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    if (b.length) return [title(h[1].replace(/-/g, ' ')), title(b.join(' '))];
  }
  return null;
}
const slug = (s: string) => foldLatin(s).replace(/[^a-z0-9а-яіїєґё]+/g, '-').replace(/^-|-$/g, '');

const num = (s: string) => Number(s.replace(',', '.').replace(/[−–]/, '-').replace(/\s/g, ''));

export function parseTgPost(text: string, postedAt: string, cands: TgCandidate[], rules: TgRules = {}): TgParsed {
  const t = text.replace(/\u00a0/g, ' ');
  const oddsM = ODDS.exec(t) || null;
  let odds = oddsM ? num(oddsM[1]) : null;
  const marketWords = TOTAL.test(t) || HCP.test(t) || P12.test(t) || WIN.test(t) || EXPRESS.test(t) || MAP.test(t);
  if (odds == null && marketWords) { const b = BARE_ODDS.exec(t); if (b) odds = num(b[1]); }
  if (odds != null && (odds < 1.01 || odds > 50)) odds = null;
  const betLike = odds != null || marketWords;

  // the match: both teams of a feed match in the post, the start no earlier than a day before the post
  const at = Date.parse(postedAt);
  let match: TgCandidate | undefined, p1: number[] = [], p2: number[] = [];
  const halves: { c: TgCandidate; side: 1 | 2; pos: number[] }[] = [];
  for (const c of cands) {
    const st = Date.parse(c.start);
    if (Number.isFinite(st) && Number.isFinite(at) && (st < at - 6 * 3600_000 || st > at + 4 * 86_400_000)) continue;
    const i1 = teamAt(t, [c.team1, ...(c.aliases1 || [])]), i2 = teamAt(t, [c.team2, ...(c.aliases2 || [])]);
    if (i1.length && i2.length) { if (!match || Math.abs(st - at) < Math.abs(Date.parse(match.start) - at)) { match = c; p1 = i1; p2 = i2; } }
    else if (i1.length || i2.length) halves.push({ c, side: i1.length ? 1 : 2, pos: i1.length ? i1 : i2 });
  }
  // one team only (a screenshot of a single pick): its match around the time of the post, if there is exactly one
  if (!match && halves.length) {
    const near = halves.filter((h) => { const st = Date.parse(h.c.start); return !Number.isFinite(st) || !Number.isFinite(at) || (st >= at - 5 * 3600_000 && st <= at + 18 * 3600_000); });
    const ids = new Set(near.map((h) => h.c.id));
    if (ids.size === 1) { const h = near[0]; match = h.c; if (h.side === 1) p1 = h.pos; else p2 = h.pos; }
  }
  const half = halves[0]?.c;
  if (!betLike) return { kind: 'other' };
  if (!match && NOT_ESPORTS.test(t)) return { kind: 'other' };
  // not in our feed (an older match, a smaller league): the teams written in the post — settled later by names and date
  if (!match) {
    const tp = teamsFromText(t);
    if (tp) {
      const game = /dota|дот/i.test(t) ? 'dota2' : 'cs2';
      const c: TgCandidate = { id: `tg:${(postedAt || '').slice(0, 10)}:${slug(tp[0])}:${slug(tp[1])}`, game, team1: tp[0], team2: tp[1], start: postedAt };
      const i1 = teamAt(t, [c.team1]), i2 = teamAt(t, [c.team2]);
      match = c; p1 = i1; p2 = i2;
    }
  }
  if (EXPRESS.test(t)) return { kind: 'unknown', reason: 'Експреси поки не рахуємо', match, odds };
  if (INDIVIDUAL.test(t)) return { kind: 'unknown', reason: 'Індивідуальні тотали поки не рахуємо', match, odds };
  const tot0 = TOTAL.test(t);
  if (!tot0 && MAP.test(t)) {
    // «Карта 2 — переможець NiP»: a tip on one map (settled by the slip's result or the map scores)
    if (!match) return { kind: 'unknown', reason: half ? 'Матч не знайдено — немає суперника' : 'Матч не знайдено', match: half, odds };
    const mn = /(?<![\d.,])([1-5])\s*-?(?:[ая]{1,2}|ша|га|тя|я|й)?\s*карт|карт(?:а|е|і|ы)\s*(?:#|№)?\s*([1-5])|map\s*(?:#|№)?\s*([1-5])/i.exec(t);
    const ORD: [RegExp, number][] = [[/(перш|перв)\S*\s+карт/i, 1], [/(друг|втор)\S*\s+карт/i, 2], [/трет\S*\s+карт/i, 3], [/четв\S*\s+карт/i, 4], [/п.?ят\S*\s+карт/i, 5]];
    const n = mn ? Number(mn[1] || mn[2] || mn[3]) : (ORD.find(([r]) => r.test(t))?.[1] ?? 0);
    const k = words(t).search(MAP);
    const after = (ps: number[]) => Math.min(...ps.map((x) => (x >= k ? x - k : 1e6 + k - x)));
    const side = p1.length || p2.length ? (after(p1) <= after(p2) ? 1 : 2) : 0;
    if (!n || !side) return { kind: 'unknown', reason: !n ? 'Не вказано, яка карта' : 'Не вказано, на кого ставка', match, odds };
    return { kind: 'bet', match, market: `Map ${n} Winner`, pick: side === 1 ? match.team1 : match.team2, odds };
  }
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
export interface TgPage { title: string | null; subscribers: number | null; posts: { id: number; at: string; text: string; photos: string[] }[]; isPublic: boolean }
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
    const tm = /<div class="tgme_widget_message_text[^"]*\bjs-message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block); // not the quote of a reply (js-message_reply_text)
    const dt = /<time[^>]+datetime="([^"]+)"/.exec(block);
    if (!dt) continue;
    // photos (single or an album): <a class="tgme_widget_message_photo_wrap …" style="…background-image:url('…')">
    const photos: string[] = [];
    for (const ph of block.matchAll(/class="tgme_widget_message_photo_wrap[^"]*"[^>]*?style="[^"]*background-image:url\('([^']+)'\)/g)) if (!photos.includes(ph[1])) photos.push(ph[1]);
    posts.push({ id: Number(m[1]), at: new Date(dt[1]).toISOString(), text: tm ? htmlText(tm[1]) : '', photos: photos.slice(0, 4) });
  }
  return { title: title ? htmlText(title) : null, subscribers, posts, isPublic: /tgme_channel_info|tgme_widget_message/.test(html) };
}
