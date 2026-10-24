// Regression and reference checks for Hardware System Design Explorer, run in headless Chrome.
//   node test/check.js            check against test/golden.json
//   node test/check.js --update   rewrite the golden file after an intended model change
// Checks: no page errors; every published reference figure within tolerance; overhead breakdowns multiply out to the
// model's capacities; every example matches its golden result within 2 %; the optimiser finds a design for each.
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), GOLDEN = path.join(__dirname, 'golden.json');
const update = process.argv.includes('--update');

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith('file:') || r.url().startsWith('data:')) ? r.continue() : r.abort());
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 500));

  // the demo replays to the end without errors (fast mode: no delays)
  await page.evaluate(() => { window.__demoFast = true; });
  await page.click('#demoBtn');
  await page.waitForFunction(() => !replay && [...document.querySelectorAll('.msg.sys')].some(m => m.textContent.startsWith('End of the demo')), {timeout: 30000});
  const demo = await page.evaluate(() => ({kind: DEMO.kind, msgs: document.querySelectorAll('#chatLog .msg').length, tools: [...document.querySelectorAll('#chatLog .msg.act')].length, design: designLine(S)}));

  const result = await page.evaluate(() => {
    const out = {refs: runChecks().map(r => ({id: r.id, name: r.name, err: r.err, tol: r.tol, pass: r.pass, fitted: !!r.fitted})), presets: {}, overhead: [], optimiser: {}, overflow: []};
    for (const p of PRESETS) {
      applyPreset(p.id);
      const m = M, ls = latencyStats(m), fp = fullPower(S);
      out.presets[p.id] = {worst: m.worst.name, U: m.worst.U, maxT: m.maxT, latency: isFinite(latHead(m)) ? latHead(m) : null,
        power: m.Ptot, full: fp.total, die: m.die};
      const prod = o => o.steps.reduce((a, x) => a * x.f, o.raw);
      for (const [k, c] of [['h2d', m.cap.h2d], ['d2h', m.cap.d2h], ['dram', m.devBW], ['noc', m.cap.noc]])
        out.overhead.push({preset: p.id, kind: k, err: prod(overheads(k, m)) / c - 1});
      // every line of block text stays inside its block
      for (const [k, b] of Object.entries(G)) { const g = document.getElementById('n_' + k); if (!g) continue;
        g.querySelectorAll('text').forEach(t => { if (!t.textContent || t.classList.contains('tagline')) return; const bb = t.getBBox();
          if (bb.x + bb.width > b.x + b.w + 0.5 || bb.x < b.x - 0.5) out.overflow.push(`${p.id}/${k}: "${t.textContent}"`); }); }
      const r = optimise(S, {goal: 'balanced', practical: true, reticle: false, scale: true});
      out.optimiser[p.id] = r.best ? {found: true, worst: r.best.worst.U <= S.ceil, broken: p.name.includes('✗')} : {found: false, broken: p.name.includes('✗')};
    }
    return out;
  });
  await browser.close();

  let fails = 0;
  const fail = msg => { fails++; console.log('FAIL ' + msg); };
  if (demo.msgs < 8 || demo.tools < 3) fail(`demo replay looks incomplete: ${JSON.stringify(demo)}`);
  else console.log(`ok   ${demo.kind} demo replays (${demo.msgs} messages, ending on ${demo.design})`);
  if (errors.length) fail('page errors: ' + errors.join('; '));
  for (const r of result.refs) {
    const line = `${r.fitted ? 'calibration' : 'reference  '} ${r.name}: ${(r.err * 100).toFixed(1)} % (±${r.tol * 100} %)`;
    if (r.pass) console.log('ok   ' + line); else fail(line);
  }
  if (result.overflow.length) fail('text outside its block: ' + result.overflow.join('; '));
  else console.log('ok   every diagram label fits inside its block, in all 28 examples');
  for (const o of result.overhead) if (Math.abs(o.err) > 1e-9) fail(`overhead breakdown ${o.preset}/${o.kind} off by ${o.err}`);
  console.log(`ok   overhead breakdowns multiply out to the model's capacities (${result.overhead.length} checked)`);
  // deliberately broken examples (marked ✗) may have no fix in hardware, e.g. a hard deadline the host round trip alone exceeds
  for (const [id, o] of Object.entries(result.optimiser)) if (!o.broken && (!o.found || !o.worst)) fail(`optimiser found no design for ${id}`);
  console.log(`ok   optimiser: a design under the ceiling for ${Object.values(result.optimiser).filter(o => o.found).length} of ${Object.keys(result.optimiser).length} examples (broken ones may have none)`);

  if (update || !fs.existsSync(GOLDEN)) {
    fs.writeFileSync(GOLDEN, JSON.stringify(result.presets, null, 1) + '\n');
    console.log(`wrote ${path.relative(ROOT, GOLDEN)} (${Object.keys(result.presets).length} examples)`);
  } else {
    const gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const close = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a / b - 1) <= 0.02);
    for (const [id, g] of Object.entries(gold)) {
      const r = result.presets[id];
      if (!r) { fail(`example ${id} missing`); continue; }
      for (const k of ['U', 'maxT', 'latency', 'power', 'full', 'die']) if (!close(r[k], g[k])) fail(`${id}.${k}: ${r[k]} vs golden ${g[k]}`);
      if (r.worst !== g.worst) fail(`${id}: bottleneck ${r.worst} vs golden ${g.worst}`);
    }
    console.log(`ok   ${Object.keys(gold).length} examples checked against the golden results (2 %)`);
  }
  console.log(fails ? `${fails} failure(s)` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
