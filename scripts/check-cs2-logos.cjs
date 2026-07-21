/**
 * Inspect what CS2 logo data-src values come from tips.gg HTML
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--headless=new'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.goto('https://tips.gg/csgo/matches/21-07-2026/', { waitUntil: 'networkidle2', timeout: 30000 });

  const logos = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img[alt*="CS2"], img[alt*="CSGO"], img[alt*="Counter-Strike"]');
    return Array.from(imgs).slice(0, 10).map(img => ({
      alt: img.alt,
      src: img.src,
      dataSrc: img.getAttribute('data-src') || 'none',
    }));
  });

  console.log('CS2 logos found:', logos.length);
  logos.forEach(l => console.log(`  alt="${l.alt}"  src="${l.src}"  data-src="${l.dataSrc}"`));

  // Also check what the first match's team logo looks like
  const firstMatchTeam1 = await page.evaluate(() => {
    const first = document.querySelector('.element.match');
    if (!first) return null;
    const el = first.querySelector('a.match-link');
    const href = el?.getAttribute('href');
    return href;
  });
  console.log('\nFirst match URL:', firstMatchTeam1);

  await browser.close();
})();
