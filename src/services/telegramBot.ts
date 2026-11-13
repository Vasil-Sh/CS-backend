// ═══════════════════════════════════════════
// Telegram Bot Webhook Service
// Replaces Google Apps Script telegram-bot.gs
// ═══════════════════════════════════════════

interface ParsedBet {
  team1: string;
  team2: string;
  odds: string;
  match: string;
}

interface TelegramMessage {
  chat: { id: number; title?: string; type?: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  date: number;
}

class TelegramBotService {
  private botToken: string;
  private adminChatId: string;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
  }

  isConfigured(): boolean {
    return !!this.botToken && this.botToken.length > 10;
  }

  async processUpdate(update: { message?: TelegramMessage; channel_post?: TelegramMessage }): Promise<{
    parsed: ParsedBet | null;
    rawText: string;
  }> {
    const msg = update.message || update.channel_post;
    if (!msg) return { parsed: null, rawText: '' };

    const text = msg.text || msg.caption || '';
    if (!text.trim()) return { parsed: null, rawText: '' };

    const parsed = this.parseBetMessage(text);

    if (parsed) {
      await this.notifyAdmin(
        `✅ Ставку розпізнано з "${msg.chat.title || 'DM'}":\n${parsed.match} @ ${parsed.odds}`
      );
    } else {
      await this.notifyAdmin(
        `⚠️ Не розпізнано з "${msg.chat.title || 'DM'}":\n${text.substring(0, 100)}`
      );
    }

    return { parsed, rawText: text };
  }

  /** Parse betting info from Telegram message text */
  parseBetMessage(text: string): ParsedBet | null {
    if (!text.trim()) return null;

    let team1 = '';
    let team2 = '';
    let odds = '';

    // Strip emojis
    const clean = text
      .replace(
        /[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}]/gu,
        ''
      )
      .trim();

    // Pattern 1: "Team1 vs Team2" / "Team1 — Team2"
    let vsMatch = clean.match(
      /(.+?)\s+(?:vs\.?|VS\.?|против|—|–|-)\s+(.+)/i
    );
    if (!vsMatch) vsMatch = clean.match(/(.+?)\s*\/\s*(.+)/);
    if (!vsMatch)
      vsMatch = clean.match(
        /([A-Z][\w\s.]{2,25})\s{2,}([A-Z][\w\s.]{2,25})/
      );

    if (vsMatch) {
      team1 = vsMatch[1].trim();
      team2 = vsMatch[2].trim();
    }

    // Extract odds
    const oddsMatch = clean.match(
      /(?:кое?ф|odds?|@|кф\.?)\s*[:=]?\s*(\d+[.,]\d+)|\b(\d+[.,]\d{2})\b(?!\s*(?:%|процент))/i
    );
    if (oddsMatch) {
      odds = (oddsMatch[1] || oddsMatch[2]).replace(',', '.');
    } else {
      const lastNum = clean.match(/(\d+[.,]\d{2})\s*$/);
      if (
        lastNum &&
        parseFloat(lastNum[1]) >= 1.01 &&
        parseFloat(lastNum[1]) <= 20
      ) {
        odds = lastNum[1].replace(',', '.');
      }
    }

    const matchStr =
      team1 && team2 ? `${team1} vs ${team2}` : clean.substring(0, 80);

    return { team1, team2, odds, match: matchStr };
  }

  /** Send notification to admin via Telegram */
  async notifyAdmin(message: string): Promise<void> {
    if (!this.isConfigured() || !this.adminChatId) return;

    try {
      await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.adminChatId,
            text: `🤖 MatchIQ Bot:\n${message}`,
            parse_mode: 'HTML',
          }),
        }
      );
    } catch {
      // Silently fail — notifications are non-critical
    }
  }

  /**
   * Send a photo (PNG receipt) to a user's private chat.
   * Returns 'ok' on success, or throws with a Telegram API error string.
   */
  async sendPhoto(chatId: number | string, photoBuffer: Buffer, caption: string): Promise<void> {
    if (!this.isConfigured()) throw new Error('TELEGRAM_BOT_TOKEN not configured');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('photo', new Blob([photoBuffer], { type: 'image/png' }), 'receipt.png');
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.description || `Telegram API error ${res.status}`);
    }
  }

  /** Reply to a private chat message (used for /start greeting). */
  async sendMessage(chatId: number | string, text: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML' }),
      });
    } catch {
      // non-critical
    }
  }

  /**
   * Extract a deep-link token from a /start command.
   * Telegram deep links look like `/start <token>`.
   */
  parseStartToken(text: string): { token: string | null; isStart: boolean } {
    const m = text.trim().match(/^\/start(?:\s+([^\s]+))?/i);
    if (!m) return { token: null, isStart: false };
    return { token: m[1] ?? null, isStart: true };
  }
}

export const telegramBotService = new TelegramBotService();
