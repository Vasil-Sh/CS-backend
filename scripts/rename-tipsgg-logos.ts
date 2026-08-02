/**
 * Rename tips.gg local logos to {rank}_{OriginalName}.ext
 *
 * Reads .cache/tipsgg_team_logos.json (already in ranking order from scrape),
 * renames .cache/logos/tipsgg/{game}/{normalizedName}.png → {rank}_{DisplayName}.png
 *
 * Run: npx tsx scripts/rename-tipsgg-logos.ts
 */

import { readFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTeamName } from '../src/services/logoStore';

const LOGOS_DIR = join(process.cwd(), '.cache', 'logos', 'tipsgg');
const DATA_FILE = join(process.cwd(), '.cache', 'tipsgg_team_logos.json');

function safeFilename(name: string): string {
  // Replace spaces with underscores, remove other problematic chars
  return name
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim();
}

async function main() {
  const raw = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  const games = ['cs2', 'dota2'] as const;

  for (const game of games) {
    const entries = raw[game];
    if (!entries || entries.length === 0) continue;

    const gameDir = join(LOGOS_DIR, game);
    if (!existsSync(gameDir)) continue;

    let renamed = 0;
    let skipped = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const rank = String(i + 1).padStart(4, '0'); // 0001, 0002, ...
      const norm = normalizeTeamName(entry.name);
      const displayName = safeFilename(entry.name);

      // Find the existing file (png or svg)
      let oldPath = join(gameDir, `${norm}.png`);
      if (!existsSync(oldPath)) oldPath = join(gameDir, `${norm}.svg`);
      if (!existsSync(oldPath)) {
        skipped++;
        continue;
      }

      const ext = oldPath.endsWith('.svg') ? '.svg' : '.png';
      const newPath = join(gameDir, `${rank}_${displayName}${ext}`);

      if (oldPath === newPath) { skipped++; continue; }
      if (existsSync(newPath)) {
        console.log(`  SKIP: ${newPath} already exists`);
        skipped++;
        continue;
      }

      try {
        renameSync(oldPath, newPath);
        renamed++;
      } catch (err) {
        console.log(`  FAIL: ${norm}.${ext} → ${rank}_${displayName}${ext}: ${(err as Error).message}`);
      }
    }

    console.log(`[rename] ${game}: ${renamed} renamed, ${skipped} skipped, ${entries.length} total`);
  }

  // Show samples
  for (const game of games) {
    const gameDir = join(LOGOS_DIR, game);
    if (!existsSync(gameDir)) continue;
    console.log(`\n${game.toUpperCase()} samples:`);
    const files = readdirSync(gameDir).sort().slice(0, 10);
    files.forEach(f => console.log(`  ${f}`));
    console.log(`  ... (${readdirSync(gameDir).length} files)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
