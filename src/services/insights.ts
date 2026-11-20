// ═══════════════════════════════════════════
// Insights service — persist AI usage, parser failures, support tickets.
// All writes are best-effort (fire-and-forget where appropriate) so a
// missing DB never breaks the calling code path.
// ═══════════════════════════════════════════

import { pool } from '../db/client';

function dbReady(): boolean {
  return !!process.env.DATABASE_URL;
}

// ── AI usage ──────────────────────────────────────────────

export interface AiUsageRecord {
  userId?: number | null;
  provider: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  status?: 'success' | 'error';
}

export async function recordAiUsage(rec: AiUsageRecord): Promise<void> {
  if (!dbReady()) return;
  try {
    await pool.query(
      `INSERT INTO ai_usage(user_id, provider, model, prompt_tokens, completion_tokens, cost, status)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        rec.userId ?? null,
        rec.provider,
        rec.model || '',
        rec.promptTokens ?? 0,
        rec.completionTokens ?? 0,
        rec.cost ?? 0,
        rec.status ?? 'success',
      ],
    );
  } catch (err) {
    console.warn('[insights] recordAiUsage failed:', (err as Error).message);
  }
}

// ── Parser failures ───────────────────────────────────────

/** Last persisted failure per source, to throttle repeated identical errors. */
const lastFailure = new Map<string, { message: string; at: number }>();
const FAILURE_THROTTLE_MS = 60_000; // collapse identical failures within 1 min

export function recordParserFailure(source: string, message = ''): void {
  if (!dbReady()) return;
  const key = source;
  const prev = lastFailure.get(key);
  const now = Date.now();
  if (prev && prev.message === message && now - prev.at < FAILURE_THROTTLE_MS) return;
  lastFailure.set(key, { message, at: now });

  // Fire-and-forget: never block the scraper.
  void pool
    .query(`INSERT INTO parser_failures(source, message) VALUES($1,$2)`, [source, message.slice(0, 2000)])
    .catch((err) => console.warn('[insights] recordParserFailure failed:', (err as Error).message));
}

// ── Support tickets ───────────────────────────────────────

export interface SupportTicketInput {
  userId?: number | null;
  username?: string;
  subject: string;
  message: string;
  kind?: 'problem' | 'idea' | 'question';
  meta?: Record<string, string>;
}

export async function createSupportTicket(input: SupportTicketInput): Promise<number> {
  if (!dbReady()) throw new Error('Database not configured');
  const result = await pool.query(
    `INSERT INTO support_tickets(user_id, username, subject, message, kind, meta)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text AS id`,
    [input.userId ?? null, input.username || '', input.subject, input.message, input.kind || 'problem', JSON.stringify(input.meta || {})],
  );
  return Number(result.rows[0].id);
}
