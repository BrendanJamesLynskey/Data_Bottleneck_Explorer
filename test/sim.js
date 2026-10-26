// The in-browser simulation, end to end in headless Chrome: Pyodide and SimPy load in the worker, a design simulates and
// the model-vs-simulation table appears, at desktop and phone width; the export zip holds design.json and sim.py.
//   node test/sim.js [--shots DIR]
// Needs the network the first time (cdn.jsdelivr.net, pypi.org). Chrome keeps its profile, and so its HTTP cache, in
// ~/.cache/hw-explorer-sim (or $SIM_CACHE), so later runs and CI (which caches that folder) skip the downloads.
// Request interception isn't used: it stalls the worker's requests.
const puppeteer = require('puppeteer');
const fs = require('fs'), os = require('os'), path = require('path'), {execFileSync} = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CACHE = process.env.SIM_CACHE || path.join(os.homedir(), '.cache', 'hw-explorer-sim');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox'], userDataDir: CACHE, protocolTimeout: 600000});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({width: 1400, height: 1000});
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 500));

  let fails = 0;
  const fail = m => { fails++; console.log('FAIL ' + m); };

  // nothing loads Python until the visitor asks
  const before = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('pyodide')).length);
  if (before) fail('Pyodide requested before the click');

  // export: a zip with the spec and the simulator, which Python can open
  const zip = await page.evaluate(async () => {
    applyPreset('radar'); const spec = simSpec(S);
    const b = zipFiles([['design.json', JSON.stringify(spec, null, 1) + '\n'], ['sim.py', simText('simSrc')], ['requirements.txt', SIMPY + '\n']]);
    const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s);
  });
  const zf = path.join(os.tmpdir(), `hw-sim-${process.pid}.zip`);
  fs.writeFileSync(zf, Buffer.from(zip, 'base64'));
  try {
    const out = execFileSync('python3', ['-c', `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
spec = json.loads(z.read('design.json')); src = z.read('sim.py').decode()
print(spec['schema'], len(spec['pools'][0]['stages']), src == open(sys.argv[2]).read())`, zf, path.join(ROOT, 'sim', 'sim.py')]).toString().trim();
    if (out !== 'hw-explorer-sim/1 8 True') fail('export zip: ' + out); else console.log('ok   export: the zip opens in Python and holds the spec and sim.py as committed');
  } catch (e) { fail('export zip unreadable: ' + e.message); }
  fs.unlinkSync(zf);

  // simulate in the browser: a short run of the radar example (one pool)
  await page.evaluate(() => { SIM_WEB.runs = 3; SIM_WEB.blocks = 3000; SIM_WEB.warm = 300; document.getElementById('simJump').click(); document.getElementById('simGo').click(); });
  const t0 = Date.now();
  await page.waitForFunction(() => simRun.state === 'running' || simRun.state === 'done' || simRun.state === 'error', {timeout: 300000, polling: 1000});
  const running = await page.evaluate(() => ({state: simRun.state, prog: !!document.querySelector('#simThis progress'), busy: document.getElementById('simGo').disabled}));
  await page.waitForFunction(() => simRun.state === 'done' || simRun.state === 'error', {timeout: 300000, polling: 1000});
  const r = await page.evaluate(() => ({state: simRun.state, error: simRun.error, rows: document.querySelectorAll('#simThis tbody tr').length,
    verdicts: [...document.querySelectorAll('#simThis tbody .tag')].map(t => t.textContent), status: (document.querySelector('#simThis [role=status]') || {}).textContent}));
  if (r.state !== 'done') fail(`in-browser run: ${r.error}`);
  else if (r.rows < 5 || r.verdicts.length !== r.rows) fail(`in-browser table: ${JSON.stringify(r)}`);
  else console.log(`ok   in-browser run: Pyodide and SimPy in a worker, ${r.rows} rows (${r.status.trim()}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (running.state === 'running' && !running.prog) fail('no progress bar while running');
  if (running.state === 'running' && !running.busy) fail('the button stays enabled while running');
  if (errors.length) fail('page errors: ' + errors.join('; '));

  if (shots) {
    fs.mkdirSync(shots, {recursive: true});
    const card = async (file, w) => {
      await page.setViewport({width: w, height: 900});
      await page.evaluate(() => { simPaint(); document.getElementById('simCard').scrollIntoView({block: 'start'}); });
      await new Promise(r => setTimeout(r, 300));
      const el = await page.$('#simCard'); await el.screenshot({path: path.join(shots, file)});
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (wide) fail(`page scrolls sideways at ${w}px`);
    };
    await card('sim_desktop.png', 1400); await card('sim_phone.png', 390);
    console.log(`ok   screenshots in ${shots}`);
  }
  await browser.close();
  console.log(fails ? `${fails} failure(s)` : 'all simulation checks passed');
  process.exit(fails ? 1 : 0);
})();
