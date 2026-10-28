// Keep the simulation files in step with the page:  node tools/sim_sync.js [--check]
//   1. export every example's design spec (simSpec, schema hw-explorer-sim/1) to sim/examples/<id>.json, in headless Chrome;
//   2. embed sim/sim.py (for Export and the in-browser run), sim/results.json (the Checks tab's model-vs-simulation
//      table), sim/trace_results.json (its real-traffic table), sim/disagg_results.json (its serving-simulator
//      cross-check) and sim/simfront_results.json (its accelerator-simulator cross-check) in index.html, between their
//      <script> tags;
//   3. export the real-traffic specs (simTraceSpec, from sim/traces/stats.json) to sim/traces/specs/;
//   4. export the Disaggregated_Inference_Sim cross-check specs (simLlmSpec) to sim/disagg/specs/;
//   5. export the Torch_Sim_Frontend cross-check specs (simChipSpec) to sim/simfront/specs/.
// --check writes nothing and fails if any file is stale, so CI catches a model change that wasn't re-exported.
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), EX = path.join(ROOT, 'sim', 'examples'), PAGE = path.join(ROOT, 'index.html');
const check = process.argv.includes('--check');

(async () => {
  let stale = [];
  const put = (file, text) => {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old === text) return;
    stale.push(path.relative(ROOT, file));
    if (!check) fs.writeFileSync(file, text);
  };
  // embed first, so the specs come from the page as it will be committed
  const embed = (html, id, text) => {
    const re = new RegExp(`(<script type="[^"]+" id="${id}">)[\\s\\S]*?(</script>)`);
    if (!re.test(html)) throw new Error(`no <script id="${id}"> in index.html`);
    if (/<\/script/i.test(text)) throw new Error(`${id} contains </script`);
    return html.replace(re, (_, a, b) => a + '\n' + text + b);
  };
  let html = fs.readFileSync(PAGE, 'utf8');
  html = embed(html, 'simSrc', fs.readFileSync(path.join(ROOT, 'sim', 'sim.py'), 'utf8'));
  const res = path.join(ROOT, 'sim', 'results.json');
  // the page needs only the rows, at 4 significant figures
  const small = (k, v) => k === 'sim' && v && v.mean_s ? undefined : typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(4) : v;
  html = embed(html, 'simResults', fs.existsSync(res) ? JSON.stringify(JSON.parse(fs.readFileSync(res, 'utf8')), small) + '\n' : 'null\n');
  const tres = path.join(ROOT, 'sim', 'trace_results.json');
  html = embed(html, 'simTraceResults', fs.existsSync(tres) ? JSON.stringify(JSON.parse(fs.readFileSync(tres, 'utf8')), small) + '\n' : 'null\n');
  const dres = path.join(ROOT, 'sim', 'disagg_results.json');
  html = embed(html, 'simDisaggResults', fs.existsSync(dres) ? JSON.stringify(JSON.parse(fs.readFileSync(dres, 'utf8')), small) + '\n' : 'null\n');
  const sres = path.join(ROOT, 'sim', 'simfront_results.json');
  html = embed(html, 'simSimfrontResults', fs.existsSync(sres) ? JSON.stringify(JSON.parse(fs.readFileSync(sres, 'utf8')), small) + '\n' : 'null\n');
  put(PAGE, html);

  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith('file:') || r.url().startsWith('data:')) ? r.continue() : r.abort());
  await page.goto('file://' + PAGE, {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 500));
  const specs = await page.evaluate(() => PRESETS.map(p => { applyPreset(p.id); return [p.id, simSpec(S)]; }));
  // real-traffic specs: the split-pool example at each trace's mean prompt, as designed, with the trace's arrival CV,
  // and as designed but figured for the trace's busiest minute (its prompt tokens ÷ the average minute's)
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'sim', 'traces', 'stats.json'), 'utf8'));
  const tspecs = await page.evaluate(st => { applyPreset('llmsplit'); const base = clone(S), out = [];
    for (const [name, t] of Object.entries(st)) { const prompt = Math.round(t.prompt.mean);
      out.push([`llmsplit_${name}_designed`, simTraceSpec(base, prompt)], [`llmsplit_${name}_traceca`, simTraceSpec(base, prompt, t.arrival_cv)],
               [`llmsplit_${name}_busiest`, simTraceSpec(base, prompt, undefined, {load: t.token_peak_to_average['60s'], rate: t.rate_per_s})]); }
    return out; }, stats);
  // the Disaggregated_Inference_Sim cross-check (sim/TOLERANCE.md): the two LLM serving examples and three variants of
  // llmserve fixed in advance (batch 128 and 32 at four copies, and Llama 3.1 8B)
  const lspecs = await page.evaluate(() => { const out = [];
    const at = (id, f) => { applyPreset(id); const s = clone(S); s.preset = id; if (f) f(s); return s; };
    out.push(['llmserve', simLlmSpec(at('llmserve'))],
             ['llmserve_b128', simLlmSpec(at('llmserve', s => { s.llm.batch = 128; s.llm.users = 512; }))],
             ['llmserve_b32', simLlmSpec(at('llmserve', s => { s.llm.batch = 32; s.llm.users = 128; }))],
             ['llmserve_8b', simLlmSpec(at('llmserve', s => { s.llm.model = 'l8'; Object.assign(s.llm, {params:8.03, active:8.03, layers:32, dModel:4096, kv:2048}); }))],
             ['llmsplit', simLlmSpec(at('llmsplit'))]);
    return out; });
  // the Torch_Sim_Frontend cross-check (sim/TOLERANCE.md): the Chip tab's multiply in four examples and variants fixed in advance
  const cspecs = await page.evaluate(() => {
    const at = (id, f) => { applyPreset(id); const s = clone(S); s.preset = id; if (f) f(s); return s; };
    return [['chiparray', simChipSpec(at('chiparray'))],
            ['chiparray_os', simChipSpec(at('chiparray', s => { s.chip.flow = 'os'; }))],
            ['llmserve', simChipSpec(at('llmserve'))],
            ['llmserve_os', simChipSpec(at('llmserve', s => { s.chip.flow = 'os'; }))],
            ['llmserve_b32', simChipSpec(at('llmserve', s => { s.llm.batch = 32; s.llm.users = 128; }))],
            ['trainllm', simChipSpec(at('trainllm'))]]; });
  await browser.close();
  fs.mkdirSync(EX, {recursive: true});
  const want = new Set();
  for (const [id, spec] of specs) { const f = path.join(EX, id + '.json'); want.add(f); put(f, JSON.stringify(spec, null, 1) + '\n'); }
  const TS = path.join(ROOT, 'sim', 'traces', 'specs');
  fs.mkdirSync(TS, {recursive: true});
  for (const [id, spec] of tspecs) put(path.join(TS, id + '.json'), JSON.stringify(spec, null, 1) + '\n');
  const DS = path.join(ROOT, 'sim', 'disagg', 'specs');
  fs.mkdirSync(DS, {recursive: true});
  for (const [id, spec] of lspecs) put(path.join(DS, id + '.json'), JSON.stringify(spec, null, 1) + '\n');
  const CS = path.join(ROOT, 'sim', 'simfront', 'specs');
  fs.mkdirSync(CS, {recursive: true});
  for (const [id, spec] of cspecs) put(path.join(CS, id + '.json'), JSON.stringify(spec, null, 1) + '\n');
  for (const f of fs.readdirSync(EX)) if (f.endsWith('.json') && !want.has(path.join(EX, f))) { stale.push('sim/examples/' + f + ' (no such example)'); if (!check) fs.unlinkSync(path.join(EX, f)); }

  if (check) {
    if (stale.length) { console.log('FAIL simulation files out of step with the page (run node tools/sim_sync.js): ' + stale.join(', ')); process.exit(1); }
    console.log(`ok   simulation files in step: ${specs.length} example specs, ${tspecs.length} real-traffic specs, ${lspecs.length + cspecs.length} cross-check specs, sim.py and all four results embedded in the page`);
  } else console.log(stale.length ? 'updated ' + stale.join(', ') : 'nothing to update');
})();
