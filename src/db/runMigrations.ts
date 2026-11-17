// Run migrations from Drizzle Kit generated SQL files
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Postgres error codes that mean "this schema object already exists".
 * Drizzle-generated migrations are not idempotent (plain `ALTER TABLE … ADD
 * COLUMN` without `IF NOT EXISTS`), so re-running them on an already-applied
 * schema fails. We treat these as "already applied" and skip the statement.
 */
const ALREADY_EXISTS_CODES = new Set([
  '42701', // duplicate_column
  '42P07', // duplicate_table (relation already exists)
  '42710', // duplicate_object (constraint/index already exists)
  '42P16', // multiple primary keys
]);

function splitStatements(sql: string): string[] {
  // Drizzle Kit separates statements with `--> statement-breakpoint`.
  return sql
    .split(/-->\s*statement-breakpoint/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate() {
  const needsSsl =
    !!process.env.DATABASE_URL &&
    !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    // Create migrations table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drizzle_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, 'migrations');
    let files: string[] = [];
    try { files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort(); } catch {}

    if (files.length === 0) {
      console.log('No migration files found. Run: npx drizzle-kit generate');
      process.exit(0);
    }

    const { rows: applied } = await pool.query('SELECT name FROM drizzle_migrations');

    for (const file of files) {
      if (applied.some((r: any) => r.name === file)) {
        console.log(`  SKIP ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      const statements = splitStatements(sql);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let skipped = 0;
        for (const stmt of statements) {
          await client.query('SAVEPOINT mig_stmt');
          try {
            await client.query(stmt);
            await client.query('RELEASE SAVEPOINT mig_stmt');
          } catch (e: any) {
            await client.query('ROLLBACK TO SAVEPOINT mig_stmt');
            if (ALREADY_EXISTS_CODES.has(e?.code)) {
              skipped++;
              continue;
            }
            throw e;
          }
        }
        await client.query('INSERT INTO drizzle_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  OK ${file}${skipped ? ` (${skipped} statement(s) already applied)` : ''}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    console.log('Migrations complete');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e); process.exit(1); });
