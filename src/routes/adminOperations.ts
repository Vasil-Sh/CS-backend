import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/client';

const ops = new Hono();

// ═══════════════════════════════════════════
// Promo codes (admin)
// ═══════════════════════════════════════════

ops.get('/admin/promo-codes', requireAuth, requireAdmin, async (c) => {
  const result = await pool.query(
    `SELECT id::text, code, discount_percent AS "discountPercent", plan,
            starts_on::text AS "startsOn", ends_on::text AS "endsOn",
            usage_limit AS "usageLimit", used_count AS "usedCount",
            active, created_at AS "createdAt"
     FROM promo_codes ORDER BY created_at DESC`,
  );
  return c.json({ promoCodes: result.rows });
});

ops.post('/admin/promo-codes', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.code !== 'string' || !b.code.trim() || b.code.length > 100) return c.json({ error: 'Код — обовʼязковий (до 100 символів)' }, 400);
  const discount = Number(b.discountPercent);
  if (!Number.isInteger(discount) || discount <= 0 || discount > 100) return c.json({ error: 'Знижка — ціле число від 1 до 100' }, 400);
  const plan = ['trial', 'basic', 'pro'].includes(b.plan) ? b.plan : 'basic';
  try {
    const result = await pool.query(
      `INSERT INTO promo_codes(code, discount_percent, plan, starts_on, ends_on, usage_limit)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [b.code.trim().toUpperCase(), discount, plan, b.startsOn || null, b.endsOn || null, b.usageLimit ? Number(b.usageLimit) : null],
    );
    return c.json({ id: result.rows[0].id }, 201);
  } catch (e: any) {
    if (e?.code === '23505') return c.json({ error: 'Такий код уже існує' }, 409);
    throw e;
  }
});

ops.put('/admin/promo-codes/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid promo code' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'Invalid body' }, 400);
  const sets: string[] = [];
  const params: any[] = [];
  if (b.discountPercent !== undefined) {
    const d = Number(b.discountPercent);
    if (!Number.isInteger(d) || d <= 0 || d > 100) return c.json({ error: 'Знижка — ціле число від 1 до 100' }, 400);
    params.push(d); sets.push(`discount_percent=$${params.length}`);
  }
  if (b.plan !== undefined) {
    if (!['trial', 'basic', 'pro'].includes(b.plan)) return c.json({ error: 'Invalid plan' }, 400);
    params.push(b.plan); sets.push(`plan=$${params.length}`);
  }
  if (b.startsOn !== undefined) { params.push(b.startsOn || null); sets.push(`starts_on=$${params.length}`); }
  if (b.endsOn !== undefined) { params.push(b.endsOn || null); sets.push(`ends_on=$${params.length}`); }
  if (b.usageLimit !== undefined) { params.push(b.usageLimit ? Number(b.usageLimit) : null); sets.push(`usage_limit=$${params.length}`); }
  if (b.active !== undefined) { params.push(Boolean(b.active)); sets.push(`active=$${params.length}`); }
  if (!sets.length) return c.json({ error: 'Немає полів для оновлення' }, 400);
  params.push(id);
  await pool.query(`UPDATE promo_codes SET ${sets.join(', ')}, updated_at=now() WHERE id::text=$${params.length}`, params);
  return c.json({ success: true });
});

ops.delete('/admin/promo-codes/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid promo code' }, 400);
  await pool.query('DELETE FROM promo_codes WHERE id::text=$1', [id]);
  return c.json({ success: true });
});

// Validate a promo code (used by the payment form to apply a discount).
ops.post('/admin/promo-codes/validate', requireAuth, requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.code !== 'string' || !b.code.trim()) return c.json({ error: 'Код — обовʼязковий' }, 400);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const result = await pool.query(
    `SELECT id::text, code, discount_percent AS "discountPercent", plan,
            usage_limit AS "usageLimit", used_count AS "usedCount", active,
            starts_on::text AS "startsOn", ends_on::text AS "endsOn"
     FROM promo_codes WHERE UPPER(code)=UPPER($1)`,
    [b.code.trim()],
  );
  const row = result.rows[0];
  if (!row) return c.json({ valid: false, error: 'Код не знайдено' }, 404);
  if (!row.active) return c.json({ valid: false, error: 'Код неактивний' }, 400);
  if (row.startsOn && row.startsOn > today) return c.json({ valid: false, error: 'Код ще не діє' }, 400);
  if (row.endsOn && row.endsOn < today) return c.json({ valid: false, error: 'Термін дії коду закінчився' }, 400);
  if (row.usageLimit != null && Number(row.usedCount) >= Number(row.usageLimit)) return c.json({ valid: false, error: 'Ліміт використань вичерпано' }, 400);
  return c.json({ valid: true, promoCode: row });
});

// ═══════════════════════════════════════════
// Self-limitation requests
// ═══════════════════════════════════════════

// User submits a self-limitation request.
ops.post('/self-limitation', requireAuth, async (c) => {
  const b = await c.req.json().catch(() => null);
  const days = Number(b?.periodDays);
  if (!b || !Number.isInteger(days) || days <= 0 || days > 365) return c.json({ error: 'Вкажіть період від 1 до 365 днів' }, 400);
  const reason = typeof b.reason === 'string' && b.reason.length <= 500 ? b.reason.trim() : '';
  const user = c.get('user');
  // Applied at once: the account is blocked for the chosen period and nobody can lift it early.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO self_limitation_requests(user_id, username, period_days, reason, status, decided_at, decided_by)
       VALUES($1,$2,$3,$4,'applied',now(),'auto') RETURNING id::text, decided_at + ($3 || ' days')::interval AS until`,
      [user.userId, user.username, days, reason],
    );
    await client.query(
      `INSERT INTO tilt_blocks(user_id, until, reason, strategy_name) VALUES($1, now() + ($2 || ' days')::interval, 'Самообмеження користувача', '')`,
      [user.userId, days],
    );
    // Paid days are not lost: an active subscription moves by the length of the block.
    await client.query(
      `UPDATE users SET end_date = end_date + $2::int WHERE id = $1 AND role <> 'admin' AND end_date >= (now() AT TIME ZONE 'Europe/Kyiv')::date`,
      [user.userId, days],
    );
    await client.query('COMMIT');
    return c.json({ id: result.rows[0].id, until: new Date(result.rows[0].until).toISOString() }, 201);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// Admin lists self-limitation requests.
ops.get('/admin/self-limitations', requireAuth, requireAdmin, async (c) => {
  const status = c.req.query('status') || '';
  if (status && !['new', 'applied', 'denied'].includes(status)) return c.json({ error: 'Invalid status' }, 400);
  const where = status ? 'WHERE status=$1' : '';
  const params = status ? [status] : [];
  const result = await pool.query(
    `SELECT r.id::text, r.user_id AS "userId", r.username, r.period_days AS "periodDays",
            r.reason, r.status, r.created_at AS "createdAt", r.decided_at AS "decidedAt", r.decided_by AS "decidedBy",
            CASE WHEN r.status='applied' THEN COALESCE(r.decided_at, r.created_at) + (r.period_days || ' days')::interval END AS until,
            u.plan, u.telegram
     FROM self_limitation_requests r LEFT JOIN users u ON u.id = r.user_id ${where.replace('status', 'r.status')} ORDER BY r.created_at DESC LIMIT 200`,
    params,
  );
  return c.json({ requests: result.rows });
});

// Admin approves (applies a tilt block) or denies a request.
ops.patch('/admin/self-limitations/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id') || '';
  if (!/^\d+$/.test(id)) return c.json({ error: 'Invalid request' }, 400);
  const b = await c.req.json().catch(() => null);
  const status = b?.status;
  if (!['applied', 'denied'].includes(status)) return c.json({ error: 'Status must be applied or denied' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const req = await client.query('SELECT * FROM self_limitation_requests WHERE id::text=$1 FOR UPDATE', [id]);
    if (!req.rows.length) { await client.query('ROLLBACK'); return c.json({ error: 'Запит не знайдено' }, 404); }
    const r = req.rows[0];
    if (r.status !== 'new') { await client.query('ROLLBACK'); return c.json({ success: true }); }
    const actor = c.get('user');
    await client.query('UPDATE self_limitation_requests SET status=$2, decided_at=now(), decided_by=$3 WHERE id::text=$1', [id, status, actor.username]);
    if (status === 'applied') {
      await client.query(
        `INSERT INTO tilt_blocks(user_id, until, reason, strategy_name)
         VALUES($1, now() + ($2 || ' days')::interval, $3, '')`,
        [r.user_id, r.period_days, 'Самообмеження користувача'],
      );
    }
    await client.query(
      `INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status)
       VALUES($1,$2,'PATCH',$3,$4,'success')`,
      [actor.userId, actor.username, `/admin/self-limitations/${id}`, JSON.stringify({ targetUsername: r.username, _targetUserId: String(r.user_id), periodDays: r.period_days, decision: status })],
    );
    await client.query('COMMIT');
    return c.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

export default ops;
