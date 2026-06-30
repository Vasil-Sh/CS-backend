const fs = require('fs');

let s = fs.readFileSync('src/index.ts', 'utf8');

// 1. Add import
if (!s.includes('numericNormalizer')) {
  s = s.replace(
    "import { securityHeaders } from './middleware/securityHeaders';\nimport { db } from './db/client';",
    "import { securityHeaders } from './middleware/securityHeaders';\nimport { numericNormalizer } from './middleware/numericNormalizer';\nimport { db } from './db/client';"
  );
}

// 2. Add middleware
const marker = "app.use('*', bodyLimit(1_000_000)); // 1MB max body\napp.use('*', authMiddleware);\n\n// ── Health check";
const replacement = `app.use('*', bodyLimit(1_000_000)); // 1MB max body
app.use('*', authMiddleware);

// ── Convert ALL string numbers to real numbers in JSON responses ──
app.use('*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return;
  const original = c.res.clone();
  try {
    const body = await original.json();
    const normalized = numericNormalizer(body);
    c.res = new Response(JSON.stringify(normalized), {
      status: c.res.status,
      headers: c.res.headers,
    });
  } catch {
    // pass through
  }
});

// ── Health check`;

s = s.replace(marker, replacement);
fs.writeFileSync('src/index.ts', s, 'utf8');
console.log('✅ index.ts updated');
