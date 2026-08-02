/**
 * Bulk Download Tips.GG Team Logos
 *
 * Reads .cache/tipsgg_team_logos.json (4188 teams),
 * downloads all logos via Puppeteer (batched fetch with Referer),
 * saves PNG/SVG to .cache/logos/tipsgg/{cs2|dota2}/{normalized_name}.png
 *
 * Uses browser fetch() with concurrency=8 to avoid rate-limiting.
 * Run: npx tsx scripts/download-tipsgg-logos.ts
 */

import { getBrowser } from '../src/services/tipsggScraper';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTeamName } from '../src/services/logoStore';

const CACHE_DIR = join(process.cwd(), '.cache');
const LOGOS_DIR = join(CACHE_DIR, 'logos', 'tipsgg');
const DATA_FILE = join(CACHE_DIR, 'tipsgg_team_logos.json');
const CONCURRENCY = 8;

interface TeamEntry {
  name: string;
  game: string;
  cdnUrl: string;
}

async function downloadAll() {
  if (!existsSync(DATA_FILE)) {
    console.error('tipsgg_team_logos.json not found — run scrape-team-logos.ts first');
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  const allTeams: TeamEntry[] = [];
  if (raw.cs2) allTeams.push(...raw.cs2.map((t: any) => ({ ...t, game: 'cs2' })));
  if (raw.dota2) allTeams.push(...raw.dota2.map((t: any) => ({ ...t, game: 'dota2' })));

  // Ensure output dirs exist
  for (const game of ['cs2', 'dota2']) {
    const dir = join(LOGOS_DIR, game);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Filter already-downloaded
  let already = 0;
  const toDownload: TeamEntry[] = [];
  for (const t of allTeams) {
    const norm = normalizeTeamName(t.name);
    const pngPath = join(LOGOS_DIR, t.game, `${norm}.png`);
    const svgPath = join(LOGOS_DIR, t.game, `${norm}.svg`);
    if (existsSync(pngPath) || existsSync(svgPath)) {
      already++;
    } else {
      toDownload.push(t);
    }
  }

  console.log(`[tipsgg:download] ${already}/${allTeams.length} already downloaded`);
  console.log(`[tipsgg:download] ${toDownload.length} remaining`);

  if (toDownload.length === 0) {
    console.log('[tipsgg:download] All done!');
    return;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY).map(t => ({
      name: t.name,
      game: t.game,
      cdnUrl: t.cdnUrl,
      norm: normalizeTeamName(t.name),
    }));

    // Fetch all in parallel within the browser page + convert to base64
    const results: (string | null)[] = await page.evaluate(async (items) => {
      const outcomes: (string | null)[] = [];
      for (const item of items) {
        try {
          const res = await fetch(item.cdnUrl, {
            headers: { 'Referer': 'https://tips.gg/' },
          });
          if (!res.ok) { outcomes.push(null); continue; }
          const blob = await res.blob();
          const arr = new Uint8Array(await blob.arrayBuffer());
          // Convert to base64 for transfer back to Node
          let binary = '';
          for (let j = 0; j < arr.length; j++) binary += String.fromCharCode(arr[j]);
          outcomes.push(btoa(binary));
        } catch {
          outcomes.push(null);
        }
      }
      return outcomes;
    }, batch.map(b => ({ cdnUrl: b.cdnUrl })));

    // Write to disk
    for (let j = 0; j < results.length; j++) {
      const b64 = results[j];
      if (!b64) { failed++; continue; }

      const { norm, game } = batch[j];
      const buf = Buffer.from(b64, 'base64');

      // Detect format from magic bytes
      const ext = buf[0] === 0x3C ? 'svg' : 'png'; // '<' = SVG, otherwise assume PNG
      const outPath = join(LOGOS_DIR, game, `${norm}.${ext}`);
      try {
        writeFileSync(outPath, buf);
        downloaded++;
      } catch {
        failed++;
      }
    }

    const pct = Math.min(100, Math.round((i + batch.length) / toDownload.length * 100));
    process.stdout.write(`\r  ${pct}% | ${downloaded} ok, ${failed} err`);
  }

  console.log(`\n[tipsgg:download] DONE: ${downloaded} downloaded, ${failed} failed`);
  console.log(`[tipsgg:download] → ${LOGOS_DIR}`);
  await page.close();
}

downloadAll().catch(e => { console.error(e); process.exit(1); });
