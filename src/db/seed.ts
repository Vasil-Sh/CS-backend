import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, schema } from './client';

async function seed() {
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPass, 10);

  const [user] = await db
    .insert(schema.users)
    .values({
      username: 'admin',
      passwordHash,
      role: 'admin',
      telegram: '',
      priceMonth: '0',
      endDate: '2099-12-31',
    })
    .onConflictDoNothing()
    .returning();

  if (user) {
    console.log(`✅ Admin user created: admin / ${adminPass}`);
  } else {
    console.log('⚠️ Admin user already exists');
  }

  process.exit(0);
}

seed().catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
