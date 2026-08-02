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
  const url = `https://tips.gg/${gameSlug}/teams/`;
  
  console.log(`[tipsgg:logos] Fetching ${url} ...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  // Scroll to trigger lazy-loading of all team logos
  // Tips.gg shows ~20 teams at a time with infinite scroll
  let prevCount = 0;
  let scrollAttempts = 0;
  const maxScrolls = 15; // ~300 teams

  while (scrollAttempts < maxScrolls) {
    const currentCount = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img.logo.lazy');
      return imgs.length;
    });

    if (currentCount === prevCount && scrollAttempts > 2) break;
    prevCount = currentCount;

    // Trigger lazy images to load
    await page.evaluate(() => {
      const imgs = document.querySelectorAll('img.logo.lazy');
      imgs.forEach(img => {
        // Force load lazy images by setting src from data attributes
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) (img as HTMLImageElement).src = dataSrc;
      });
    });

    // Scroll to bottom to trigger infinite scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1000));

    scrollAttempts++;
    console.log(`  ...scrolled ${scrollAttempts}x, ${currentCount} logos found`);
  }

  // Wait a moment for any final lazy loads
  await new Promise(r => setTimeout(r, 2000));

  // Extract all loaded team logos
  const teams = await page.evaluate((game) => {
    const results: { name: string; cdnUrl: string }[] = [];
    const seen = new Set<string>();

    // Primary: img.logo.lazy with alt containing team name
    const logoImgs = document.querySelectorAll('img.logo.lazy');
    logoImgs.forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      const alt = img.getAttribute('alt') || '';

      // Skip base64 placeholders
      if (!src.startsWith('https://files.tips.gg')) return;

      // Extract team name from alt: "Vitality – CS2 (CS:GO) Team" → "Vitality"
      let name = alt.replace(/\s*[-–—]\s*CS2\s*\(CS:GO\)\s*Team\s*$/i, '')
        .replace(/\s*[-–—]\s*Dota\s*2\s*Team\s*$/i, '')
        .replace(/\s*[-–—]\s*CS2\s*Team\s*$/i, '')
        .replace(/\s*[-–—]\s*Dota2\s*Team\s*$/i, '')
        .trim();

      if (!name || seen.has(src)) return;
      seen.add(src);
      results.push({ name, cdnUrl: src });
    });

    // Fallback: any img with files.tips.gg in src
    if (results.length === 0) {
      const allImgs = document.querySelectorAll('img[src*="files.tips.gg"]');
      allImgs.forEach(img => {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || img.closest('a')?.getAttribute('title') || '';
        if (!src || seen.has(src)) return;
        seen.add(src);
        results.push({ name: alt || 'unknown', cdnUrl: src });
      });
    }

    return results;
  }, gameKey);

  await page.close();
  return teams.map(t => ({ ...t, game: gameKey }));
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
