import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === 'production';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: isProduction ? 10_000 : 5_000,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  // ^ NOTE: set DB_CA_CERT env var for Railway/Render hosted PG,
  // then switch to: ssl: isProduction ? { rejectUnauthorized: true, ca: process.env.DB_CA_CERT } : undefined,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

export const db = drizzle(pool, { schema });
export { schema };
