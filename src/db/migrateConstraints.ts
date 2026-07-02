/**
 * Run idempotent migrations (safe to run multiple times).
 * Usage: npx tsx src/db/migrateConstraints.ts
 */
import 'dotenv/config';
import { pool } from './client';
import fs from 'fs';
import path from 'path';

async function runMigrations() {
  const client = await pool.connect();
  try {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'src', 'db', 'migrations', '0001_check_constraints.sql'),
      'utf-8',
    );
    console.log('Running migrations...');
    await client.query(sql);
    console.log('✅ CHECK constraints + indexes applied successfully');
  } catch (e: any) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    // Don't call pool.end() — server may reuse the pool
  }
}

runMigrations();
