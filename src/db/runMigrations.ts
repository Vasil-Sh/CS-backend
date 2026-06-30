// Run migrations from Drizzle Kit generated SQL files
import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query('INSERT INTO drizzle_migrations (name) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`  OK ${file}`);
    }

    console.log('Migrations complete');
  } finally {
    await pool.end();
  }
}

migrate().catch(e => { console.error(e); process.exit(1); });
