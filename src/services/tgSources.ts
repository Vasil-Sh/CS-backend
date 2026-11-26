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
import { teamKey } from './matchFeed';
import { isNight } from './nightMode';
import { closeOcr, ocrImage } from './tgOcr';
import { feedMatches, placedLive, sameName, verifyTips, type FeedMatch, type Leg } from './tgVerify';
import { recordServerError } from './serverErrors';
import { abbreviations } from '../utils/teamAbbrev';
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

/** The channel's page: its last ~20 posts, or the ~20 before post `before` (the archive). */
export async function fetchChannelPage(handle: string, before?: number) {
  const res = await fetch(`https://t.me/s/${handle}${before ? `?before=${before}` : ''}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MatchIQ/1.0)', 'accept-language': 'en' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`t.me відповів ${res.status}`);
  return parseTgPage(await res.text());
}

/** Matches a post can be about: the feed caches (today and on) + finished ones of the last 3 days, with team aliases. */
/** Matches a post can be about: the feeds + the history (last 3 days, or from `since` when re-reading older posts). */
export async function tgCandidates(since?: string): Promise<TgCandidate[]> {
  const al = await pool.query<{ game: string; canonical: string; alias: string }>('SELECT game, canonical, alias FROM team_aliases').catch(() => ({ rows: [] as { game: string; canonical: string; alias: string }[] }));
  const byKey = new Map<string, string[]>();
  for (const r of al.rows) { const k = `${r.game}:${teamKey(r.canonical)}`; (byKey.get(k) || byKey.set(k, []).get(k)!).push(r.alias); }
  const aliases = (g: string, n: string) => [...(byKey.get(`${g}:${teamKey(n)}`) || []), ...abbreviations(n)]; // + «NAVI» for «Natus Vincere»
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

type PagePost = { id: number; at: string; text: string; photos: string[]; poll?: boolean };

/** The caption + what OCR read on its screenshots (up to 2) — what the parser sees. */
/** What a bet slip on the screenshot shows: its state and money. */
export interface Slip { status: NonNullable<AiTip['status']>; stake: number | null; currency: string | null; payout: number | null }
const STATUS_UA: Record<string, string> = { won: 'виграш', lost: 'програш', pending: 'очікується', cashout: 'продано', void: 'повернення' };

async function readPost(post: PagePost, hint = ''): Promise<{ ocr: string; full: string; ai?: boolean; slip?: Slip | null; tip?: AiTip & { doubt?: string } }> {
  // the model first (when GEMINI_API_KEY is set): it tells a tip from news and reads the slip; its answer becomes a plain tip line
  const ai = await aiReadPost(post.text, post.photos, hint);
  if (ai) {
    const line = aiLine(ai);
    const slip: Slip | null = ai.isTip && ai.status ? { status: ai.status, stake: ai.stake && ai.stake > 0 ? ai.stake : null, currency: currencyCode(ai.currency), payout: ai.payout && ai.payout > 0 ? ai.payout : null } : null;
    const money = slip ? ` · квиток: ${STATUS_UA[slip.status]}${slip.stake ? `, ставка ${slip.stake}${slip.currency ? ` ${slip.currency}` : ''}` : ''}${slip.payout ? `, виплата ${slip.payout}` : ''}` : '';
    const legsTxt = ai.market === 'express' && ai.legs?.length ? ` · ${ai.legs.map((l) => `${l.team1} — ${l.team2}: ${l.pick || ''}${l.odds ? ` @${l.odds}` : ''}`).join('; ')}` : '';
    const who = ai.by ? ` (${ai.by})` : '', doubt = ai.doubt ? ` · РОЗБІЖНІСТЬ: ${ai.doubt}` : '';
    return { ocr: `ШІ${who}: ${line ? line.replace(/\n/g, ' · ') : 'не прогноз'}${legsTxt}${money}${doubt}`, full: line, ai: true, slip, tip: ai };
  }
  const parts: string[] = [];
  for (const url of post.photos.slice(0, 2)) { const t = await ocrImage(url); if (t) parts.push(t); }
  const ocr = parts.join('\n\n');
  return { ocr, full: [post.text, ocr].filter(Boolean).join('\n') };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A channel often posts the same tip twice (a repost, a reply with the same ticket): the later one is «Повтор», so stats count it once. */
async function repeatOf(handle: string, post: PagePost, p: TgParsed, slip?: Slip | null): Promise<TgParsed> {
  const prev = await pool.query<{ post_id: number; text: string; kind: string; match_id: string | null; market: string | null; pick: string | null; reason: string | null; odds: string | null }>(
    `SELECT post_id, text, kind, match_id, market, pick, reason, odds FROM tg_posts WHERE handle = $1 AND post_id < $2 AND posted_at > $3::timestamptz - interval '2 days' AND (reason IS DISTINCT FROM 'Повтор') ORDER BY post_id DESC LIMIT 30`,
    [handle, post.id, post.at]);
  const t = norm(post.text);
  const same = prev.rows.find((r) => {
    // the same pick on the same match: the same market, or the same odds (one bet shown on a share card and on the bookmaker's slip)
    if (p.kind === 'bet') {
      if (r.kind !== 'bet') return false;
      if (r.match_id === p.match.id && r.pick === p.pick && r.market === p.market) return true;
      // the same team at the same odds within two days — whatever the two slips call the match or the market
      const a = normalizeTeam(r.pick || ''), b = normalizeTeam(p.pick || '');
      const samePick = !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))));
      return samePick && p.odds != null && r.odds != null && Math.abs(Number(r.odds) - p.odds) < 0.015;
    }
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

/** Posts the channel changed since we read them (text differs) are read again; posts gone from the page between its first and last → «видалено». */
async function markEditedAndDeleted(handle: string, posts: PagePost[], lastId: number): Promise<void> {
  if (!posts.length) return;
  const ids = posts.map((p) => p.id), lo = Math.min(...ids), hi = Math.min(Math.max(...ids), lastId);
  const saved = (await pool.query<{ post_id: number; text: string }>('SELECT post_id, text FROM tg_posts WHERE handle = $1 AND post_id = ANY($2::int[]) AND photos IS NOT NULL AND fixed_by IS NULL', [handle, ids])).rows;
  const changed = saved.filter((r) => { const p = posts.find((x) => x.id === r.post_id); return p && r.text && norm(p.text) !== norm(r.text); }).map((r) => r.post_id);
  if (changed.length) await pool.query('UPDATE tg_posts SET photos = NULL, edited_at = now() WHERE handle = $1 AND post_id = ANY($2::int[])', [handle, changed]);
  if (hi > lo) await pool.query('UPDATE tg_posts SET deleted_at = now() WHERE handle = $1 AND post_id BETWEEN $2 AND $3 AND NOT (post_id = ANY($4::int[])) AND deleted_at IS NULL', [handle, lo, hi, ids]);
}

/** Read one channel now: new posts → parsed → saved. Returns how many posts were new. */
const busy = new Set<string>();
/** A running «Перечитати» / first read of a new channel: posts to read and read so far (progress in the admin). */
export const progress = new Map<string, { total: number; done: number; kind: 'reread' | 'add' | 'collect' | 'archive' }>();

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
interface Ctx { handle: string; ch: { last_post_id: number; game: string; rules: TgRules; profile: Profile }; list: TgCandidate[]; feed: FeedMatch[] }
type Profile = { bookmakers?: Record<string, number>; markets?: Record<string, number> };

/** What the channel usually posts, for the reader: «slips of BC.GAME; mostly map winners». */
function profileHint(p: Profile): string {
  const top = (o?: Record<string, number>) => Object.entries(o || {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k);
  const b = top(p.bookmakers), m = top(p.markets);
  return [b.length ? `its slips are usually from ${b.join(', ')}` : '', m.length ? `its usual markets: ${m.join(', ')}` : ''].filter(Boolean).join('; ');
}

/** One post: read (AI / OCR), parsed, saved; its tip checked against our feed (live, odds) and its slip applied. */
async function handlePost(ctx: Ctx, post: PagePost, backfill: boolean): Promise<void> {
  const { handle, ch, list, feed } = ctx;
  if (post.poll && !post.photos.length) { await savePost(handle, post, '', { kind: 'other', reason: 'Опитування' }, backfill); return; }
  const { ocr, full, ai, slip, tip } = await readPost(post, profileHint(ch.profile));
  let parsed: TgParsed = ai && !full ? { kind: 'other' } : parseTgPost(full, post.at, list, ch.rules || {});
  // a results summary («вчора 5/6»): kept as the channel's claim, compared with our results in the sheet
  if (tip?.report && (tip.report.won != null || tip.report.total != null) && !tip.isTip) parsed = { kind: 'other', reason: 'Підсумок' };
  // map totals / handicaps in rounds: the match from the parser, the market from the answer
  if (tip?.isTip && (tip.market === 'map_total' || tip.market === 'map_handicap') && parsed.kind === 'bet' && tip.line != null) {
    const n = tip.map || 1;
    parsed = tip.market === 'map_total'
      ? { ...parsed, market: `Map ${n} Total ${tip.over === false ? 'Under' : 'Over'} ${Math.abs(tip.line)}`, pick: '' }
      : { ...parsed, market: `Map ${n} Handicap ${tip.line > 0 ? '+' : '-'}${Math.abs(tip.line)}` };
  }
  // an express: every leg is read like a single, the bet is won when all legs are
  let legs: Leg[] | null = null;
  if (tip?.isTip && tip.market === 'express' && tip.legs?.length) {
    legs = tip.legs.map((l) => {
      const p1 = parseTgPost(aiLine({ ...l, isTip: true, game: tip.game }), post.at, list, ch.rules || {});
      const m = 'match' in p1 ? p1.match : undefined;
      return { team1: m?.team1 || l.team1 || '', team2: m?.team2 || l.team2 || '', market: p1.kind === 'bet' ? p1.market : 'Match Winner', pick: p1.kind === 'bet' ? p1.pick : l.pick || null, odds: l.odds ?? null, matchId: m?.id ?? null };
    }).filter((l) => l.team1 && l.team2);
    if (legs.length >= 2) parsed = { kind: 'bet', match: { id: `tg:express:${handle}:${post.id}`, game: tip.game === 'dota2' ? 'dota2' : 'cs2', team1: 'Експрес', team2: `${legs.length} ${legs.length < 5 ? 'події' : 'подій'}`, start: post.at }, market: 'Express', pick: '', odds: tip.odds ?? null };
    else legs = null;
  }
  if (!gameOk(ch.game, parsed)) parsed = { kind: 'other' };
  // two readers read a slip with money on it differently: the admin decides
  if (tip?.doubt && (parsed.kind === 'bet' || tip.isTip)) parsed = { kind: 'unknown', reason: 'Моделі прочитали квиток по-різному', match: 'match' in parsed ? parsed.match : undefined, odds: 'odds' in parsed ? parsed.odds : undefined };
  parsed = await repeatOf(handle, post, parsed, slip);
  await savePost(handle, post, ocr, parsed, backfill);
  if (tip?.report && parsed.kind === 'other' && parsed.reason === 'Підсумок') await pool.query('UPDATE tg_posts SET claim = $3 WHERE handle = $1 AND post_id = $2', [handle, post.id, JSON.stringify(tip.report)]);
  if (parsed.kind === 'bet') {
    // our odds for the pick when the match is in the feed: a tip far above them (≥ 15 %) is marked
    const fm = feed.find((x) => x.id === parsed.match.id);
    const ourOdds = fm && parsed.market === 'Match Winner' && parsed.pick ? (sameName(parsed.pick, fm.team1) ? fm.coeff1 : sameName(parsed.pick, fm.team2) ? fm.coeff2 : null) : null;
    const high = !!(ourOdds && parsed.odds && parsed.odds > ourOdds * 1.15);
    await pool.query('UPDATE tg_posts SET legs = $3, is_live = $4, our_odds = $5, odds_high = $6, our_result = NULL, mismatch = false, settled_by = NULL WHERE handle = $1 AND post_id = $2 AND fixed_by IS NULL',
      [handle, post.id, legs ? JSON.stringify(legs) : null, placedLive(parsed.match.id, post.at, feed), ourOdds ?? null, high]);
    // what the channel posts, for the next reads
    const mk = parsed.market.replace(/\d+(\.\d+)?/g, 'N').replace(/[+-]/g, '');
    await pool.query(`UPDATE tg_channels SET profile = jsonb_set(jsonb_set(profile, '{markets}', COALESCE(profile->'markets', '{}'::jsonb) || jsonb_build_object($2::text, COALESCE((profile->'markets'->>$2)::int, 0) + 1)),
        '{bookmakers}', COALESCE(profile->'bookmakers', '{}'::jsonb) || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($3::text, COALESCE((profile->'bookmakers'->>$3)::int, 0) + 1) END) WHERE handle = $1`,
      [handle, mk, tip?.bookmaker ? tip.bookmaker.trim().slice(0, 30) : null]).catch(() => {});
  }
  if (slip && parsed.kind === 'bet') await applySlip(handle, post.id, slip);
  // «Результат»: the post shows its own slip (won / lost), the tip and its money stay counted once — on the first post
  else if (slip && parsed.kind === 'other' && parsed.reason === 'Результат') await pool.query('UPDATE tg_posts SET slip = $3, stake = $4, currency = $5, payout = $6 WHERE handle = $1 AND post_id = $2', [handle, post.id, slip.status, slip.stake, slip.currency, slip.payout]);
  const pr = progress.get(handle);
  if (pr) pr.done = Math.min(pr.total, pr.done + 1);
}

async function channelCtx(handle: string, cands: TgCandidate[] | undefined, since?: string): Promise<Ctx | null> {
  const ch = (await pool.query<Ctx['ch']>('SELECT last_post_id, game, rules, profile FROM tg_channels WHERE handle = $1', [handle])).rows[0];
  if (!ch) return null;
  return { handle, ch, list: cands && !since ? cands : await tgCandidates(since), feed: feedMatches() };
}

/** A read of the channel page failed: counted; the 3rd failure in a row goes to «Помилки сервера». */
async function readFailed(handle: string, msg: string): Promise<void> {
  const r = (await pool.query<{ fails: number }>('UPDATE tg_channels SET checked_at = now(), error = $2, fails = fails + 1 WHERE handle = $1 RETURNING fails', [handle, msg.slice(0, 300)])).rows[0];
  if (r && r.fails === 3) recordServerError('process', `[tg] @${handle} не читається 3 рази поспіль: ${msg}`, '', `/telegram/${handle}`);
}

async function collectChannel1(handle: string, cands?: TgCandidate[]): Promise<number> {
  const ch0 = (await pool.query<{ last_post_id: number }>('SELECT last_post_id FROM tg_channels WHERE handle = $1', [handle])).rows[0];
  if (!ch0) return 0;
  let page;
  try { page = await fetchChannelPage(handle); } catch (e) { await readFailed(handle, (e as Error).message); return 0; }
  if (!page.isPublic) { await readFailed(handle, 'Канал не знайдено або він приватний'); return 0; }
  const fresh = page.posts.filter((p) => p.id > ch0.last_post_id && (p.text || p.photos.length));
  await markEditedAndDeleted(handle, page.posts, ch0.last_post_id);
  // posts saved by an older reader (photos IS NULL): read again — own text (not a reply's quote), screenshots
  const older = page.posts.filter((p) => p.id <= ch0.last_post_id);
  const unread = older.length ? new Set((await pool.query<{ post_id: number }>('SELECT post_id FROM tg_posts WHERE handle = $1 AND photos IS NULL AND post_id = ANY($2::int[])', [handle, older.map((p) => p.id)])).rows.map((r) => r.post_id)) : new Set<number>();
  // re-reading is spread over passes (8 posts a pass, newest first) so a pass stays short
  const again = older.filter((p) => unread.has(p.id)).sort((a, b) => b.id - a.id).slice(0, 8);
  const todo = [...fresh, ...again].sort((a, b) => a.id - b.id);
  // a pass with posts to read shows its progress on the card too (a re-read / a first read already set theirs)
  const own = !progress.has(handle) && todo.length > 0;
  if (own) progress.set(handle, { total: todo.length, done: 0, kind: 'collect' });
  try {
    const oldest = todo.reduce((a, p) => (a && a < p.at ? a : p.at), '');
    const ctx = await channelCtx(handle, cands, unread.size ? oldest || undefined : undefined);
    if (ctx) for (const post of todo) await handlePost(ctx, post, post.id <= ch0.last_post_id);
  } finally { if (own) progress.delete(handle); }
  const last = page.posts.reduce((a, p) => (p.id > a.id ? p : a), { id: ch0.last_post_id, at: '' } as { id: number; at: string });
  await pool.query(
    `UPDATE tg_channels SET title = COALESCE($2, title), subscribers = COALESCE($3, subscribers), checked_at = now(), error = NULL, fails = 0,
       last_post_id = GREATEST(last_post_id, $4), last_post_at = COALESCE($5::timestamptz, last_post_at) WHERE handle = $1`,
    [handle, page.title, page.subscribers, last.id, last.at || null],
  );
  return fresh.length;
}

/** «Підтягнути архів»: the pages before the oldest post we have (t.me/s/…?before=…), up to `pages` × ~20 posts, each read like a new one. */
export async function collectArchive(handle: string, pages = 5): Promise<number> {
  const min = Number((await pool.query<{ m: number | null }>('SELECT min(post_id) AS m FROM tg_posts WHERE handle = $1', [handle])).rows[0]?.m || 0);
  if (!min) return 0;
  const posts: PagePost[] = [];
  let before = min;
  for (let i = 0; i < pages && before > 1; i++) {
    const page = await fetchChannelPage(handle, before).catch(() => null);
    const got = (page?.posts || []).filter((p) => p.id < before && (p.text || p.photos.length || p.poll));
    if (!got.length) break;
    posts.push(...got);
    before = Math.min(...got.map((p) => p.id));
    await new Promise((ok) => setTimeout(ok, 1_500));
  }
  if (!posts.length) return 0;
  const sorted = posts.sort((a, b) => a.id - b.id);
  progress.set(handle, { total: sorted.length, done: 0, kind: 'archive' });
  try {
    const ctx = await channelCtx(handle, undefined, sorted[0].at);
    if (ctx) for (const post of sorted) await handlePost(ctx, post, false);
    await settleTgTips().catch(() => 0);
  } finally { progress.delete(handle); }
  return sorted.length;
}

/** A channel with no posts for 14 days is paused (not a test one the admin added): the reads would cost for nothing. */
export async function pauseSilent(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE tg_channels SET paused = true, auto_paused = 'Без нових постів 14 днів' WHERE NOT paused AND last_post_at < now() - interval '14 days' AND created_at < now() - interval '1 day'`);
  return rowCount || 0;
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
/** Results of the tips: our own check (series, maps, express legs) — see tgVerify. */
export async function settleTgTips(): Promise<number> {
  return verifyTips();
}

let running = false;
/** One pass: sync users' channels, read every channel that is not paused or blocked, settle tips. */
export async function tgCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await syncUserChannels().catch(() => {});
    await pauseSilent().catch(() => 0);
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
