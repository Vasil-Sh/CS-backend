const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({headless:true,args:['--no-sandbox','--headless=new']});
  const p = await b.newPage();
  await p.setUserAgent('Mozilla/5.0 Chrome/148');
  await p.goto('https://tips.gg/cs2/matches/', {waitUntil:'networkidle2',timeout:30000});
  const html = await p.content();
  
  const count = (html.match(/class="element match/g) || []).length;
  const idx = html.indexOf('class="element match');
  const snippet = idx >= 0 ? html.substring(idx, idx + 2000) : 'NOT FOUND';
  
  console.log('htmlLen:', html.length);
  console.log('matches:', count);
  console.log('jsonLd:', html.includes('application/ld+json'));
  console.log('SNIPPET:', snippet);
  
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
