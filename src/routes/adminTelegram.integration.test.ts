import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db/client', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../services/auditLog', () => ({ recordAudit: vi.fn().mockResolvedValue('1') }));
vi.mock('../services/telegramBot', () => ({
  telegramBotService: { isConfigured: vi.fn(() => true), sendPhoto: vi.fn().mockResolvedValue(undefined) },
}));

import adminPayments from './adminPayments';
import adminTelegramGroups from './adminTelegramGroups';
import { pool } from '../db/client';
import { recordAudit } from '../services/auditLog';
import { telegramBotService } from '../services/telegramBot';

const query = vi.mocked(pool.query) as unknown as ReturnType<typeof vi.fn>;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GROUP = '11111111-2222-4333-8444-555555555555';

function app(role = 'admin') {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('user', { userId: 1, username: 'boss', role } as never); await next(); });
  a.route('/', adminPayments);
  a.route('/', adminTelegramGroups);
  return a;
}
function receiptForm(bytes: Uint8Array = PNG) {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: 'image/png' }), 'receipt.png');
  return form;
}
const payment = { id: '7', amount: '600', paidOn: '2026-11-08', periodStart: '2026-11-08', periodEnd: '2026-12-07', status: 'recorded', userId: 5, username: 'maksym_k', chatId: 123456 };

beforeEach(() => { vi.clearAllMocks(); query.mockReset(); vi.mocked(telegramBotService.isConfigured).mockReturnValue(true); });

describe('POST /admin/payments/:id/receipt/send', () => {
  it('sends the PNG to the user chat and writes the audit log', async () => {
    query.mockResolvedValueOnce({ rows: [payment] });
    const res = await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm() });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const [chatId, buffer, caption] = vi.mocked(telegramBotService.sendPhoto).mock.calls[0];
    expect(chatId).toBe(123456);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(caption).toContain('600 ₴');
    expect(vi.mocked(recordAudit).mock.calls[0][2]).toBe('/admin/payments/7/receipt/send');
  });
  it('rejects non-admins', async () => {
    expect((await app('user').request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm() })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('requires a PNG photo', async () => {
    expect((await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: new FormData() })).status).toBe(400);
    expect((await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])) })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses when the user has not started the bot', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...payment, chatId: null }] });
    const res = await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm() });
    expect(res.status).toBe(409);
    expect(telegramBotService.sendPhoto).not.toHaveBeenCalled();
  });
  it('does not send cancelled payments', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...payment, status: 'cancelled' }] });
    expect((await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm() })).status).toBe(409);
  });
  it('returns 404 for an unknown payment', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await app().request('/admin/payments/99/receipt/send', { method: 'POST', body: receiptForm() })).status).toBe(404);
  });
  it('reports Telegram failures without writing the audit log', async () => {
    query.mockResolvedValueOnce({ rows: [payment] });
    vi.mocked(telegramBotService.sendPhoto).mockRejectedValueOnce(new Error('Forbidden: bot was blocked by the user'));
    const res = await app().request('/admin/payments/7/receipt/send', { method: 'POST', body: receiptForm() });
    expect(res.status).toBe(409);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('Telegram group moderation', () => {
  it('lists groups with status counts', async () => {
    // the route loads every group once and counts / filters in memory (2nd query = bet stats)
    query
      .mockResolvedValueOnce({ rows: [
        { id: GROUP, name: 'CS2 Prognoz', link: 'https://t.me/cs2prognoz', moderationStatus: 'pending' },
        { id: 'g2', name: 'Dota Daily', link: 'https://t.me/dotadaily', moderationStatus: 'approved' },
      ] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await app().request('/admin/telegram-groups?status=pending&q=cs2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].name).toBe('CS2 Prognoz');
    expect(body.counts).toMatchObject({ pending: 1, approved: 1, rejected: 0, all: 2 });
  });
  it('validates the status filter', async () => {
    expect((await app().request('/admin/telegram-groups?status=bogus')).status).toBe(400);
  });
  it('approves a group and audits it', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'pending', name: 'CS2 Prognoz', userId: 5, username: 'maksym_k' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await app().request(`/admin/telegram-groups/${GROUP}/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([GROUP, 'approved', 'boss', null]);
    expect(vi.mocked(recordAudit).mock.calls[0][2]).toBe(`/admin/telegram-groups/${GROUP}/approve`);
  });
  it('requires a reason to reject', async () => {
    const res = await app().request(`/admin/telegram-groups/${GROUP}/reject`, { method: 'POST', body: JSON.stringify({ reason: ' ' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects with a reason', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'pending', name: 'VIP', userId: 5, username: 'nazar_k' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await app().request(`/admin/telegram-groups/${GROUP}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'договірні матчі' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([GROUP, 'rejected', 'boss', 'договірні матчі']);
  });
  it('returns 404 for an unknown group and 400 for a bad id', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await app().request(`/admin/telegram-groups/${GROUP}/approve`, { method: 'POST' })).status).toBe(404);
    expect((await app().request('/admin/telegram-groups/1;drop/approve', { method: 'POST' })).status).toBe(400);
  });
  it('is admin-only', async () => {
    expect((await app('user').request('/admin/telegram-groups')).status).toBe(403);
  });
});
