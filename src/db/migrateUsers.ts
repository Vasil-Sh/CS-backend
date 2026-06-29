import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, schema } from './client';

const SHEET_ID = '1IhAUYQKcPjXetOGxCu-_YXxrj_kXt0QxKJCcGqPzZdo';

async function fetchUsers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const resp = await fetch(url);
  const text = await resp.text();
  const rows = text.split('\n').slice(1).filter((r: string) => r.trim());
  const users: any[] = [];
  for (const row of rows) {
    const m = row.match(/("(?:[^"]|"")*"|[^",\s]+)(?=\s*,|\s*$)/g);
    if (!m || m.length < 7) continue;
    users.push({
      telegram: m[0].replace(/"/g, '').trim(),
      username: m[1].replace(/"/g, '').trim(),
      password: m[2].replace(/"/g, '').trim(),
      priceMonth: m[3].replace(/"/g, '').trim(),
      startDate: m[4].replace(/"/g, '').trim(),
      endDate: m[5].replace(/"/g, '').trim(),
      isAdmin: (m[6] || '').replace(/"/g, '').trim().toLowerCase() === 'так',
    });
  }
  return users;
}

function toPgDate(ddmmYYYY: string): string {
  if (!ddmmYYYY) return new Date().toISOString().split('T')[0];
  const parts = ddmmYYYY.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  // Already YYYY-MM-DD or other
  if (/^\d{4}-\d{2}-\d{2}$/.test(ddmmYYYY)) return ddmmYYYY;
  return new Date().toISOString().split('T')[0];
}

async function migrate() {
  const users = await fetchUsers();
  console.log(`Found ${users.length} users in Google Sheets`);
  let created = 0;
  for (const u of users) {
    const existing = await db.select().from(schema.users).where(eq(schema.users.username, u.username)).limit(1);
    if (existing.length > 0) { console.log(`  SKIP ${u.username}`); continue; }
    const hash = await bcrypt.hash(u.password, 10);
    await db.insert(schema.users).values({
      username: u.username, passwordHash: hash, role: u.isAdmin ? 'admin' : 'user',
      telegram: u.telegram, priceMonth: (u.priceMonth || '0').replace(/[^0-9.]/g, '') || '0',
      endDate: toPgDate(u.endDate),
    });
    console.log(`  OK ${u.username} (${u.isAdmin ? 'admin' : 'user'})`);
    created++;
  }
  console.log(`Done: ${created} imported`);
  process.exit(0);
}
migrate().catch(e => { console.error(e); process.exit(1); });
