/**
 * «Telegram-джерела» learning from the admin: the posts the admin corrected become examples for the reader (per channel),
 * the team names the reader saw become aliases of the match teams, each reader's accuracy is counted (and orders the readers),
 * and a reference set (the corrected posts) checks every reader on demand.
 * Plus the cheap ways not to spend a request: plain rules for posts that are surely not tips, a channel's own text template.
 */
import { pool } from '../db/client';
import { normalizeTeam } from '../utils/matchUtils';
import { askOne, loadImages, PROVIDERS, readerAccuracy, type AiTip } from './tgAi';
import type { TgParsed } from './tgPostParser';

/** Our market («Map 2 Winner», «Total Maps Over 2.5», «Handicap -1.5») as the reader's answer fields. */
export function marketToAi(market: string | null, pick: string | null, odds: number | null): AiTip {
  const m = market || '';
  let r: AiTip = { isTip: true, market: 'other', pick: pick || null, odds: odds ?? null };
  let x: RegExpExecArray | null;
  if (m === 'Match Winner') r = { ...r, market: 'match_winner' };
  else if ((x = /^Map (\d) Winner$/.exec(m))) r = { ...r, market: 'map_winner', map: Number(x[1]) };
  else if ((x = /^Total Maps (Over|Under) ([\d.]+)$/.exec(m))) r = { ...r, market: 'total_maps', line: Number(x[2]), over: x[1] === 'Over', pick: null };
  else if ((x = /^Handicap ([+-][\d.]+)$/.exec(m))) r = { ...r, market: 'handicap', line: Number(x[1]) };
  else if ((x = /^Map (\d) Total (Over|Under) ([\d.]+)$/.exec(m))) r = { ...r, market: 'map_total', map: Number(x[1]), line: Number(x[3]), over: x[2] === 'Over', pick: null };
  else if ((x = /^Map (\d) Handicap ([+-][\d.]+)$/.exec(m))) r = { ...r, market: 'map_handicap', map: Number(x[1]), line: Number(x[2]) };
  else if (m === 'Express') r = { ...r, market: 'express', pick: null };
  return r;
}

/** Up to 3 posts of the channel the admin sorted or confirmed in «Перевірити 10» (the reader's mistakes first, then the fixes): a short «caption → the right answer» list for the prompt. */
export async function channelExamples(handle: string): Promise<string> {
  const { rows } = await pool.query<{ text: string; photos: string[] | null; kind: string; reason: string | null; team1: string | null; team2: string | null; market: string | null; pick: string | null; odds: string | null; ai_wrong: boolean; ai_raw: AiTip | null }>(
    `SELECT text, photos, kind, reason, team1, team2, market, pick, odds, ai_wrong, ai_raw FROM tg_posts
      WHERE handle = $1 AND (fixed_by IS NOT NULL OR read_wrong IS FALSE) AND kind <> 'unknown' AND coalesce(text, '') <> ''
      ORDER BY ai_wrong DESC, (fixed_by IS NOT NULL) DESC, posted_at DESC LIMIT 3`, [handle]).catch(() => ({ rows: [] }));
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const right = r.kind === 'bet'
      ? { ...marketToAi(r.market, r.pick, r.odds != null ? Number(r.odds) : null), team1: r.team1, team2: r.team2 }
      : { isTip: false, ...(r.reason === 'Підсумок' ? { report: {} } : {}) };
    const was = r.ai_wrong && r.ai_raw ? ` (a reader first answered ${JSON.stringify(slim(r.ai_raw))} — that was wrong)` : '';
    return `Caption: «${r.text.replace(/\s+/g, ' ').slice(0, 280)}»${r.photos?.length ? ' + a screenshot' : ''} → ${JSON.stringify(slim(right as AiTip))}${was}`;
  });
  return `Earlier posts of this channel, checked by a person — answer the same way for posts like these:\n${lines.join('\n')}`;
}
const slim = (t: AiTip) => Object.fromEntries(Object.entries(t).filter(([k, v]) => v != null && !['legs', 'report', 'status', 'stake', 'currency', 'payout', 'bookmaker', 'by', 'byId', 'doubt'].includes(k)));

const BETTY = /ставк|ставлю|ставим|став[иі]м|беру|берем|бер[уеё]м|(?<!\p{L})п[12](?!\p{L})|(?<!\p{L})кф|коэф|кэф|коеф|экспресс|експрес|фора|тотал|ординар|прогноз|побед|перемог|виграє|выигра|(?<!\p{L})карт[аеуыі](?!\p{L})|\bbet|odds|\bvs\.?\b|против|проти|@\s*\d|\bwin\b|\bmap\b|\bcs2?\b|dota|дота|(?<!\p{L})кс(?!\p{L})/iu;
const ODDS = /(^|[^\d])[1-9]\d?[.,]\d{1,3}(?![\d%])/;
/** A text-only post that is surely not a tip (no odds, no betting words, no match of ours named): saved as «Інфо» without asking a reader. */
export function surelyNotTip(text: string, parsed: TgParsed): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (parsed.kind !== 'other' || ('match' in parsed && parsed.match)) return false;
  return !ODDS.test(t) && !BETTY.test(t);
}

/** A channel's text template: the parser alone agreed with the reader on ≥ 10 text tips and missed ≤ 1 in 10 — then its text tips skip the reader. */
export type Template = { agree?: number; disagree?: number };
export const templateTrusted = (t: Template | null | undefined) => !!t && (t.agree || 0) >= 10 && (t.disagree || 0) * 10 <= (t.agree || 0);
/** The parser's own reading of a caption is a full tip (match, market, pick or total, odds) — enough to skip the reader. */
export const fullTip = (p: TgParsed) => p.kind === 'bet' && !!p.match && p.odds != null && (!!p.pick || /Total/.test(p.market));
/** The parser's reading and the reader's (through the parser) say the same. */
export function sameTip(a: TgParsed, b: TgParsed): boolean {
  if (a.kind !== 'bet' || b.kind !== 'bet') return a.kind === b.kind;
  return a.match.id === b.match.id && a.market === b.market && normalizeTeam(a.pick || '') === normalizeTeam(b.pick || '') && Math.abs((a.odds ?? 0) - (b.odds ?? 0)) < 0.015;
}
export async function countTemplate(handle: string, agree: boolean): Promise<void> {
  const k = agree ? 'agree' : 'disagree';
  await pool.query(`UPDATE tg_channels SET template = template || jsonb_build_object($2::text, COALESCE((template->>$2)::int, 0) + 1) WHERE handle = $1`, [handle, k]).catch(() => {});
}

/** A reader's score: with 10+ posts the admin looked at (fixed, or «Правильно» / «Ні» in «Перевірити 10») its error rate is theirs,
 *  spread over everything it read; with fewer — the corrections alone over everything it read (an unchecked post counts as right). */
export function readerScore(read: number, wrong: number, checked: number, checkedWrong: number): { read: number; wrong: number } {
  if (checked >= 10 && read > 0) return { read, wrong: Math.round((checkedWrong / checked) * read) };
  return { read, wrong };
}
/** Each reader's last 30 days: posts it read first, the ones the admin corrected and the ones it confirmed. */
export async function loadReaderAccuracy(): Promise<void> {
  const { rows } = await pool.query<{ ai_by: string; read: number; wrong: number; checked: number; checked_wrong: number }>(
    `SELECT ai_by, count(*)::int AS read, count(*) FILTER (WHERE ai_wrong OR read_wrong IS TRUE)::int AS wrong,
            count(*) FILTER (WHERE read_wrong IS NOT NULL OR ai_wrong)::int AS checked, count(*) FILTER (WHERE read_wrong IS TRUE OR ai_wrong)::int AS checked_wrong FROM tg_posts
      WHERE ai_by IS NOT NULL AND read_by = 'ai' AND posted_at > now() - interval '30 days' GROUP BY ai_by`).catch(() => ({ rows: [] }));
  for (const k of Object.keys(readerAccuracy)) delete readerAccuracy[k];
  for (const r of rows) readerAccuracy[r.ai_by] = readerScore(r.read, r.wrong, r.checked, r.checked_wrong);
}

const same = (a?: string | null, b?: string | null) => { const x = normalizeTeam(a || ''), y = normalizeTeam(b || ''); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };
/** The reader's names are the match's teams the other way round («Liquid vs NiP» for NiP — Liquid). */
const crossed = (ai: AiTip, team1?: string | null, team2?: string | null) => (same(ai.team1, team2) || same(ai.team2, team1)) && !same(ai.team1, team1);
/** Was the reader's answer wrong against the right one (the match's teams to tell its spelling of a side)? */
export function wrongRead(ai: AiTip, right: AiTip, team1?: string | null, team2?: string | null): boolean {
  if (!right.isTip) return !!ai.isTip;
  if (!ai.isTip || ai.market !== right.market || (ai.map ?? null) !== (right.map ?? null)) return true;
  if (ai.odds != null && right.odds != null && Math.abs(ai.odds - right.odds) > 0.02) return true;
  if (right.line != null && ai.line != null && Math.abs(Math.abs(right.line) - Math.abs(ai.line)) > 0.01) return true;
  if (!right.pick) return false;
  if (same(ai.pick, right.pick)) return false;
  // the side the reader picked, by its own names of the teams
  const x = crossed(ai, team1, team2);
  const side = same(ai.pick, ai.team1) ? (x ? 2 : 1) : same(ai.pick, ai.team2) ? (x ? 1 : 2) : same(ai.pick, team1) ? 1 : same(ai.pick, team2) ? 2 : 0;
  const want = same(right.pick, team1) ? 1 : same(right.pick, team2) ? 2 : 0;
  return !side || !want || side !== want;
}
/** The admin sorted a post: was the reader wrong? And the team names it read become aliases of the match's teams. */
export async function learnFromFix(handle: string, postId: number, admin: { kind: 'bet' | 'other'; game?: string; team1?: string; team2?: string; market?: string; pick?: string | null; odds?: number | null }, who: string): Promise<void> {
  const r = (await pool.query<{ ai_raw: AiTip | null }>('SELECT ai_raw FROM tg_posts WHERE handle = $1 AND post_id = $2', [handle, postId])).rows[0];
  const ai = r?.ai_raw;
  if (!ai) return;
  const right: AiTip = admin.kind === 'bet' ? marketToAi(admin.market || null, admin.pick ?? null, admin.odds ?? null) : { isTip: false };
  const wrong = wrongRead(ai, right, admin.team1, admin.team2);
  await pool.query('UPDATE tg_posts SET ai_wrong = $3 WHERE handle = $1 AND post_id = $2', [handle, postId, wrong]);
  if (admin.kind !== 'bet' || !admin.team1 || !admin.team2 || !ai.team1 || !ai.team2) return;
  // which read name is which team: the order that fits better
  const pairs: [string, string][] = crossed(ai, admin.team1, admin.team2) ? [[admin.team2, ai.team1], [admin.team1, ai.team2]] : [[admin.team1, ai.team1], [admin.team2, ai.team2]];
  for (const [canonical, alias] of pairs) {
    const a = alias.trim();
    if (a.length < 2 || a.length > 60 || normalizeTeam(a) === normalizeTeam(canonical)) continue;
    await pool.query(`INSERT INTO team_aliases(game, canonical, alias, created_by) VALUES($1, $2, $3, $4) ON CONFLICT (game, alias) DO NOTHING`,
      [admin.game === 'dota2' ? 'dota2' : 'cs2', canonical, a, `tg:${who}`]).catch(() => {});
  }
}

// ── the reference check: the posts the admin sorted, read again by every reader ──
type GoldenReader = { id: string; label: string; ok: number; total: number; skipped: number; misses: string[] };
export type Golden = { at: string; posts: number; readers: GoldenReader[] };
export const goldenRun: { running: boolean; done: number; total: number } = { running: false, done: 0, total: 0 };

export async function lastGolden(): Promise<Golden | null> {
  const r = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'tg_golden'`).catch(() => ({ rows: [] }))).rows[0];
  try { return r ? JSON.parse(r.value) as Golden : null; } catch { return null; }
}

/** Up to `n` posts the admin sorted or confirmed × every reader with a key: right / wrong, saved for the admin. Runs ≈6 s a request. */
export async function runGolden(n = 20): Promise<void> {
  if (goldenRun.running) return;
  const { rows } = await pool.query<{ handle: string; post_id: number; text: string; photos: string[] | null; kind: string; team1: string | null; team2: string | null; market: string | null; pick: string | null; odds: string | null }>(
    `SELECT handle, post_id, text, photos, kind, team1, team2, market, pick, odds FROM tg_posts WHERE (fixed_by IS NOT NULL OR read_wrong IS FALSE) AND kind <> 'unknown' AND photos IS NOT NULL
      ORDER BY (fixed_by IS NOT NULL) DESC, posted_at DESC LIMIT $1`, [n]);
  const readers = PROVIDERS.filter((p) => p.key());
  if (!rows.length || !readers.length) return;
  goldenRun.running = true; goldenRun.done = 0; goldenRun.total = rows.length * readers.length;
  const out: GoldenReader[] = readers.map((p) => ({ id: p.id, label: p.label, ok: 0, total: 0, skipped: 0, misses: [] }));
  try {
    for (const row of rows) {
      const { imgs } = await loadImages(row.photos || []);
      const right: AiTip = row.kind === 'bet' ? marketToAi(row.market, row.pick, row.odds != null ? Number(row.odds) : null) : { isTip: false };
      for (const g of out) {
        const r = await askOne(g.id, row.text || '', imgs).catch((e: Error) => ({ tip: undefined, why: e.message }));
        goldenRun.done++;
        if (!r.tip) { g.skipped++; continue; }
        g.total++;
        const t = r.tip;
        if (!wrongRead(t, right, row.team1, row.team2)) g.ok++;
        else if (g.misses.length < 5) g.misses.push(`@${row.handle}/${row.post_id}: ${t.isTip ? `${t.market}${t.map ? ` ${t.map}` : ''} · ${t.pick || '—'} @${t.odds ?? '—'}` : 'не прогноз'} — а треба ${right.isTip ? `${right.market}${right.map ? ` ${right.map}` : ''} · ${right.pick || '—'} @${right.odds ?? '—'}` : 'не прогноз'}`);
      }
    }
    const res: Golden = { at: new Date().toISOString(), posts: rows.length, readers: out };
    await pool.query(`INSERT INTO app_settings(key, value) VALUES('tg_golden', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(res)]);
  } finally { goldenRun.running = false; }
}
