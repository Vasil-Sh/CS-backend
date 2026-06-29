import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, schema } from './client';

async function seed() {
  const passwordHash = await bcrypt.hash('admin123', 10);

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
    console.log('✅ Admin user created: admin / admin123');
  } else {
    console.log('⚠️ Admin user already exists');
  }

  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
