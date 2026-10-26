// Accessibility audit with axe-core in headless Chrome: the page, every tab, each drawer, the spec sheet and an
// explanation panel must have no violations (WCAG 2 A/AA rules and best practices axe checks by default).
//   node test/a11y.js
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith('file:') || r.url().startsWith('data:')) ? r.continue() : r.abort());
  await page.setViewport({width: 1400, height: 1000});
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(AXE);
  const states = [['page', '']];
  for (const t of ['opt', 'sizing', 'sweep', 'chip', 'onchip', 'rack', 'ppa', 'cost', 'cons', 'latency', 'checks', 'headroom', 'roofline', 'model'])
    states.push(['tab ' + t, `tab = '${t}'; buildTabs(); update();`]);
  states.push(['inputs drawer, LLM workload', `applyPreset('llmserve'); openDrawer('left');`], ['component drawer', `openDrawer(null); selected = 'dram'; openDrawer('right');`],
    ['assistant drawer', `openDrawer('assist');`], ['spec sheet', `openDrawer(null); openSpec();`], ['explanation', `closeSpec(); whyKey = 'lat'; paintSummary(M);`],
    // model vs simulation: a run in progress, then a finished run (the committed radar rows) with one example's rows open
    ['simulation running', `whyKey = null; applyPreset('radar'); tab = 'checks'; buildTabs(); update(); simRun = {state:'running', stage:'Simulating', done:3, total:10}; simPaint();`],
    ['simulation result', `simRun = {state:'done', link:SIM_URL+'#d='+packS(S), secs:42, result:{pools:simCommitted().examples.find(e=>e.id==='radar').pools}}; simAll = 'llmsplit'; update();`]);
  let fails = 0;
  for (const [label, setup] of states) {
    await page.evaluate(setup); await new Promise(r => setTimeout(r, 300));
    const v = await page.evaluate(async () => (await axe.run(document, {resultTypes: ['violations']})).violations
      .map(x => `${x.impact} ${x.id}: ${x.help} (${x.nodes.slice(0, 2).map(n => n.target.join(' ')).join(', ')})`));
    if (v.length) { fails += v.length; console.log(`FAIL ${label}:\n  ${v.join('\n  ')}`); }
  }
  await browser.close();
  if (fails) { console.log(`${fails} accessibility violations`); process.exit(1); }
  console.log(`ok   accessibility: no axe-core violations in ${states.length} states (page, ${states.length - 8} tabs, drawers, spec sheet, explanation, simulation running and done)`);
})();
