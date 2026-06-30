// Seed initial risky teams from frontend data
// Run: npx tsx src/db/seedRiskyTeams.ts
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, schema } from './client';

const TEAMS = [
  { name: 'Liquid', game: 'CS', status: 'БАН' },
  { name: 'Fish123', game: 'CS', status: 'БАН' },
  { name: 'Passion Ua', game: 'CS', status: 'БАН' },
  { name: 'Nemiga', game: 'CS', status: 'БАН' },
  { name: 'Team Falcons', game: 'Дота', status: 'БАН' },
  { name: 'Tyloo', game: 'CS', status: 'Рідко' },
  { name: 'Mouz', game: 'Дота', status: 'Обережно' },
  { name: 'Parivision', game: 'Дота', status: 'Обережно' },
  { name: 'Tundra', game: 'Дота', status: 'Обережно' },
  { name: 'Aurora', game: 'Дота', status: 'БАН' },
  { name: 'Team Spirit', game: 'Дота', status: 'Обережно' },
  { name: 'B8', game: 'CS', status: 'Обережно' },
  { name: 'Furia', game: 'CS', status: 'Обережно' },
  { name: 'Virtuspro', game: 'CS', status: 'БАН' },
  { name: 'Monte', game: 'CS', status: 'БАН' },
  { name: 'Astralis', game: 'CS', status: 'Нестабільні' },
  { name: 'Falcons', game: 'CS', status: 'Обережно' },
  { name: 'Bestia', game: 'CS', status: 'БАН' },
  { name: 'G2Areas', game: 'CS', status: 'Обережно' },
  { name: 'The Mongolz', game: 'CS', status: 'Нестабільні' },
  { name: 'Natus Vincere', game: 'CS', status: 'Обережно' },
  { name: 'Vitality', game: 'CS', status: 'Обережно' },
  { name: 'Eternal Fire', game: 'CS', status: 'БАН' },
  { name: 'Nexus', game: 'CS', status: 'Обережно' },
  { name: 'Oddik', game: 'CS', status: 'Обережно' },
  { name: '9Z', game: 'CS', status: 'Нестабільні' },
  { name: 'Mibr', game: 'CS', status: 'БАН' },
  { name: 'Parivision', game: 'CS', status: 'Обережно' },
  { name: 'Tnl', game: 'CS', status: 'БАН' },
  { name: 'Betclic', game: 'CS', status: 'БАН' },
  { name: 'Sangal', game: 'CS', status: 'Обережно' },
  { name: 'Ence', game: 'CS', status: 'Обережно' },
  { name: 'Spirit Academy', game: 'CS', status: 'Обережно' },
];

async function seed() {
  let created = 0;
  for (const t of TEAMS) {
    const existing = await db.select().from(schema.riskyTeams).where(eq(schema.riskyTeams.name, t.name)).limit(1);
    if (existing.length > 0) { console.log(`  SKIP ${t.name}`); continue; }
    await db.insert(schema.riskyTeams).values({ name: t.name });
    console.log(`  OK ${t.name}`);
    created++;
  }
  console.log(`Done: ${created} created`);
  process.exit(0);
}
seed().catch(e => { console.error(e); process.exit(1); });
