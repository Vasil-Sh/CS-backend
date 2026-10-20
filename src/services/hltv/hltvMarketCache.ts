import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getBrowser, type TipsGgMatch } from '../tipsggScraper';
import { applyHltvMarket, findMarketUrl, parseHltvMarket, parseHltvMarketListing,
  type HltvMarket, type ListingMatch } from './hltvMarkets';

const TTL = 10 * 60_000;
const RETRY = 2 * 60_000;
const FILE = join(process.cwd(), '.cache', 'hltv_markets.json');
type Entry = { ts: number; market: HltvMarket };
const cache = new Map<string, Entry>();
const attempts = new Map<string, number>();
let listing: ListingMatch[] = [];
let listingAt = 0;
let running = false;
let blockedUntil = 0;
try {
  if (existsSync(FILE)) {
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Entry>;
    for (const [url, entry] of Object.entries(saved))
      if (entry?.market?.team1 && Date.now() - entry.ts < TTL) cache.set(url, entry);
  }
} catch { /* A corrupt/old cache is not a fatal error. */ }

async function readHtml(url: string): Promise<string> {
  const page = await (await getBrowser()).newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response?.ok()) {
      if ([403, 429].includes(response?.status() ?? 0)) blockedUntil = Date.now() + 15 * 60_000;
      throw new Error(`HLTV HTTP ${response?.status()}`);
    }
    // Read normal public page content; never attempt to solve a challenge.
    await page.waitForSelector(url.endsWith('/matches') ? '.match-wrapper' : '.teamsBox .teamName',
      { timeout: 5_000 });
    return await page.content();
  } finally { await page.close().catch(() => {}); }
}

function persist() {
  try {
    for (const [key, entry] of cache) if (Date.now() - entry.ts >= TTL) cache.delete(key);
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(cache)));
    renameSync(`${FILE}.tmp`, FILE);
  } catch (error) { console.warn('[hltvMarkets] Cache write failed:', String(error)); }
}

async function refresh(matches: TipsGgMatch[]) {
  let failures = 0, updated = 0;
  try {
    if (Date.now() - listingAt >= TTL) {
      listingAt = Date.now();
      try {
        const fresh = parseHltvMarketListing(await readHtml('https://www.hltv.org/matches'));
        if (fresh.length) listing = fresh;
      } catch (error) { console.warn('[hltvMarkets] Listing unavailable:', String(error)); }
    }
    if (Date.now() < blockedUntil) return;
    for (const match of matches) {
      const url = findMarketUrl(match, listing);
      if (!url || Date.now() - (attempts.get(url) ?? 0) < RETRY
        || Date.now() - (cache.get(url)?.ts ?? 0) < TTL) continue;
      attempts.set(url, Date.now());
      try {
        const market = parseHltvMarket(await readHtml(url));
        if (!market) throw new Error('No valid match teams on page');
        cache.set(url, { ts: Date.now(), market });
        updated++;
        failures = 0;
        persist();
      } catch (error) {
        console.warn('[hltvMarkets] Detail unavailable:', url, String(error));
        if (Date.now() < blockedUntil) break;
        if (++failures >= 3) { blockedUntil = Date.now() + RETRY; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  } finally {
    running = false;
    if (updated) console.log(`[hltvMarkets] Updated ${updated} match pages`);
  }
}

/** Overlay fresh values even on cached schedule responses; I/O stays in the background. */
export function withHltvMarkets(matches: TipsGgMatch[]): TipsGgMatch[] {
  const now = Date.now();
  for (const [url, attemptedAt] of attempts) if (now - attemptedAt > TTL) attempts.delete(url);
  if (!running && now >= blockedUntil) {
    const eligible = matches.filter(m => m.status !== 'finished'
      && Date.parse(m.startDate) <= now + 48 * 3600_000)
      .sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live')
        || Date.parse(a.startDate) - Date.parse(b.startDate));
    running = true;
    void refresh(eligible).catch(error => console.warn('[hltvMarkets] Refresh failed:', String(error)));
  }
  return matches.map(match => {
    const url = findMarketUrl(match, listing);
    const entry = url ? cache.get(url) : undefined;
    return entry && now - entry.ts < TTL ? applyHltvMarket(match, entry.market) : match;
  });
}
