// ═══════════════════════════════════════════
// Telegram groups that users add: text screening and link checks.
// Pure functions — used by the admin moderation list and on create/update.
// ═══════════════════════════════════════════

export interface Hit { from: number; to: number; phrase: string; reason: Reason }
export type Reason = 'fixed' | 'fraud' | 'spam';

/** Phrases that usually mean selling fixed matches, a scam or spam. Lower-case; matched as substrings. */
const RULES: { reason: Reason; re: RegExp }[] = [
  { reason: 'fixed', re: /договорн\S*|договірн\S* матч\S*|фікс(?:ован\S*)? матч\S*|fixed match\S*|злив\S* (?:з|із) першоджерел\S*|інсайд\S*|инсайд\S*/giu },
  { reason: 'fraud', re: /гарантован\S* (?:заліз|залет|прибут\S*|виграш\S*|дохід|результат\S*)|100\s?% (?:прохід|заліз|виграш)|без ризику|пиши в (?:лс|лічку|личку|особист\S*)(?: за ціною)?|за ціною в лс|оплат\S* після виграш\S*/giu },
  { reason: 'spam', re: /підпишись на канал|переходь за посиланням|бонус(?:и)? за реєстрац\S*|промокод на депозит/giu },
];
export const REASON_LABEL: Record<Reason, string> = { fixed: 'Договірні матчі', fraud: 'Шахрайство', spam: 'Спам' };

/** All suspicious phrases in a text with their positions (non-overlapping, in order). */
export function screenText(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { reason, re } of RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      hits.push({ from: m.index, to: m.index + m[0].length, phrase: m[0], reason });
    }
  }
  hits.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Hit[] = [];
  for (const h of hits) if (!out.length || h.from >= out[out.length - 1].to) out.push(h);
  return out;
}

/** Text split into plain and highlighted parts, ready for the admin to render. */
export function segments(text: string, hits = screenText(text)): { t: string; hl: boolean }[] {
  const out: { t: string; hl: boolean }[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.from > at) out.push({ t: text.slice(at, h.from), hl: false });
    out.push({ t: text.slice(h.from, h.to), hl: true });
    at = h.to;
  }
  if (at < text.length) out.push({ t: text.slice(at), hl: false });
  return out;
}

/** The most frequent reason among hits (fixed > fraud > spam on a tie). */
export function mainReason(hits: Hit[]): Reason | null {
  if (!hits.length) return null;
  const n: Record<Reason, number> = { fixed: 0, fraud: 0, spam: 0 };
  hits.forEach((h) => { n[h.reason]++; });
  return (['fixed', 'fraud', 'spam'] as Reason[]).reduce((a, b) => (n[b] > n[a] ? b : a));
}

export type LinkState = 'ok' | 'none' | 'bad' | 'private';
export const LINK_LABEL: Record<Exclude<LinkState, 'ok'>, string> = {
  none: 'немає посилання',
  bad: 'посилання не на Telegram',
  private: 'закрита група (запрошення)',
};

/** t.me/name, @name or https://t.me/name — ok; t.me/+… / joinchat — private invite; anything else — bad. */
export function linkState(link: string | null | undefined): LinkState {
  const s = (link || '').trim();
  if (!s) return 'none';
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)\S+$/i.test(s)) return 'private';
  if (/^@[A-Za-z0-9_]{4,64}$/.test(s)) return 'ok';
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?[A-Za-z0-9_]{4,64}\/?(?:\d+)?$/i.test(s)) return 'ok';
  return 'bad';
}

/** One key per Telegram group, so «t.me/x», «@x» and «https://t.me/x/» count as the same group. */
export function linkKey(link: string | null | undefined): string {
  return (link || '').trim().toLowerCase()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?/, '')
    .replace(/^@/, '').replace(/\/\d+$/, '').replace(/\/+$/, '');
}
