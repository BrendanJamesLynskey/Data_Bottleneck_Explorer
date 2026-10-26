// Screenshots for the user guide (guide.html), from the page as it is:  node tools/guide_shots.js
// Writes guide-img/*.webp at 1400 px wide, and prints where the numbered pins on the tour screenshot belong (as percentages),
// which go into guide.html's #tourShot style. Offline: only the page itself loads (fonts fall back to system ones).
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'guide-img');

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setViewport({width: 1400, height: 900});
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const settle = () => new Promise(r => setTimeout(r, 600));
  const shot = async (name, setup, clip) => {
    await page.evaluate(setup); await settle();
    await page.screenshot({path: path.join(OUT, name + '.webp'), type: 'webp', quality: 82, ...(clip ? {clip} : {})});
    console.log('wrote guide-img/' + name + '.webp');
  };
  const reset = `openDrawer(null); closeSpec(); whyKey = null; pinA = null; tab = 'sizing'; moreOpen = false; buildTabs(); window.scrollTo(0, 0);`;

  await page.setViewport({width: 1400, height: 1250});            // tall enough to reach the tabs
  await shot('main', `${reset} applyPreset('llmserve'); window.scrollTo(0, 0);`);
  // the tour's pins: header controls, request box, headline figures, weakest-link strip, diagram, tabs
  const pins = await page.evaluate(() => {
    const at = (sel, fx = 0.5, fy = 0.5) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
      return [+((r.left + r.width * fx) / 1400 * 100).toFixed(1), +((r.top + r.height * fy) / 1250 * 100).toFixed(1)]; };
    return [at('header .ctrl', 0.02), at('#askForm', 0.02), at('#verdict', 0.01, 0.2), at('#chain', 0.01), at('.dwrap', 0.02, 0.1), at('#tabbar', 0.01)];
  });
  console.log('tour pins (x %, y %): ' + JSON.stringify(pins));
  await page.setViewport({width: 1400, height: 900});
  await shot('why', `${reset} applyPreset('llmserve'); whyKey = 'power'; paintSummary(M); document.getElementById('why').scrollIntoView({block: 'center'});`, {x: 0, y: 0, width: 1400, height: 760});
  await shot('inputs', `${reset} applyPreset('video'); openDrawer('left');`);
  await page.evaluate(`${reset} applyPreset('nvl72'); selected = 'dram'; openDrawer('right');`);
  await new Promise(r => setTimeout(r, 400));
  await shot('component', `const d = document.querySelector('#insp details.sec'); if (d) { d.open = true; d.querySelector('summary').scrollIntoView({block: 'start'}); }`);
  await shot('specs', `${reset} applyPreset('gbms'); tab = 'sizing'; buildTabs(); update(); document.getElementById('tabbar').scrollIntoView({block: 'start'});`);
  await page.evaluate(`${reset} applyPreset('video'); tab = 'opt'; buildTabs(); update();`);
  await new Promise(r => setTimeout(r, 1500));
  await shot('optimise', `document.getElementById('tabbar').scrollIntoView({block: 'start'});`);
  await shot('latency', `${reset} applyPreset('stencil'); tab = 'latency'; buildTabs(); update(); document.getElementById('tabbar').scrollIntoView({block: 'start'});`);
  await shot('chip', `${reset} applyPreset('chiparray'); tab = 'chip'; buildTabs(); update(); document.getElementById('tabbar').scrollIntoView({block: 'start'});`);
  await shot('compare', `${reset} applyPreset('llm'); document.getElementById('pinBtn').click(); S.dev.units *= 2; buildAll(); document.getElementById('cmpMore').click(); document.getElementById('verdict').scrollIntoView({block: 'start'});`, {x: 0, y: 0, width: 1400, height: 600});
  await shot('sim', `${reset} document.getElementById('cmpClear') && document.getElementById('cmpClear').click(); applyPreset('radar'); tab = 'checks'; buildTabs();
    simRun = {state: 'done', link: SIM_URL + '#d=' + packS(S), secs: 41, result: {pools: simCommitted().examples.find(e => e.id === 'radar').pools}}; update();
    document.getElementById('simCard').scrollIntoView({block: 'start'});`);
  // the demo, played fast to its end, with the assistant drawer open
  await page.evaluate(`${reset} simRun = {state: 'idle'}; window.__demoFast = true; document.getElementById('demoBtn').click();`);
  await page.waitForFunction(() => !replay && [...document.querySelectorAll('.msg.sys')].some(m => m.textContent.startsWith('End of the demo')), {timeout: 60000});
  await shot('assistant', `openDrawer('assist'); const c = document.getElementById('chatLog'); c.scrollTop = 0;`);
  await browser.close();
})();
