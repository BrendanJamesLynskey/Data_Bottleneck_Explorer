// Keep the simulation files in step with the page:  node tools/sim_sync.js [--check]
//   1. export every example's design spec (simSpec, schema hw-explorer-sim/1) to sim/examples/<id>.json, in headless Chrome;
//   2. embed sim/sim.py (for Export and the in-browser run), sim/results.json (the Checks tab's model-vs-simulation
//      table) and sim/trace_results.json (its real-traffic table) in index.html, between their <script> tags;
//   3. export the real-traffic specs (simTraceSpec, from sim/traces/stats.json) to sim/traces/specs/.
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
  put(PAGE, html);

  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith('file:') || r.url().startsWith('data:')) ? r.continue() : r.abort());
  await page.goto('file://' + PAGE, {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 500));
  const specs = await page.evaluate(() => PRESETS.map(p => { applyPreset(p.id); return [p.id, simSpec(S)]; }));
  // real-traffic specs: the split-pool example at each trace's mean prompt, as designed and with the trace's arrival CV
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'sim', 'traces', 'stats.json'), 'utf8'));
  const tspecs = await page.evaluate(st => { applyPreset('llmsplit'); const base = clone(S), out = [];
    for (const [name, t] of Object.entries(st)) { const prompt = Math.round(t.prompt.mean);
      out.push([`llmsplit_${name}_designed`, simTraceSpec(base, prompt)], [`llmsplit_${name}_traceca`, simTraceSpec(base, prompt, t.arrival_cv)]); }
    return out; }, stats);
  await browser.close();
  fs.mkdirSync(EX, {recursive: true});
  const want = new Set();
  for (const [id, spec] of specs) { const f = path.join(EX, id + '.json'); want.add(f); put(f, JSON.stringify(spec, null, 1) + '\n'); }
  const TS = path.join(ROOT, 'sim', 'traces', 'specs');
  fs.mkdirSync(TS, {recursive: true});
  for (const [id, spec] of tspecs) put(path.join(TS, id + '.json'), JSON.stringify(spec, null, 1) + '\n');
  for (const f of fs.readdirSync(EX)) if (f.endsWith('.json') && !want.has(path.join(EX, f))) { stale.push('sim/examples/' + f + ' (no such example)'); if (!check) fs.unlinkSync(path.join(EX, f)); }

  if (check) {
    if (stale.length) { console.log('FAIL simulation files out of step with the page (run node tools/sim_sync.js): ' + stale.join(', ')); process.exit(1); }
    console.log(`ok   simulation files in step: ${specs.length} example specs, ${tspecs.length} real-traffic specs, sim.py and both results embedded in the page`);
  } else console.log(stale.length ? 'updated ' + stale.join(', ') : 'nothing to update');
})();
