// The user guide (guide.html) in headless Chrome: no page errors; every screenshot it shows exists and loads; every
// contents link has a target; the app links back to it; no axe-core violations at desktop and phone width, with the
// animations running and paused; nothing scrolls sideways on a 390 px phone; the demos respond.
//   node test/guide.js
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith('file:') || r.url().startsWith('data:')) ? r.continue() : r.abort());
  let fails = 0;
  const fail = m => { fails++; console.log('FAIL ' + m); };

  await page.setViewport({width: 1400, height: 1000});
  await page.goto('file://' + path.join(ROOT, 'guide.html'), {waitUntil: 'load'});
  const facts = await page.evaluate(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map(i => { i.loading = 'eager'; return i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }); }));
    return {broken: imgs.filter(i => !i.naturalWidth).map(i => i.getAttribute('src')), noAlt: imgs.filter(i => !i.alt).map(i => i.getAttribute('src')),
      dead: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => h.length > 1 && !document.getElementById(h.slice(1))),
      svgs: [...document.querySelectorAll('main svg[role="img"]')].filter(s => !s.getAttribute('aria-labelledby')).length, n: imgs.length,
      sections: document.querySelectorAll('main h2').length};
  });
  if (facts.broken.length) fail('screenshots missing: ' + facts.broken.join(', '));
  if (facts.noAlt.length) fail('images without alt text: ' + facts.noAlt.join(', '));
  if (facts.dead.length) fail('contents links without a target: ' + facts.dead.join(', '));
  if (facts.svgs) fail(`${facts.svgs} diagrams without an accessible name`);
  if (!fails) console.log(`ok   guide: ${facts.sections} sections, ${facts.n} screenshots load with alt text, every contents link and diagram is named`);

  // the demos respond: the load demo's bottleneck changes as the rate rises; the queue grows at high load
  const demo = await page.evaluate(async () => {
    const r = document.getElementById('rate'), set = v => { r.value = v; r.dispatchEvent(new Event('input')); };
    set(60); const low = document.getElementById('loadOut').textContent; set(600); const high = document.getElementById('loadOut').textContent;
    const l = document.getElementById('qLoad'); l.value = 95; l.dispatchEvent(new Event('input'));
    await new Promise(res => setTimeout(res, 3000));
    return {low, high, q: +document.getElementById('qLen').textContent, king: document.getElementById('qKing').textContent};
  });
  if (!/Within the ceiling/.test(demo.low) || !/can’t keep up/.test(demo.high) || demo.king === '–') fail('demos: ' + JSON.stringify(demo));
  else console.log(`ok   demos: the bottleneck moves with the rate; the queue runs (${demo.q} waiting at 95 %, Kingman ${demo.king})`);

  await page.evaluate(AXE);
  const audit = async label => {
    const v = await page.evaluate(async () => (await axe.run(document, {resultTypes: ['violations']})).violations
      .map(x => `${x.impact} ${x.id}: ${x.help} (${x.nodes.slice(0, 2).map(n => n.target.join(' ')).join(', ')})`));
    if (v.length) fail(`axe, ${label}:\n  ${v.join('\n  ')}`);
  };
  await audit('desktop');
  await page.click('#motion');
  const pausedOk = await page.evaluate(() => document.documentElement.classList.contains('paused') && document.getElementById('motion').getAttribute('aria-pressed') === 'true');
  if (!pausedOk) fail('the pause button does not pause');
  await audit('desktop, paused');
  await page.setViewport({width: 390, height: 844});
  await new Promise(r => setTimeout(r, 300));
  await audit('phone');
  const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && !e.closest('.tbl, .fig'); })
    .slice(0, 3).map(e => e.tagName + (e.id ? '#' + e.id : '') + '.' + e.className));
  if (wide.length) fail('wider than a 390 px phone: ' + wide.join(', '));

  // the app links to the guide
  await page.setViewport({width: 1400, height: 1000});
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'domcontentloaded'});
  const link = await page.evaluate(() => !!document.querySelector('header a[href="guide.html"]'));
  if (!link) fail('the app header has no Guide link');
  if (errors.length) fail('page errors: ' + errors.join('; '));
  await browser.close();
  if (fails) { console.log(`${fails} guide failure(s)`); process.exit(1); }
  console.log('ok   guide: no axe-core violations at desktop and phone width, running and paused; nothing scrolls sideways; the app links to it');
})();
