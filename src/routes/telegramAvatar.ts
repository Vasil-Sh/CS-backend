import { Hono } from 'hono';
import { telegramAvatar } from '../services/telegramAvatar';

/** GET /api/telegram-avatar/:handle — the channel photo, or 404 (show initials). Public: ad cards in the app use it too. */
export const telegramAvatarRoutes = new Hono();
telegramAvatarRoutes.get('/:handle', async (c) => {
  const got = await telegramAvatar(c.req.param('handle'));
  if (!got) return c.body(null, 404, { 'Cache-Control': 'public, max-age=600' });
  return c.body(new Uint8Array(got.body), 200, { 'Content-Type': got.type, 'Cache-Control': 'public, max-age=86400' });
});
