/**
 * Tips.GG Team Logo Scraper
 *
 * Scrapes https://tips.gg/csgo/teams/ and /dota2/teams/ to build
 * a comprehensive name → CDN URL map. Scrolling triggers lazy-loading,
 * then we extract src + alt from every <img class="logo lazy">.
 *
 * Run: npx tsx scripts/scrape-team-logos.ts
 * Output: a name→URL map stored in .cache/tipsgg_team_logos.json
 */

import { getBrowser } from '../src/services/tipsggScraper';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const GAMES = [
  { game: 'cs2', slug: 'csgo', label: 'CS2' },
  { game: 'dota2', slug: 'dota2', label: 'Dota2' },
] as const;

const CACHE_DIR = join(process.cwd(), '.cache');
const OUTPUT_FILE = join(CACHE_DIR, 'tipsgg_team_logos.json');

interface TeamEntry {
  name: string;       // e.g. "FaZe Clan"
  game: string;       // "cs2" | "dota2"
  cdnUrl: string;     // https://files.tips.gg/static/image/teams/...
}

async function scrapeGameLogos(
  gameSlug: string,
  gameKey: string,
): Promise<TeamEntry[]> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  const allTeams: TeamEntry[] = [];
  const seen = new Set<string>();
  let pageNum = 1;
  let emptyPages = 0;
  const MAX_EMPTY = 3; // stop after 3 consecutive empty pages

  while (true) {
    const url = pageNum === 1
      ? `https://tips.gg/${gameSlug}/teams/`
      : `https://tips.gg/${gameSlug}/teams/page/${pageNum}/`;

    console.log(`[tipsgg:logos] Page ${pageNum}: ${url}`);
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch {
      console.log(`  ...timeout on page ${pageNum}, stopping`);
      break;
    }

    // Force lazy images to load
    await page.evaluate(() => {
      document.querySelectorAll('img.logo.lazy, img[data-src]').forEach(img => {
        const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src) (img as HTMLImageElement).src = src;
      });
    });
    await new Promise(r => setTimeout(r, 800));

    // Extract logos from current page
    const pageTeams = await page.evaluate((game) => {
      const results: { name: string; cdnUrl: string }[] = [];
      const seenLocal = new Set<string>();

      const logoImgs = document.querySelectorAll('img.logo.lazy, img[src*="files.tips.gg"]');
      logoImgs.forEach(img => {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        const alt = img.getAttribute('alt') || '';

        if (!src.startsWith('https://files.tips.gg')) return;
        if (seenLocal.has(src)) return;
        seenLocal.add(src);

        let name = alt
          .replace(/\s*[-–—]\s*CS2\s*\(CS:GO\)\s*Team\s*$/i, '')
          .replace(/\s*[-–—]\s*Dota\s*2\s*Team\s*$/i, '')
          .replace(/\s*[-–—]\s*CS2\s*Team\s*$/i, '')
          .replace(/\s*[-–—]\s*Dota2\s*Team\s*$/i, '')
          .trim();

        if (!name) return;
        results.push({ name, cdnUrl: src });
      });

      return results;
    }, gameKey);

    // Deduplicate globally
    let newCount = 0;
    for (const t of pageTeams) {
      if (!seen.has(t.cdnUrl)) {
        seen.add(t.cdnUrl);
        allTeams.push({ ...t, game: gameKey });
        newCount++;
      }
    }

    console.log(`  ...${newCount} new teams (${allTeams.length} total)`);

    if (newCount === 0) {
      emptyPages++;
      if (emptyPages >= MAX_EMPTY) {
        console.log(`  ...${MAX_EMPTY} empty pages, stopping`);
        break;
      }
    } else {
      emptyPages = 0;
    }

    pageNum++;
  }

  await page.close();
  console.log(`[tipsgg:logos] ${gameKey}: ${allTeams.length} total teams scraped`);
  return allTeams;
}

async function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const allTeams: TeamEntry[] = [];

  for (const { game, slug, label } of GAMES) {
    try {
      const teams = await scrapeGameLogos(slug, game);
      console.log(`[tipsgg:logos] ${label}: ${teams.length} team logos scraped`);
      allTeams.push(...teams);
    } catch (err) {
      console.error(`[tipsgg:logos] ${label} scrape failed:`, (err as Error).message);
    }
  }

  // Save
  const map: Record<string, TeamEntry[]> = {};
  for (const t of allTeams) {
    if (!map[t.game]) map[t.game] = [];
    map[t.game].push(t);
  }

  const total = allTeams.length;
  writeFileSync(OUTPUT_FILE, JSON.stringify(map, null, 2));
  console.log(`\n[tipsgg:logos] DONE: ${total} total teams → ${OUTPUT_FILE}`);
  console.log(`  CS2: ${map['cs2']?.length || 0}, Dota2: ${map['dota2']?.length || 0}`);
}

main().catch(e => { console.error(e); process.exit(1); });
