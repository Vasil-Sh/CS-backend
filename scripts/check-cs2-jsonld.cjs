/**
 * Quick script to inspect what CS2 JSON-LD looks like on tips.gg
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
  
  // Check JSON-LD
  const scripts = await page.evaluate(() => {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    return Array.from(nodes).map(n => n.textContent);
  });
  
  console.log('JSON-LD scripts found:', scripts.length);
  if (scripts.length > 0) {
    for (let i = 0; i < Math.min(scripts.length, 3); i++) {
      try {
        const data = JSON.parse(scripts[i]);
        console.log(`\n--- Script ${i} ---`);
        console.log('@type:', data['@type']);
        console.log('sport:', data.sport);
        console.log('competitor count:', data.competitor?.length || 0);
        if (data.competitor?.[0]) console.log('team1:', data.competitor[0].name);
        if (data.competitor?.[1]) console.log('team2:', data.competitor[1].name);
      } catch(e) {
        console.log(`Script ${i}: parse error -`, scripts[i].substring(0, 100));
      }
    }
  } else {
    // Check if page loaded at all
    const html = await page.content();
    console.log('HTML length:', html.length);
    console.log('Has match elements:', html.includes('class="element match'));
    console.log('Title:', await page.title());
    console.log('First 500 chars:', html.substring(0, 500));
  }
  
  await browser.close();
})();
