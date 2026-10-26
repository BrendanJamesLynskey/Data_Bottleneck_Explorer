// Record a real assistant session and embed it as the page's demo (replacing the scripted walkthrough).
// The owner runs this with their own key in the environment; the key goes only to that provider's API, from the browser.
//   OPENAI_API_KEY=… node tools/record_demo.js          (or GEMINI_API_KEY / GOOGLE_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY)
//   DEMO_PROVIDER=openai|google|openrouter|anthropic and DEMO_MODEL=… pick explicitly; otherwise the first key found
//   is used with the page's default model for that provider. Needs `npm install` once, for puppeteer.
// It types PROMPT into the assistant, answers its questions with ANSWERS (falling back to the first option), waits
// for the final reply, then writes the conversation into index.html between the DEMO-START / DEMO-END markers.
const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), PAGE = path.join(ROOT, 'index.html');
const PROMPT = process.env.DEMO_PROMPT || 'Serve Llama 3.1 70B to 2,000 users at 20 tokens/s each, with 2,000-token prompts, under 100 ms per token '
  + 'and the first token within a second. Put prefill and decode on separate pools, then show me the chip inside each accelerator '
  + '(compute array, voltage and clock) and check it stays under its junction-temperature limit.';
const ANSWERS = [/p99|target|soft/i, /liquid/i, /fp8/i, /separate|split/i, /batch/i];       // preferred options, matched against each question's options
const KEYS = {openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY};
const PROVIDER = process.env.DEMO_PROVIDER || Object.keys(KEYS).find(k => KEYS[k]);
if(!PROVIDER || !KEYS[PROVIDER]){ console.error('Set OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY first.'); process.exit(1); }

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto('file://' + PAGE, {waitUntil: 'networkidle0'});
  const label = await page.evaluate(async (id, key, model) => { prov.id = id; prov.key = key; prov.model = model || ''; prov.models = null; chat.basic = false;
    openDrawer('assist'); newChat(); await ensureModel(); return modelLabel(); }, PROVIDER, KEYS[PROVIDER], process.env.DEMO_MODEL || '');
  console.log('recording with ' + label);
  await page.evaluate(t => userSays(t), PROMPT);
  for(let round = 0; round < 6; round++){
    await page.waitForFunction(() => !chat.busy, {timeout: 600000, polling: 500});
    const pending = await page.evaluate(() => !!chat.pending);
    if(!pending) break;
    const answer = await page.evaluate(prefs => {
      return chat.pending.asks.flatMap(b => b.input.questions || []).map(q => {
        const pick = q.options.find(o => prefs.some(re => new RegExp(re.source, re.flags).test(o))) || q.options[0];
        return q.question + ' → ' + pick; }).join('\n');
    }, ANSWERS.map(r => ({source: r.source, flags: r.flags})));
    console.log('answering:\n' + answer);
    await page.evaluate(a => userSays(a), answer);
  }
  const log = await page.evaluate(() => chat.log);
  const errs = await page.evaluate(() => [...document.querySelectorAll('.msg.err')].map(e => e.textContent));
  await browser.close();
  if(errs.length || !log.some(e => e.t === 'bot')){ console.error('No usable session recorded:', errs.join(' | ')); process.exit(1); }
  const demo = {kind: 'recorded', model: label, date: new Date().toISOString().slice(0, 10), events: log};
  const html = fs.readFileSync(PAGE, 'utf8');
  const out = html.replace(/\/\*DEMO-START\*\/[\s\S]*?\/\*DEMO-END\*\//, '/*DEMO-START*/' + JSON.stringify(demo) + '/*DEMO-END*/');
  if(out === html){ console.error('DEMO markers not found'); process.exit(1); }
  fs.writeFileSync(PAGE, out);
  console.log(`Recorded ${log.length} events (${log.filter(e => e.t === 'tool').length} tool calls) into index.html. Review the replay, then commit.`);
})();
