import { Hono } from 'hono';
import { pool } from '../db/client';
import { telegramBotService } from '../services/telegramBot';

const telegram = new Hono();

// ── POST /api/telegram/webhook ──
// This replaces the Google Apps Script webhook.
// Set webhook: POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_SERVER>/api/telegram/webhook
telegram.post('/webhook', async (c) => {
  // Validate Telegram secret token (required)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Telegram] TELEGRAM_WEBHOOK_SECRET not configured — webhook disabled');
    return c.json({ error: 'Webhook not configured' }, 503);
  }
  const token = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (token !== secret) return c.json({ error: 'Unauthorized' }, 401);

  if (!telegramBotService.isConfigured()) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 503);
  }

  try {
    const update = await c.req.json();
    const msg = update.message || update.channel_post;

    // ── /start: capture the user's chat id for future receipts ──
    if (msg?.text) {
      const { isStart, token } = telegramBotService.parseStartToken(msg.text);
      if (isStart && msg.chat?.id > 0) {
        const chatId = msg.chat.id;
        // Match by deep-link token (username) or the sender's @username.
        const handle = token || msg.from?.username || null;
        if (handle) {
          await pool.query(
            `UPDATE users SET telegram_chat_id=$1, updated_at=now()
             WHERE telegram=$2 OR username=$2`,
            [chatId, handle],
          ).catch((e) => console.warn('[Telegram] /start link failed:', (e as Error).message));
        }
        await telegramBotService.sendMessage(
          chatId,
          '👋 Привіт! Бот MatchIQ підключено. Чеки надходитимуть сюди.',
        );
        return c.json({ ok: true });
      }
    }

    const result = await telegramBotService.processUpdate(update);

    return c.json({
      ok: true,
      parsed: result.parsed,
    });
  } catch (err: any) {
    console.error('[Telegram] Webhook error:', err.message);
    // Always return 200 to Telegram to prevent retry floods
    return c.json({ ok: false, error: err.message });
  }
});

export default telegram;
