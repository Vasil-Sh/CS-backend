// ═══════════════════════════════════════════
// EMBEDDED OpenAPI spec — no file I/O needed
// Generated from scripts/gen-openapi.cjs
// ═══════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const spec = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'src', 'openapi.json'),
    'utf-8'
  )
);

// Write as valid TypeScript that exports the object directly
const ts =
  '// Auto-generated — do not edit. Run: node scripts/embed-spec.cjs\n' +
  'const _spec = ' +
  JSON.stringify(spec, null, 2) +
  ' as const;\n' +
  'export default _spec;\n';

const outPath = path.join(__dirname, '..', 'src', 'openapiEmbedded.ts');
fs.writeFileSync(outPath, ts, 'utf-8');
console.log('✅ openapiEmbedded.ts written — ' + Math.round(fs.statSync(outPath).size / 1024) + ' KB');
