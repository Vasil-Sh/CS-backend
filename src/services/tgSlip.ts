/**
 * A bookmaker's slip read without the AI: OCR text of the screenshot → match, market, pick, odds (and the money — slipFromOcr).
 * Bookmakers print the bet in a fixed form: «Карта 2. Победитель, NiP 1.52», «Победитель матча: Spirit», «Фора, MOUZ -1.5»,
 * «Тотал карт больше 2.5», «Map 1 Winner — Vitality», «Handicap NAVI -1.5». Only a full, unambiguous reading is returned:
 * the match of our feed (both teams in the text), a market we settle, the pick one of its teams, the odds (printed, or payout ÷ stake).
 * Rounds / kills on a map, individual totals and expresses are left to the AI.
 */
import { normalizeTeam } from '../utils/matchUtils';
import { slipFromOcr } from './tgOcr';
import { parseTgPost, type TgCandidate, type TgParsed } from './tgPostParser';

const ODD = String.raw`(\d{1,2}[.,]\d{2})`;
const near = (a: string, b: string) => { const x = normalizeTeam(a), y = normalizeTeam(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))); };

/** The bet line of the slip as {map?, kind, rest (the words after the market), line?, over?, odds?}. */
function betLine(text: string): { map: number | null; kind: 'win' | 'hcp' | 'total'; rest: string; line?: number; over?: boolean; odds: number | null } | null {
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+/g, ' ').trim();
    const mp = /(?:^|\s)(?:карта|map)\s*#?([1-5])\b[.:,]?\s*/i.exec(l);
    const map = mp ? Number(mp[1]) : null;
    const tail = mp ? l.slice(mp.index + mp[0].length) : l;
    const odds = (() => { const m = new RegExp(`${ODD}\\s*$`).exec(tail); return m ? Number(m[1].replace(',', '.')) : null; })();
    const body = tail.replace(new RegExp(`\\s*${ODD}\\s*$`), '');
    let m: RegExpExecArray | null;
    if ((m = /^(?:победитель|переможець|победа|перемога|исход|winner|match winner)(?:\s+матча|\s+матчу)?(?![а-яіїєa-z])[\s,:—–-]*(.*)$/i.exec(body))) return { map, kind: 'win', rest: m[1], odds };
    if ((m = /^(?:фора|handicap)(?![а-яіїєa-z])[\s,:—–-]*(.*?)\s*\(?([+\-−–]?\s?\d+[.,]5)\)?$/i.exec(body))) return { map, kind: 'hcp', rest: m[1], line: Number(m[2].replace(/[−–]/, '-').replace(/\s/g, '').replace(',', '.')), odds };
    if ((m = /^(?:тотал(?:\s+карт)?|total(?:\s+maps)?)(?![а-яіїєa-z])[\s,:—–-]*(больше|меньше|більше|менше|over|under|бол\.?|мен\.?)\s*\(?(\d+[.,]5)\)?/i.exec(body))) return { map, kind: 'total', rest: '', over: /больш|більш|over|бол/i.test(m[1]), line: Number(m[2].replace(',', '.')), odds };
  }
  return null;
}

/** The slip's bet, if the OCR text gives all of it — else null (the AI reads it). */
export function slipBet(ocr: string, postedAt: string, cands: TgCandidate[]): Extract<TgParsed, { kind: 'bet' }> | null {
  // an express (several events on one slip) is left to the AI: it lists every leg
  if (/экспресс|експрес|express|parlay|multi ?bet|систем[аи]/i.test(ocr) || /(?:событи[яей]|поді[їя]|events?)\s*\(?\s*[2-9]/i.test(ocr)) return null;
  const b = betLine(ocr);
  if (!b) return null;
  // the match: both teams of a feed match in the text (the generic parser finds it)
  const p = parseTgPost(`${ocr}\nставка на`, postedAt, cands); // «ставка на» — so the parser looks for the match even when it does not know the market words
  const match = p.kind === 'bet' || p.kind === 'unknown' ? p.match : undefined;
  if (!match || match.id.startsWith('tg:')) return null; // only matches of our feed: their names are known exactly
  const money = slipFromOcr(ocr);
  const fromMoney = money?.payout && money.stake ? Math.round((money.payout / money.stake) * 100) / 100 : null;
  const odds = b.odds ?? fromMoney;
  if (odds == null || odds < 1.01 || odds > 50) return null;
  if (b.odds != null && fromMoney != null && Math.abs(b.odds - fromMoney) > 0.03) return null; // OCR misread one of them
  const side = (s: string) => {
    const one = [match.team1, ...(match.aliases1 || [])].some((n) => near(s, n)), two = [match.team2, ...(match.aliases2 || [])].some((n) => near(s, n));
    return one === two ? 0 : one ? 1 : 2;
  };
  if (b.kind === 'total') {
    if (b.map) return null; // rounds on a map
    return { kind: 'bet', match, market: `Total Maps ${b.over ? 'Over' : 'Under'} ${b.line}`, pick: '', odds };
  }
  const s = side(b.rest.replace(/^(?:п|w|p)\s?([12])$/i, (_x, d: string) => (d === '1' ? match.team1 : match.team2)));
  if (!s) return null;
  const pick = s === 1 ? match.team1 : match.team2;
  if (b.kind === 'win') return { kind: 'bet', match, market: b.map ? `Map ${b.map} Winner` : 'Match Winner', pick, odds };
  if (b.map || b.line == null || Math.abs(b.line) > 2.5) return null; // a rounds handicap on a map (4.5, 6.5 …)
  return { kind: 'bet', match, market: `Handicap ${b.line > 0 ? '+' : ''}${b.line}`, pick, odds };
}
