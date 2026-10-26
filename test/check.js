// Regression and reference checks for Hardware System Design Explorer, run in headless Chrome.
//   node test/check.js            check against test/golden.json
//   node test/check.js --update   rewrite the golden file after an intended model change
// Checks: no page errors; every published reference figure within tolerance; overhead breakdowns multiply out to the
// model's capacities; every example matches its golden result within 2 %; the optimiser finds a design for each;
// the rate sweep finds a design at every rate; compare pins A, reports the change and carries A in the link;
// short links round-trip every example (changed or not) and old full-state links still load; the spec sheet prints on one A4 page;
// the LLM workload matches a hand calculation and follows the accelerator count; cost parts add up and the cost goal finds the cheapest.
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

  // rate sweep: the DRAM band covers the whole range and the optimiser finds a design at every rate in the LLM example
  const sweep = await page.evaluate(async () => {
    // the demo's optimise call leaves its own settings (count fixed, one reticle) in the Optimise tab; sweep with the defaults
    optState = {goal: 'balanced', practical: true, reticle: false, scale: true, onPackage: false};
    applyPreset('llm'); tab = 'sweep'; buildTabs(); update();
    for (let i = 0; i < 100 && document.getElementById('p_sweep').textContent.includes('Running the optimiser'); i++) await new Promise(r => setTimeout(r, 100));
    const ds = dramSweep(S), rows = sweepMemo.rows;
    return {from: ds.segs[0].from, to: ds.segs[ds.segs.length - 1].to, xs: ds.xs, lines: [...new Set(rows.map(r => r.line))], found: rows.filter(r => r.d).length, n: rows.length,
      steps: document.querySelectorAll('#p_sweep table tbody tr').length};
  });
  // compare: pin, change the DRAM, and the bar reports the difference; the link carries A
  const cmp = await page.evaluate(() => {
    applyPreset('llm'); document.getElementById('pinBtn').click(); S.dev.dram = 'hbm4_8'; S.dev.units = 2; buildAll(); document.getElementById('cmpMore').click();
    const text = document.getElementById('cmp').textContent, hash = location.hash;
    const a = clone(pinA); pinA = null; loadHash(); const back = pinA && pinA.dev.dram === a.dev.dram && S.dev.dram === 'hbm4_8';
    document.getElementById('cmpClear').click();
    return {power: /power\s*[+−]/.test(text), changed: text.includes('changed'), hasA: hash.includes('&a='), back, cleared: document.getElementById('cmp').textContent === ''};
  });
  // short links: each example plus a few changes comes back exactly; an old base64 link still loads
  const links = await page.evaluate(() => {
    const strip = o => { const c = clone(o); delete c.mod; return JSON.stringify(c); };
    let bad = [], longest = 0;
    for (const p of PRESETS) {
      // compared after a model run: with the LLM workload on, the derived inputs are recomputed rather than stored
      const back = t => { const r = unpackS(t); model(r); return strip(r); }, now = () => { model(S); return strip(S); };
      applyPreset(p.id); if (back(packS(S)) !== now()) bad.push(p.id);
      S.dev.units += 1; S.T *= 1.37; S.link.rtt = 0.1 + 0.2; S.vary.deadline = 'hard'; S.note = '42'; S.llm.users *= 3;
      const t = packS(S); if (back(t) !== now()) bad.push(p.id + '*'); longest = Math.max(longest, t.length); delete S.note;
    }
    applyPreset('video'); S.T = 3e10; const want = strip(S);
    history.replaceState(null, '', '#s=' + enc(S)); S = clone(BASE); const legacy = loadHash() && strip(S) === want;
    return {bad, longest, legacy};
  });
  // LLM workload: Llama 3.1 70B FP8, 2,000 users at 20 tok/s, 500 per copy, 4k context, against the arithmetic done by hand
  const llm = await page.evaluate(() => {
    applyPreset('llmserve'); const m = model(S);
    const hand = 2000 * 20 * (70.6e9 / 500 + 80 * 2048 * 1 * 4096);              // users × tok/s × (weights ÷ batch + KV per user)
    const r16 = S.resident; S.scale.nodes = 4; model(S); const r32 = S.resident;   // twice the accelerators, half the data each
    applyPreset('llmserve'); model(S); const T0 = S.T, T2 = model(atRate(S, 2 * T0)).T;
    const c = costOf(S, model(S)), sum = Object.values(c.parts).reduce((a, b) => a + b, 0);
    // prefill: prompt tokens = users × tok/s × prompt ÷ reply; the arithmetic adds up across decode and prefill
    S.llm.prefill = true; model(S); const i = llmInfo(S);
    const pre = { tok: i.pre / (2000 * 20 * 3600 / 1000), ops: S.ops * S.T / (i.tokens * i.opsTok + i.pre * i.preOpsTok), ctx: i.ctx, limit: model(S).worst.k };
    S.llm.prefill = false;
    runTool('set_requirements', {rate_bytes_per_s: 1e12}); const off = !S.llm.on && S.T === 1e12;
    applyPreset('llmserve');
    const o = optimise(S, {goal: 'cost', practical: true, reticle: false, scale: true, onPackage: false});
    return {T: S.T, hand, lat: S.lat, half: r32 / r16, sweep: T2 / T0, sum: sum / c.capex, unit: c.unit, off, pre,
      cheapest: !!o.best && o.front.every(x => x.C >= o.best.C)};
  });
  // spec sheet: laid out as print at the A4 text area (210 × 297 mm less 11 mm margins), every example fits one page
  await page.setViewport({width: 711, height: 1039}); await page.emulateMediaType('print');
  const spec = await page.evaluate(ids => {
    const tall = {};
    for (const id of ids) { applyPreset(id); openSpec(); const h = document.getElementById('sheet').getBoundingClientRect().height; if (h > 1039) tall[id] = Math.round(h); }
    return {tall, link: document.getElementById('sheet').textContent.includes(location.hash), n: ids.length};
  }, Object.keys(result.presets));
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
  else console.log(`ok   every diagram label fits inside its block, in all ${Object.keys(result.presets).length} examples`);
  for (const o of result.overhead) if (Math.abs(o.err) > 1e-9) fail(`overhead breakdown ${o.preset}/${o.kind} off by ${o.err}`);
  console.log(`ok   overhead breakdowns multiply out to the model's capacities (${result.overhead.length} checked)`);
  // deliberately broken examples (marked ✗) may have no fix in hardware, e.g. a hard deadline the host round trip alone exceeds
  for (const [id, o] of Object.entries(result.optimiser)) if (!o.broken && (!o.found || !o.worst)) fail(`optimiser found no design for ${id}`);
  console.log(`ok   optimiser: a design under the ceiling for ${Object.values(result.optimiser).filter(o => o.found).length} of ${Object.keys(result.optimiser).length} examples (broken ones may have none)`);

  if (Math.abs(sweep.from / sweep.xs[0] - 1) > 1e-9 || Math.abs(sweep.to / sweep.xs[sweep.xs.length - 1] - 1) > 1e-9 || sweep.found < sweep.n || sweep.lines.length < 2 || !sweep.steps)
    fail(`rate sweep incomplete: ${JSON.stringify({found: sweep.found, n: sweep.n, lines: sweep.lines, steps: sweep.steps})}`);
  else console.log(`ok   rate sweep: designs at all ${sweep.n} rates, stepping through ${sweep.lines.join(' → ')}`);
  if (!(cmp.power && cmp.changed && cmp.hasA && cmp.back && cmp.cleared)) fail(`compare: ${JSON.stringify(cmp)}`);
  else console.log('ok   compare: pinned A against B, carried in the link, cleared');
  const near = (a, b) => Math.abs(a / b - 1) < 1e-6;
  if (!(near(llm.T, llm.hand) && near(llm.lat, 0.05) && near(llm.half, 0.5) && near(llm.sweep, 2) && llm.off)) fail(`LLM workload: ${JSON.stringify(llm)}`);
  else console.log(`ok   LLM workload: rate matches the hand calculation (${(llm.T / 1e12).toFixed(1)} TB/s), follows the accelerator count and the sweep; setting the rate directly takes over`);
  if (!(near(llm.pre.tok, 1) && near(llm.pre.ops, 1) && llm.pre.ctx === 4100 && llm.pre.limit === 'compute')) fail(`prefill: ${JSON.stringify(llm.pre)}`);
  else console.log('ok   prefill: prompt tokens and arithmetic add up, and prompts make compute the limit in the LLM example');
  if (!(near(llm.sum, 1) && llm.cheapest && llm.unit > 0)) fail(`cost: ${JSON.stringify(llm)}`);
  else console.log(`ok   cost: parts add up to the capital cost ($${llm.unit.toFixed(3)} per million tokens); the cost goal returns the cheapest design`);
  if (links.bad.length || !links.legacy) fail(`short links: ${JSON.stringify(links)}`);
  else console.log(`ok   short links: all examples round-trip (longest changed design ${links.longest} characters); old links load`);
  if (Object.keys(spec.tall).length || !spec.link) fail(`spec sheet: ${JSON.stringify(spec)}`);
  else console.log(`ok   spec sheet: one A4 page for all ${spec.n} examples, with the share link`);

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
