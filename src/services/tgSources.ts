/**
 * «Telegram-джерела»: public t.me channels we read without an account (t.me/s/<handle> — the web preview, ~20 newest posts),
 * every post parsed into a tip against our own match feed, tips settled by the series score from matches_history.
 * Channels: the public links users added to «Telegram-групи» + the ones an admin adds for a test. Invites (t.me/+…) are skipped.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pool } from '../db/client';
import { cleanHandle, validHandle } from './telegramAvatar';
import { parseTgPage, parseTgPost, type TgCandidate, type TgParsed, type TgRules } from './tgPostParser';
import { resultFor } from './betHints';
import { teamKey } from './matchFeed';
import { isNight } from './nightMode';
import { closeOcr, ocrImage } from './tgOcr';
import { aiLine, aiReadPost, currencyCode, type AiTip } from './tgAi';
import { normalizeTeam } from '../utils/matchUtils';

export const TG_EVERY_MS = 10 * 60_000, TG_NIGHT_MS = 60 * 60_000;
const GAP_MS = 1500;

/** «t.me/kiberprognoz_ua», «@kiberprognoz_ua» → handle; invites and junk → null. */
export function publicHandle(link: string | null | undefined): string | null {
  const raw = String(link || '').trim();
  if (!raw || /t\.me\/(\+|joinchat)/i.test(raw) || raw.startsWith('+')) return null;
  const h = cleanHandle(raw.replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\/(s\/)?/i, '')).toLowerCase();
  return validHandle(h) ? h : null;
}

export async function fetchChannelPage(handle: string) {
  const res = await fetch(`https://t.me/s/${handle}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MatchIQ/1.0)', 'accept-language': 'en' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`t.me відповів ${res.status}`);
  return parseTgPage(await res.text());
}

/** Matches a post can be about: the feed caches (today and on) + finished ones of the last 3 days, with team aliases. */
/** Matches a post can be about: the feeds + the history (last 3 days, or from `since` when re-reading older posts). */
export async function tgCandidates(since?: string): Promise<TgCandidate[]> {
  const al = await pool.query<{ game: string; canonical: string; alias: string }>('SELECT game, canonical, alias FROM team_aliases').catch(() => ({ rows: [] as { game: string; canonical: string; alias: string }[] }));
  const byKey = new Map<string, string[]>();
  for (const r of al.rows) { const k = `${r.game}:${teamKey(r.canonical)}`; (byKey.get(k) || byKey.set(k, []).get(k)!).push(r.alias); }
  const aliases = (g: string, n: string) => byKey.get(`${g}:${teamKey(n)}`) || [];
  const out = new Map<string, TgCandidate>();
  for (const game of ['cs2', 'dota2'] as const) {
    const f = join(process.cwd(), '.cache', `${game}_matches.json`);
    try {
      if (!existsSync(f)) continue;
      const data = JSON.parse(readFileSync(f, 'utf8')).data as { id: string; nameTeam1: string; nameTeam2: string; startDate?: string | null; date: string }[];
      for (const m of data || []) {
        if (!m?.id || !m.nameTeam1 || !m.nameTeam2) continue;
        out.set(m.id, { id: String(m.id), game, team1: String(m.nameTeam1), team2: String(m.nameTeam2), start: m.startDate || `${m.date}T12:00:00Z`, aliases1: aliases(game, String(m.nameTeam1)), aliases2: aliases(game, String(m.nameTeam2)) });
      }
    } catch { /* a broken cache is skipped */ }
  }
  const hist = await pool.query<{ id: string; game: string; team1: string; team2: string; date: string }>(
    `SELECT match_id AS id, game, team1, team2, to_char(date, 'YYYY-MM-DD') AS date FROM matches_history WHERE date >= LEAST(CURRENT_DATE - 3, COALESCE($1::date - 1, CURRENT_DATE - 3))`, [since ? since.slice(0, 10) : null]).catch(() => ({ rows: [] as { id: string; game: string; team1: string; team2: string; date: string }[] }));
  for (const m of hist.rows) {
    if (out.has(m.id)) continue;
    const game = m.game === 'dota2' ? 'dota2' : 'cs2';
    out.set(m.id, { id: m.id, game, team1: m.team1, team2: m.team2, start: `${m.date}T12:00:00Z`, aliases1: aliases(game, m.team1), aliases2: aliases(game, m.team2) });
  }
  return [...out.values()];
}

const gameOk = (chGame: string, p: TgParsed) => chGame === 'both' || !('match' in p) || !p.match || p.match.game === chGame;

type PagePost = { id: number; at: string; text: string; photos: string[] };

/** The caption + what OCR read on its screenshots (up to 2) — what the parser sees. */
/** What a bet slip on the screenshot shows: its state and money. */
export interface Slip { status: NonNullable<AiTip['status']>; stake: number | null; currency: string | null; payout: number | null }
const STATUS_UA: Record<string, string> = { won: 'виграш', lost: 'програш', pending: 'очікується', cashout: 'продано', void: 'повернення' };

async function readPost(post: PagePost): Promise<{ ocr: string; full: string; ai?: boolean; slip?: Slip | null }> {
  // the model first (when GEMINI_API_KEY is set): it tells a tip from news and reads the slip; its answer becomes a plain tip line
  const ai = await aiReadPost(post.text, post.photos);
  if (ai) {
    const line = aiLine(ai);
    const slip: Slip | null = ai.isTip && ai.status ? { status: ai.status, stake: ai.stake && ai.stake > 0 ? ai.stake : null, currency: currencyCode(ai.currency), payout: ai.payout && ai.payout > 0 ? ai.payout : null } : null;
    const money = slip ? ` · квиток: ${STATUS_UA[slip.status]}${slip.stake ? `, ставка ${slip.stake}${slip.currency ? ` ${slip.currency}` : ''}` : ''}${slip.payout ? `, виплата ${slip.payout}` : ''}` : '';
    return { ocr: `ШІ: ${line ? line.replace(/\n/g, ' · ') : 'не прогноз'}${money}`, full: line, ai: true, slip };
  }
  const parts: string[] = [];
  for (const url of post.photos.slice(0, 2)) { const t = await ocrImage(url); if (t) parts.push(t); }
  const ocr = parts.join('\n\n');
  return { ocr, full: [post.text, ocr].filter(Boolean).join('\n') };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A channel often posts the same tip twice (a repost, a reply with the same ticket): the later one is «Повтор», so stats count it once. */
async function repeatOf(handle: string, post: PagePost, p: TgParsed, slip?: Slip | null): Promise<TgParsed> {
  const prev = await pool.query<{ post_id: number; text: string; kind: string; match_id: string | null; market: string | null; pick: string | null; reason: string | null }>(
    `SELECT post_id, text, kind, match_id, market, pick, reason FROM tg_posts WHERE handle = $1 AND post_id < $2 AND posted_at > $3::timestamptz - interval '2 days' AND (reason IS DISTINCT FROM 'Повтор') ORDER BY post_id DESC LIMIT 30`,
    [handle, post.id, post.at]);
  const t = norm(post.text);
  const same = prev.rows.find((r) => {
    if (p.kind === 'bet') return r.kind === 'bet' && r.match_id === p.match.id && r.market === p.market && r.pick === p.pick;
    if (p.kind === 'unknown' && p.match) return r.kind === 'unknown' && r.match_id === p.match.id && r.reason === p.reason;
    return t.length >= 12 && norm(r.text) === t;
  });
  if (!same) return p;
  // the same tip again with its result on the slip (won / lost): the result goes to the first post, this one is «Результат»
  if (p.kind === 'bet' && slip && (slip.status === 'won' || slip.status === 'lost' || slip.status === 'cashout' || slip.status === 'void')) {
    await applySlip(handle, same.post_id, slip, true, true);
    return { kind: 'other', reason: 'Результат', repeatOf: same.post_id };
  }
  return { kind: 'other', reason: 'Повтор', repeatOf: same.post_id };
}

/** The slip's money and, when it shows one, its result (won → Win, lost → Loss, returned/sold → Void) on a tip. */
async function applySlip(handle: string, postId: number, slip: Slip, keepMoney = false, fromLater = false): Promise<void> {
  const res = slip.status === 'won' ? 'Win' : slip.status === 'lost' ? 'Loss' : slip.status === 'void' || slip.status === 'cashout' ? 'Void' : null;
  await pool.query(
    `UPDATE tg_posts SET slip = CASE WHEN $9 AND slip IS NOT NULL THEN slip ELSE $3 END, -- a post keeps what its own slip shows («очікується»); the result comes from the later one
        stake = CASE WHEN $7 AND stake IS NOT NULL THEN stake ELSE COALESCE($4, stake) END,
        currency = CASE WHEN $7 AND currency IS NOT NULL THEN currency ELSE COALESCE($5, currency) END,
        payout = COALESCE($6, payout),
        result = CASE WHEN fixed_by IS NULL AND $8::text IS NOT NULL THEN $8 ELSE result END
      WHERE handle = $1 AND post_id = $2 AND kind = 'bet'`,
    [handle, postId, slip.status, slip.stake, slip.currency, slip.payout, keepMoney, res, fromLater]);
}

/** New post → insert; a post saved before we read screenshots (photos IS NULL) → photos + OCR, re-parsed unless an admin sorted it. */
async function savePost(handle: string, post: PagePost, ocr: string, p: TgParsed, backfill = false): Promise<void> {
  const m = 'match' in p ? p.match : undefined;
  const vals = [handle, post.id, post.at, post.text.slice(0, 4000), p.kind, 'reason' in p ? p.reason ?? null : null, m?.game ?? null, m?.id ?? null, m?.team1 ?? null, m?.team2 ?? null,
    p.kind === 'bet' ? p.market : null, p.kind === 'bet' ? p.pick : null, p.kind === 'other' ? null : (p.odds ?? null), post.photos, ocr || null];
  await pool.query(
    `INSERT INTO tg_posts(handle, post_id, posted_at, text, kind, reason, game, match_id, team1, team2, market, pick, odds, photos, ocr)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (handle, post_id) DO ${backfill ? `UPDATE SET photos = EXCLUDED.photos, ocr = EXCLUDED.ocr, text = EXCLUDED.text,
       kind = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.kind ELSE tg_posts.kind END,
       reason = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.reason ELSE tg_posts.reason END,
       game = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.game ELSE tg_posts.game END,
       match_id = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.match_id ELSE tg_posts.match_id END,
       team1 = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.team1 ELSE tg_posts.team1 END,
       team2 = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.team2 ELSE tg_posts.team2 END,
       market = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.market ELSE tg_posts.market END,
       pick = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.pick ELSE tg_posts.pick END,
       odds = CASE WHEN tg_posts.fixed_by IS NULL THEN EXCLUDED.odds ELSE tg_posts.odds END,
       result = CASE WHEN tg_posts.fixed_by IS NULL THEN NULL ELSE tg_posts.result END, score = CASE WHEN tg_posts.fixed_by IS NULL THEN NULL ELSE tg_posts.score END,
       slip = CASE WHEN tg_posts.fixed_by IS NULL THEN NULL ELSE tg_posts.slip END` : 'NOTHING'}`,
    vals,
  );
}

/** Read one channel now: new posts → parsed → saved. Returns how many posts were new. */
const busy = new Set<string>();
/** A running «Перечитати» / first read of a new channel: posts to read and read so far (progress in the admin). */
export const progress = new Map<string, { total: number; done: number; kind: 'reread' | 'add' }>();

/** Reads the channel until every saved post is re-read (8 a pass), not waiting for the next 10-minute pass. */
export async function rereadChannel(handle: string, total: number): Promise<void> {
  progress.set(handle, { total, done: 0, kind: 'reread' });
  try {
    for (let i = 0; i < 12; i++) {
      const before = progress.get(handle)?.done ?? 0;
      await collectChannel(handle);
      const pr = progress.get(handle);
      if (!pr || pr.done === before) break; // nothing left on the channel's page (older posts are no longer there to read)
    }
    if (progress.get(handle)) progress.get(handle)!.done = progress.get(handle)!.total;
    await settleTgTips().catch(() => 0);
  } finally { progress.delete(handle); }
}

/** A channel just added: its page is read in the background (≈6 s a post with the AI reader), the admin sees the progress. */
export async function firstRead(handle: string): Promise<void> {
  progress.set(handle, { total: 20, done: 0, kind: 'add' });
  try {
    const page = await fetchChannelPage(handle).catch(() => null);
    if (page) progress.set(handle, { total: Math.max(1, page.posts.filter((p) => p.text || p.photos.length).length), done: 0, kind: 'add' });
    await collectChannel(handle);
    await settleTgTips().catch(() => 0);
  } finally { progress.delete(handle); }
}

export async function collectChannel(handle: string, cands?: TgCandidate[]): Promise<number> {
  if (busy.has(handle)) return 0; // a pass on this channel is already reading it
  busy.add(handle);
  try { return await collectChannel1(handle, cands); } finally { busy.delete(handle); }
}
async function collectChannel1(handle: string, cands?: TgCandidate[]): Promise<number> {
  const ch = (await pool.query<{ last_post_id: number; game: string; rules: TgRules }>('SELECT last_post_id, game, rules FROM tg_channels WHERE handle = $1', [handle])).rows[0];
  if (!ch) return 0;
  let page;
  try { page = await fetchChannelPage(handle); } catch (e) {
    await pool.query('UPDATE tg_channels SET checked_at = now(), error = $2 WHERE handle = $1', [handle, (e as Error).message.slice(0, 300)]);
    return 0;
  }
  if (!page.isPublic) { await pool.query(`UPDATE tg_channels SET checked_at = now(), error = 'Канал не знайдено або він приватний' WHERE handle = $1`, [handle]); return 0; }
  const fresh = page.posts.filter((p) => p.id > ch.last_post_id && (p.text || p.photos.length));
  // posts saved by an older reader (photos IS NULL): read again — own text (not a reply's quote), screenshots
  const older = page.posts.filter((p) => p.id <= ch.last_post_id);
  const unread = older.length ? new Set((await pool.query<{ post_id: number }>('SELECT post_id FROM tg_posts WHERE handle = $1 AND photos IS NULL AND post_id = ANY($2::int[])', [handle, older.map((p) => p.id)])).rows.map((r) => r.post_id)) : new Set<number>();
  // re-reading is spread over passes (8 posts a pass, newest first) so a pass stays short
  const again = older.filter((p) => unread.has(p.id)).sort((a, b) => b.id - a.id).slice(0, 8);
  const todo = [...fresh, ...again].sort((a, b) => a.id - b.id);
  const oldest = todo.reduce((a, p) => (a && a < p.at ? a : p.at), '');
  const list = cands && !unread.size ? cands : await tgCandidates(oldest || undefined);
  for (const post of todo) {
    const { ocr, full, ai, slip } = await readPost(post);
    let parsed = ai && !full ? { kind: 'other' as const } : parseTgPost(full, post.at, list, ch.rules || {});
    if (!gameOk(ch.game, parsed)) parsed = { kind: 'other' };
    parsed = await repeatOf(handle, post, parsed, slip);
    await savePost(handle, post, ocr, parsed, post.id <= ch.last_post_id);
    if (slip && parsed.kind === 'bet') await applySlip(handle, post.id, slip);
    // «Результат»: the post shows its own slip (won / lost), the tip and its money stay counted once — on the first post
    else if (slip && parsed.kind === 'other' && parsed.reason === 'Результат') await pool.query('UPDATE tg_posts SET slip = $3, stake = $4, currency = $5, payout = $6 WHERE handle = $1 AND post_id = $2', [handle, post.id, slip.status, slip.stake, slip.currency, slip.payout]);
    const pr = progress.get(handle);
    if (pr) pr.done = Math.min(pr.total, pr.done + 1);
  }
  const last = page.posts.reduce((a, p) => (p.id > a.id ? p : a), { id: ch.last_post_id, at: '' } as { id: number; at: string });
  await pool.query(
    `UPDATE tg_channels SET title = COALESCE($2, title), subscribers = COALESCE($3, subscribers), checked_at = now(), error = NULL,
       last_post_id = GREATEST(last_post_id, $4), last_post_at = COALESCE($5::timestamptz, last_post_at) WHERE handle = $1`,
    [handle, page.title, page.subscribers, last.id, last.at || null],
  );
  return fresh.length;
}

/** Public links users added to «Telegram-групи» become channels (not blocked ones). */
export async function syncUserChannels(): Promise<void> {
  const { rows } = await pool.query<{ link: string; game: string | null; username: string | null }>(
    `SELECT g.link, g.game, u.username FROM telegram_groups g LEFT JOIN users u ON u.id = g.user_id WHERE g.moderation_status <> 'rejected' AND g.link <> ''`);
  for (const r of rows) {
    const h = publicHandle(r.link);
    if (!h) continue;
    await pool.query(`INSERT INTO tg_channels(handle, game, added_by) VALUES($1, 'both', $2) ON CONFLICT (handle) DO NOTHING`, [h, r.username ? `@${r.username}` : null]);
  }
}

/** Pending tips whose match has a series score in the history → Win / Loss. */
export async function settleTgTips(): Promise<number> {
  const { rows } = await pool.query<{ handle: string; post_id: number; match_id: string; market: string; pick: string | null; team1: string; team2: string; game: string; posted_at: string;
    s1: number | null; s2: number | null; h1: string; h2: string; hdate: string }>(
    `SELECT p.handle, p.post_id, p.match_id, p.market, p.pick, p.team1, p.team2, p.game, p.posted_at, h.score1 AS s1, h.score2 AS s2, h.team1 AS h1, h.team2 AS h2, to_char(h.date, 'YYYY-MM-DD') AS hdate
     FROM tg_posts p JOIN matches_history h ON h.match_id = p.match_id
     WHERE p.kind = 'bet' AND p.result IS NULL AND h.status = 'finished'`);
  let n = 0;
  for (const r of rows) {
    const res = resultFor({ id: '', team1: r.team1, team2: r.team2, selection: r.pick, betType: r.market, game: r.game, date: r.hdate }, { team1: r.h1, team2: r.h2, score1: r.s1, score2: r.s2, date: r.hdate, game: r.game });
    if (!res) continue;
    await pool.query('UPDATE tg_posts SET result = $3, score = $4 WHERE handle = $1 AND post_id = $2', [r.handle, r.post_id, res, `${r.s1}:${r.s2}`]);
    n++;
  }
  // tips on matches we did not have (teams taken from the post): the finished match of these two teams within days of the post
  const loose = await pool.query<{ handle: string; post_id: number; market: string; pick: string | null; team1: string; team2: string; game: string; day: string }>(
    `SELECT handle, post_id, market, pick, team1, team2, game, to_char(posted_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day FROM tg_posts
      WHERE kind = 'bet' AND result IS NULL AND match_id LIKE 'tg:%' AND posted_at > now() - interval '120 days' LIMIT 200`);
  for (const r of loose.rows) {
    const k1 = normalizeTeam(r.team1), k2 = normalizeTeam(r.team2);
    if (!k1 || !k2) continue;
    const same = (a: string, b: string) => { const x = normalizeTeam(a); return !!x && (x === b || (b.length >= 4 && x.includes(b)) || (x.length >= 4 && b.includes(x))); };
    const hs = await pool.query<{ team1: string; team2: string; score1: number | null; score2: number | null; date: string }>(
      `SELECT team1, team2, score1, score2, to_char(date, 'YYYY-MM-DD') AS date FROM matches_history WHERE status = 'finished' AND date BETWEEN $1::date - 1 AND $1::date + 3 ORDER BY date`, [r.day]);
    const h = hs.rows.find((x) => (same(x.team1, k1) && same(x.team2, k2)) || (same(x.team1, k2) && same(x.team2, k1)));
    if (!h || !(h.score1 || h.score2)) continue;
    const res = resultFor({ id: '', team1: r.team1, team2: r.team2, selection: r.pick, betType: r.market, game: r.game, date: h.date }, { team1: h.team1, team2: h.team2, score1: h.score1, score2: h.score2, date: h.date, game: r.game });
    if (!res) continue;
    const flip = same(h.team1, k2);
    await pool.query('UPDATE tg_posts SET result = $3, score = $4 WHERE handle = $1 AND post_id = $2', [r.handle, r.post_id, res, flip ? `${h.score2}:${h.score1}` : `${h.score1}:${h.score2}`]);
    n++;
  }
  return n;
}

let running = false;
/** One pass: sync users' channels, read every channel that is not paused or blocked, settle tips. */
export async function tgCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await syncUserChannels().catch(() => {});
    const { rows } = await pool.query<{ handle: string }>(
      `SELECT c.handle FROM tg_channels c WHERE NOT c.paused AND NOT EXISTS (
         SELECT 1 FROM telegram_groups g WHERE g.moderation_status = 'rejected' AND lower(g.link) LIKE '%' || c.handle || '%') ORDER BY c.checked_at NULLS FIRST`);
    const cands = rows.length ? await tgCandidates() : [];
    for (const r of rows) { await collectChannel(r.handle, cands).catch((e) => console.warn(`[tg] ${r.handle}:`, (e as Error).message)); await new Promise((ok) => setTimeout(ok, GAP_MS)); }
    await settleTgTips().catch(() => {});
  } finally { running = false; await closeOcr(); }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export const tgNextAt = { at: 0 };
export function startTgSources(): void {
  const next = () => { const ms = isNight() ? TG_NIGHT_MS : TG_EVERY_MS; tgNextAt.at = Date.now() + ms; timer = setTimeout(run, ms); };
  const run = () => { void tgCycle().catch((e) => console.warn('[tg] cycle:', (e as Error).message)).finally(next); };
  if (!timer) { tgNextAt.at = Date.now() + 90_000; timer = setTimeout(run, 90_000); }
}

/** «Додати канал»: what the channel looks like before we start reading it. */
export async function previewChannel(link: string) {
  const handle = publicHandle(link);
  if (!handle) return { ok: false as const, error: /\+|joinchat/.test(link) ? 'Це запрошення в приватну групу — поки збираємо лише публічні канали' : 'Не схоже на посилання t.me/… або @нікнейм' };
  let page;
  try { page = await fetchChannelPage(handle); } catch (e) { return { ok: false as const, error: (e as Error).message }; }
  if (!page.isPublic) return { ok: false as const, error: 'Канал не знайдено або він приватний' };
  const cands = await tgCandidates();
  // the preview reads captions only (a screenshot takes seconds) — screenshots are read once the channel is added
  const parsed: TgParsed[] = [];
  for (const p of page.posts) { if (p.text) parsed.push(parseTgPost(p.text, p.at, cands)); }
  const exists = (await pool.query('SELECT 1 FROM tg_channels WHERE handle = $1', [handle])).rowCount! > 0;
  return { ok: true as const, handle, title: page.title, subscribers: page.subscribers, posts: page.posts.length, tipLike: parsed.filter((p) => p.kind !== 'other').length, recognized: parsed.filter((p) => p.kind === 'bet').length, exists };
}
