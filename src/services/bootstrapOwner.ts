// One-off owner bootstrap — for regaining access when no owner can sign in.
// Set BOOTSTRAP_OWNER_USERNAME in Railway → on start the backend creates that account
// as an owner (admin + is_owner) with a random password and prints the password ONCE to the logs.
// Never touches an account that already exists. Remove the variable afterwards.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db/client';

export async function bootstrapOwner(): Promise<void> {
  const username = (process.env.BOOTSTRAP_OWNER_USERNAME || '').trim();
  if (!username || !process.env.DATABASE_URL) return;
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) { console.warn('[bootstrap-owner] skipped: invalid username'); return; }
  try {
    const exists = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1) LIMIT 1', [username]);
    if (exists.rows.length) { console.log(`[bootstrap-owner] @${username} already exists — nothing changed. Remove BOOTSTRAP_OWNER_USERNAME.`); return; }
    const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (username, password_hash, role, is_owner, telegram, price_month, plan) VALUES ($1, $2, 'admin', true, '', '0', 'trial') RETURNING id`,
      [username, hash],
    );
    await pool.query(
      `INSERT INTO admin_audit_log(actor_id, actor_name, action, target, details, status) VALUES($3, 'system', 'POST', $1, $2, 'success')`,
      [`/admin/users/${r.rows[0].id}`, JSON.stringify({ targetUsername: username, _targetUserId: String(r.rows[0].id), role: 'admin', isOwner: true, source: 'bootstrap-owner' }), r.rows[0].id],
    ).catch(() => {});
    console.log(`[bootstrap-owner] created owner @${username} · password: ${password} · sign in, then remove BOOTSTRAP_OWNER_USERNAME and delete this account when done`);
  } catch (e) {
    console.error('[bootstrap-owner] failed:', (e as Error).message);
  }
}
