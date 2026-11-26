/**
 * Private channels (t.me/+… invites), read through a Telegram account of ours (MTProto, the «telegram» package).
 * Off until the admin sets three keys in Railway: TG_API_ID and TG_API_HASH (my.telegram.org → API development tools)
 * and TG_SESSION (made once on a computer: `npx tsx scripts/tgLogin.ts`, it asks the phone number and the code Telegram sends).
 * Use a separate account, not a personal one: Telegram may limit an account that joins many channels.
 * A private channel is stored as handle «priv-<id>»; its screenshots as «tgacc://<id>/<message id>», downloaded through the account.
 */
import { createHmac } from 'crypto';
import type { TgPage } from './tgPostParser';

type Client = import('telegram').TelegramClient;
let client: Promise<Client> | null = null;

export const accountEnabled = () => !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);
export const accountStats = { lastError: null as string | null, connectedAt: null as string | null };

async function getClient(): Promise<Client> {
  if (!accountEnabled()) throw new Error('Акаунт Telegram не підключено (TG_API_ID, TG_API_HASH, TG_SESSION)');
  if (!client) {
    client = (async () => {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const c = new TelegramClient(new StringSession(process.env.TG_SESSION), Number(process.env.TG_API_ID), String(process.env.TG_API_HASH), { connectionRetries: 3 });
      c.setLogLevel('error' as never);
      await c.connect();
      if (!(await c.checkAuthorization())) throw new Error('Сесія Telegram недійсна — створіть TG_SESSION заново');
      await c.getDialogs({ limit: 200 }); // the account's channels → their access hashes are known
      accountStats.connectedAt = new Date().toISOString(); accountStats.lastError = null;
      return c;
    })();
    client.catch((e: Error) => { accountStats.lastError = e.message.slice(0, 200); client = null; });
  }
  return client;
}

/** «https://t.me/+AbCd…», «t.me/joinchat/AbCd…» → «AbCd…». */
export function inviteHash(link: string | null | undefined): string | null {
  const m = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{10,})/i.exec(String(link || '').trim()) || /^\+([\w-]{10,})$/.exec(String(link || '').trim());
  return m ? m[1] : null;
}
export const privateHandle = (id: string | number) => `priv-${id}`;
export const privateId = (handle: string) => (handle.startsWith('priv-') ? handle.slice(5) : null);

/** What the invite leads to, without joining: title, members, already joined or not. */
export async function inviteInfo(hash: string): Promise<{ title: string; subscribers: number | null; id: string | null; joined: boolean }> {
  const { Api } = await import('telegram');
  const c = await getClient();
  const r = await c.invoke(new Api.messages.CheckChatInvite({ hash }));
  if (r instanceof Api.ChatInviteAlready || r instanceof Api.ChatInvitePeek) {
    const ch = r.chat as { id: { toString(): string }; title?: string; participantsCount?: number };
    return { title: ch.title || 'Приватний канал', subscribers: ch.participantsCount ?? null, id: ch.id.toString(), joined: r instanceof Api.ChatInviteAlready };
  }
  const inv = r as { title?: string; participantsCount?: number };
  return { title: inv.title || 'Приватний канал', subscribers: inv.participantsCount ?? null, id: null, joined: false };
}

/** The account joins the channel by its invite (the admin asked to add it); its id. */
export async function joinInvite(hash: string): Promise<{ id: string; title: string; subscribers: number | null }> {
  const { Api } = await import('telegram');
  const c = await getClient();
  const info = await inviteInfo(hash);
  if (info.joined && info.id) return { id: info.id, title: info.title, subscribers: info.subscribers };
  const r = await c.invoke(new Api.messages.ImportChatInvite({ hash })) as { chats?: { id: { toString(): string }; title?: string; participantsCount?: number }[] };
  const ch = r.chats?.[0];
  if (!ch) throw new Error('Telegram не пустив у канал — можливо, потрібне схвалення адміна каналу');
  await c.getDialogs({ limit: 50 });
  return { id: ch.id.toString(), title: ch.title || info.title, subscribers: ch.participantsCount ?? info.subscribers };
}

type Msg = { id: number; date: number; message?: string; groupedId?: { toString(): string } | null; media?: unknown; photo?: unknown };
/** The channel's newest ~30 posts (or the ones before `before`), in the shape of a t.me/s page: an album is one post with all its photos. */
export async function fetchPrivatePage(id: string, before?: number): Promise<TgPage> {
  const { Api } = await import('telegram');
  const c = await getClient();
  const peer = await c.getEntity(new Api.PeerChannel({ channelId: BigInt(id) as never }));
  const p = peer as { title?: string; participantsCount?: number };
  const msgs = (await c.getMessages(peer, { limit: 30, ...(before ? { offsetId: before } : {}) })) as unknown as Msg[];
  const posts: TgPage['posts'] = [];
  const byGroup = new Map<string, TgPage['posts'][number]>();
  for (const m of [...msgs].sort((a, b) => a.id - b.id)) {
    if (!m?.id || !m.date) continue;
    const photo = !!m.photo || m.media instanceof Api.MessageMediaPhoto;
    const poll = m.media instanceof Api.MessageMediaPoll;
    const g = m.groupedId ? m.groupedId.toString() : null;
    const prev = g ? byGroup.get(g) : undefined;
    if (prev) { if (photo) prev.photos.push(`tgacc://${id}/${m.id}`); if (m.message && !prev.text) prev.text = m.message; continue; }
    const post = { id: m.id, at: new Date(m.date * 1000).toISOString(), text: m.message || '', photos: photo ? [`tgacc://${id}/${m.id}`] : [], poll };
    posts.push(post);
    if (g) byGroup.set(g, post);
  }
  return { title: p.title || null, subscribers: p.participantsCount ?? null, posts, isPublic: true };
}

const media = new Map<string, Buffer>(); // the last ~150 screenshots
/** A screenshot of a private channel («tgacc://<id>/<msg>»), downloaded through the account. */
export async function accountMedia(url: string): Promise<Buffer | null> {
  const m = /^tgacc:\/\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return null;
  const hit = media.get(url);
  if (hit) return hit;
  try {
    const { Api } = await import('telegram');
    const c = await getClient();
    const peer = await c.getEntity(new Api.PeerChannel({ channelId: BigInt(m[1]) as never }));
    const [msg] = await c.getMessages(peer, { ids: [Number(m[2])] });
    const buf = msg ? await c.downloadMedia(msg) as Buffer | undefined : undefined;
    if (!buf || !Buffer.isBuffer(buf)) return null;
    media.set(url, buf);
    if (media.size > 150) media.delete(media.keys().next().value as string);
    return buf;
  } catch (e) { accountStats.lastError = (e as Error).message.slice(0, 200); return null; }
}

/** A signed link the admin's browser can open for a private screenshot: /api/tg-media/<id>/<msg>?s=… */
const secret = () => process.env.JWT_SECRET || process.env.TG_API_HASH || 'tg';
export const mediaSig = (id: string, msg: string) => createHmac('sha256', secret()).update(`${id}/${msg}`).digest('hex').slice(0, 24);
export function mediaLink(url: string, origin: string): string {
  const m = /^tgacc:\/\/(\d+)\/(\d+)$/.exec(url);
  return m ? `${origin}/api/tg-media/${m[1]}/${m[2]}?s=${mediaSig(m[1], m[2])}` : url;
}
