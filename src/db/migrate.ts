import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const db = drizzle(pool, { schema });

  // Create tables
  // In production, use drizzle-kit generate + migrate
  // This is for quick dev setup
  console.log('✅ Run: npx drizzle-kit push');
  console.log('   Or: npx drizzle-kit generate && npx tsx src/db/migrate.ts');

  await pool.end();
}

main().catch(console.error);
