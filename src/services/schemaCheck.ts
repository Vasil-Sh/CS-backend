// Compares the live database with the Drizzle schema in code and reports what is missing.
// Run on start (logged once) and available to the owner at GET /admin/schema-check.
// Read-only: it never changes the database.
import { is, SQL } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';
import { pool } from '../db/client';

export interface SchemaGap { table: string; column?: string; type?: string; sql?: string }

function defaultSql(col: any): string {
  const d = col.default;
  if (d === undefined || d === null) return '';
  if (is(d, SQL)) return ''; // expression defaults (now(), CURRENT_DATE…) — set by hand in the migration
  if (typeof d === 'number' || typeof d === 'boolean') return ` DEFAULT ${d}`;
  if (typeof d === 'string') return ` DEFAULT '${d.replace(/'/g, "''")}'`;
  if (typeof d === 'object') return ` DEFAULT '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  return '';
}

export async function checkSchema(): Promise<SchemaGap[]> {
  const live = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const have = new Map<string, Set<string>>();
  for (const r of live.rows) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name)!.add(r.column_name);
  }
  const gaps: SchemaGap[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value as PgTable);
    const cols = have.get(cfg.name);
    if (!cols) { gaps.push({ table: cfg.name }); continue; }
    for (const col of cfg.columns as any[]) {
      if (cols.has(col.name)) continue;
      const type = col.getSQLType();
      const def = defaultSql(col);
      const notNull = col.notNull && def ? ' NOT NULL' : '';
      gaps.push({ table: cfg.name, column: col.name, type, sql: `ALTER TABLE ${cfg.name} ADD COLUMN IF NOT EXISTS ${col.name} ${type}${notNull}${def};` });
    }
  }
  return gaps;
}

/** On start: one log line if all is well, otherwise the list + ready SQL. */
export async function logSchemaCheck(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const gaps = await checkSchema();
    if (!gaps.length) { console.log('[schema-check] OK — database matches the code schema'); return; }
    console.warn(`[schema-check] ${gaps.length} missing in the database:`);
    for (const g of gaps) console.warn(g.column ? `[schema-check]   ${g.table}.${g.column} (${g.type}) → ${g.sql}` : `[schema-check]   table ${g.table} is missing`);
  } catch (e) {
    console.warn('[schema-check] skipped:', (e as Error).message);
  }
}
