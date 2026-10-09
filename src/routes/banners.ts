import { Hono } from 'hono';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { bannerService, type BannerInput } from '../services/bannerService';

const banners = new Hono();

const BANNER_DIR = join(process.cwd(), '.cache', 'banners');

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function ensureDir() {
  mkdirSync(BANNER_DIR, { recursive: true });
}

/** Map a DB row to the public campaign shape used by the frontend. */
const toCampaign = (b: {
  id: number;
  active: boolean;
  title: string;
  description: string | null;
  imageUrl: string | null;
  href: string | null;
}) => ({
  id: String(b.id),
  active: b.active,
  title: b.title,
  description: b.description || '',
  imageUrl: b.imageUrl || '',
  href: b.href || '',
});

/** GET /banners/active — active campaigns for the public schedule (no auth). */
banners.get('/active', async (c) => {
  try {
    const rows = await bannerService.listActive();
    return c.json({ banners: rows.map(toCampaign) });
  } catch (err: unknown) {
    console.error('[Banners/Active] Error:', (err as Error).message);
    return c.json({ error: 'Failed to fetch banners' }, 500);
  }
});

/** GET /banners — all banners (admin). */
banners.get('/', requireAuth, requireAdmin, async (c) => {
  try {
    const rows = await bannerService.list();
    return c.json({ banners: rows.map(toCampaign) });
  } catch (err: unknown) {
    console.error('[Banners/List] Error:', (err as Error).message);
    return c.json({ error: 'Failed to fetch banners' }, 500);
  }
});

/** POST /banners — create a banner (admin). */
banners.post('/', requireAuth, requireAdmin, async (c) => {
  let body: Partial<BannerInput>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  const title = (body.title || '').trim();
  if (!title || title.length > 200) {
    return c.json({ error: 'Назва банера обовʼязкова (до 200 символів)' }, 400);
  }
  try {
    const banner = await bannerService.create({
      active: body.active ?? false,
      title,
      description: body.description || '',
      imageUrl: body.imageUrl || '',
      href: body.href || '',
    });
    return c.json(toCampaign(banner), 201);
  } catch (err: unknown) {
    console.error('[Banners/Create] Error:', (err as Error).message);
    return c.json({ error: 'Failed to create banner' }, 500);
  }
});

/** PUT /banners/:id — update a banner (admin). */
banners.put('/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  let body: Partial<BannerInput>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  if (body.title !== undefined && !(body.title || '').trim()) {
    return c.json({ error: 'Назва банера не може бути порожньою' }, 400);
  }
  try {
    const banner = await bannerService.update(id, {
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
      ...(body.href !== undefined ? { href: body.href } : {}),
    });
    if (!banner) return c.json({ error: 'Banner not found' }, 404);
    return c.json(toCampaign(banner));
  } catch (err: unknown) {
    console.error('[Banners/Update] Error:', (err as Error).message);
    return c.json({ error: 'Failed to update banner' }, 500);
  }
});

/** DELETE /banners/:id — delete a banner (admin). */
banners.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id') || '', 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  try {
    await bannerService.remove(id);
    return c.json({ success: true });
  } catch (err: unknown) {
    console.error('[Banners/Delete] Error:', (err as Error).message);
    return c.json({ error: 'Failed to delete banner' }, 500);
  }
});

/** POST /banners/upload — upload a banner image (base64) and get a public URL. */
banners.post('/upload', requireAuth, requireAdmin, async (c) => {
  let body: { data?: string; mime?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  const raw = (body.data || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) return c.json({ error: 'No image data' }, 400);
  const mime = body.mime || 'image/png';
  const ext = MIME_EXT[mime] || 'png';
  ensureDir();
  const filename = `${Date.now()}_${randomBytes(4).toString('hex')}.${ext}`;
  writeFileSync(join(BANNER_DIR, filename), Buffer.from(raw, 'base64'));
  return c.json({ url: `/api/v1/banners/file/${filename}` }, 201);
});

/** GET /banners/file/:filename — serve an uploaded banner image (public). */
banners.get('/file/:filename', (c) => {
  const filename = c.req.param('filename');
  if (
    !filename ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return c.json({ error: 'Invalid filename' }, 400);
  }
  const filePath = join(BANNER_DIR, filename);
  if (!existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const ext = filename.split('.').pop()?.toLowerCase() || 'png';
  const ct = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return new Response(readFileSync(filePath), {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

export default banners;
