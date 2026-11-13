// ═══════════════════════════════════════════
// Payment receipts sent to Telegram — pure helpers (tested separately).
// ═══════════════════════════════════════════

export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the buffer starts with the PNG signature. */
export function isPng(buffer: Uint8Array): boolean {
  return buffer.length > PNG_MAGIC.length && PNG_MAGIC.every((b, i) => buffer[i] === b);
}

/** YYYY-MM-DD → DD.MM.YYYY ('' stays ''). */
export function uaDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Caption under the receipt photo. */
export function receiptCaption(p: { amount: string | number; paidOn: string; periodStart?: string | null; periodEnd?: string | null }): string {
  const amount = Number(p.amount);
  const sum = Number.isFinite(amount)
    ? amount.toLocaleString('uk-UA', { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })
    : String(p.amount);
  const lines = [`Чек MatchIQ · ${sum} ₴`, `Оплата від ${uaDate(p.paidOn)}`];
  if (p.periodStart && p.periodEnd) lines.push(`Підписка: ${uaDate(p.periodStart)} — ${uaDate(p.periodEnd)}`);
  return lines.join('\n');
}

/** Map a Telegram API error to a user-facing message + HTTP status. */
export function telegramErrorMessage(description: string): { status: 409 | 502; message: string } {
  const d = description.toLowerCase();
  if (d.includes('blocked by the user')) return { status: 409, message: 'Користувач заблокував бота — чек не доставлено' };
  if (d.includes('chat not found') || d.includes('user is deactivated')) return { status: 409, message: 'Чат з користувачем не знайдено — попросіть ще раз натиснути /start' };
  return { status: 502, message: `Telegram не прийняв чек: ${description}` };
}
