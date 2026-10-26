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
    const out = {refs: runChecks().map(r => ({id: r.id, name: r.name, err: r.err, tol: r.tol, pass: r.pass, fitted: !!r.fitted, info: !!r.info})), presets: {}, overhead: [], optimiser: {}, overflow: []};
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
  // "how is this worked out": each explanation ends on the figure its headline box shows, in every example
  const why = await page.evaluate(() => {
    const bad = [];
    for (const p of PRESETS) {
      applyPreset(p.id);
      for (const [k, i] of [['worst', 0], ['max', 1], ['power', 3], ['cost', 4]]) {
        whyKey = k; paintSummary(M);
        const shown = document.querySelectorAll('#verdict .kpi .v')[i].textContent, b = [...document.querySelectorAll('#why b')].map(x => x.textContent);
        const want = k === 'worst' ? shown.split(' · ').pop() : shown;
        if (!b.includes(want)) bad.push(`${p.id}/${k}: ${want} not in ${b.join(', ')}`);
      }
    }
    whyKey = null; paintSummary(M); return bad;
  });
  // LLM training: arithmetic and memory against the formulas by hand; follows the sweep; serving and training exclude each other
  const train = await page.evaluate(() => {
    applyPreset('trainllm'); model(S); const i = trainInfo(S), R = S.train;
    const micro = R.gbatch / (32 * R.seq), bubble = 3 / micro;                                   // tp 8 × pp 4 × dp 32 = 1,024
    const ops = R.tps * (6 * R.active * 1e9 + 6 * R.layers * R.seq * R.dModel) * 2 * (1 + bubble); // BF16 = twice 8-bit
    const states = R.params * 1e9 / 32 * (2 + 4 + 12 / 32);                                      // per accelerator, ZeRO-1 over dp 32
    const T0 = S.T, T2 = model(atRate(S, 2 * T0)).T;
    document.querySelector('#llmIn input[type=checkbox]').click(); const excl = S.llm.on && !S.train.on;   // the real toggle
    return {ops: S.ops === undefined ? 0 : (applyPreset('trainllm'), model(S), S.ops * S.T / ops), states: i.states / states, dp: i.dp, sweep: T2 / T0, excl, limit: model(S).worst.k};
  });
  // prefill and decode pools: the arithmetic splits between them exactly, power and capital add up, KV caches cross the network
  const pools = await page.evaluate(() => {
    applyPreset('llmsplit'); const m = model(S), i = llmInfo(S), Y = sysOf(m), ps = prefillState(S); model(ps); const ip = llmInfo(ps);
    const decOps = S.ops * S.T / (i.tokens * i.opsTok), preOps = ps.ops * ps.T / (ip.pre * ip.preOpsTok);
    const cd = costOf({...clone(S), llm: {...S.llm, role: 'decode'}}, m).capex, cp = costOf(ps, m.pre).capex, c = costOf(S, m).capex;
    return {decOps, preOps, power: Y.Ptot / (m.Ptot + m.pre.Ptot), capex: c / (cd + cp), kv: S.scale.xOut * S.T / (i.pre * i.kvTok), pool: Y.pool, nPre: m.pre.tp.nA};
  });
  // chip: the array gives peak, density and energy by formula; a weight-stationary GEMM that divides exactly uses M ÷ (M + R + C);
  // explicit chiplets add UCIe power for the traffic that crosses and split the silicon; switching the array on keeps the peak
  const chip = await page.evaluate(() => {
    applyPreset('nvl72'); const before = S.acc.tops; document.querySelector('#chipIn input[type=checkbox]').click(); model(S); const kept = S.acc.tops / before;
    const c = S.chip, peak = c.cores * c.rows * c.cols * 2 * c.ghz * 1e9 / 1e12;
    const ex = clone(S); ex.chip = {...ex.chip, cores: 4, rows: 32, cols: 32, flow: 'ws'}; const g = gemmMap(ex, {M: 4096, N: 64, K: 64, bytes: 1}, 1e12);
    S.chip.dies = 4; const m = model(S);
    return {kept, peak: S.acc.tops / peak, dens: S.acc.topsMm2 * 1.8 / c.ghz / 2.43, pj: S.acc.pj / 0.29, ws: g.util / (4096 / (4096 + 64)),
      d2d: m.A.d2d / (m.d2dBps * D2D.eff / S.burst * 8 * D2D.pj * 1e-12), each: m.dieEach * 4 / m.die, dies: accCost(S, m).n, d2dOn: m.A.d2d > 0};
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
    if (r.info) { console.log(`info indicative ${r.name}: ${(r.err * 100).toFixed(1)} % (not pass/fail)`); continue; }
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
  if (why.length) fail(`explanations: ${why.slice(0, 3).join('; ')}`);
  else console.log('ok   explanations: load, max rate, power and cost each work out to the figure shown, in every example');
  if (!(near(train.ops, 1) && near(train.states, 1) && train.dp === 32 && near(train.sweep, 2) && train.excl && train.limit === 'compute')) fail(`training: ${JSON.stringify(train)}`);
  else console.log('ok   training: arithmetic and memory match the formulas by hand, follow the sweep, and exclude the serving workload');
  if (!(near(pools.decOps, 1) && near(pools.preOps, 1) && near(pools.power, 1) && near(pools.capex, 1) && near(pools.kv, 1) && pools.nPre === 32)) fail(`pools: ${JSON.stringify(pools)}`);
  else console.log(`ok   prefill and decode pools: arithmetic splits exactly, power and capital add up, KV caches cross the network (most loaded: ${pools.pool})`);
  if (!(Math.abs(chip.kept - 1) < 0.01 && near(chip.peak, 1) && near(chip.dens, 1) && near(chip.pj, 1) && near(chip.ws, 1) && near(chip.d2d, 1) && near(chip.each, 1) && chip.dies === 4 && chip.d2dOn)) fail(`chip: ${JSON.stringify(chip)}`);
  else console.log('ok   chip: array peak, density and energy by formula; exact weight-stationary utilisation; chiplets add die-to-die power and split the silicon');
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
