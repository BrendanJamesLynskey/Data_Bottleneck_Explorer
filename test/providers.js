// Drives the design assistant against mocked OpenAI, Google Gemini, OpenRouter and Anthropic APIs, each in its own
// wire format: model listing and default choice, a tool call, the ask_user round trip, and the final reply.
// Checks what each provider receives (tool results matched to calls, Gemini-safe schemas, headers).
const puppeteer = require('puppeteer');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Q = {questions: [{question: 'Hard or soft deadline?', options: ['Hard', 'Soft: p99']}]};
const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS'};
const json = (r, body) => r.respond({status: 200, headers: {...cors, 'content-type': 'application/json'}, body: JSON.stringify(body)});

const MOCKS = {
  openai: {
    models: {data: [{id: 'gpt-6-luna'}, {id: 'gpt-6-sol'}, {id: 'tts-1'}]}, expectModel: 'gpt-6-sol',
    turns: [
      {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Starting from an example. One question.'}]},
        {type: 'function_call', call_id: 'c1', name: 'load_example', arguments: '{"example":"llmdc"}'},
        {type: 'function_call', call_id: 'c2', name: 'ask_user', arguments: JSON.stringify(Q)}]},
      {status: 'completed', output: [{type: 'function_call', call_id: 'c3', name: 'optimise', arguments: '{"goal":"power"}'}]},
      {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Done: design applied.'}]}]}],
    route: u => u.includes('/v1/models') ? 'models' : u.includes('/v1/responses') ? 'turn' : null,
    check: (reqs) => { const b = reqs[1].body, outs = b.input.filter(i => i.type === 'function_call_output');
      return [b.store === false, outs.some(o => o.call_id === 'c1'), outs.some(o => o.call_id === 'c2' && o.output.includes('Soft')), b.tools.every(t => t.type === 'function' && t.name)]; }},
  google: {
    models: {models: [{name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent']}, {name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent']},
      {name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent']}]}, expectModel: 'gemini-2.5-pro',
    turns: [
      {candidates: [{finishReason: 'STOP', content: {role: 'model', parts: [{text: 'Starting from an example. One question.'},
        {functionCall: {name: 'load_example', args: {example: 'llmdc'}}}, {functionCall: {name: 'ask_user', args: Q}, thoughtSignature: 'sig'}]}}]},
      {candidates: [{finishReason: 'STOP', content: {role: 'model', parts: [{functionCall: {name: 'optimise', args: {goal: 'power'}}}]}}]},
      {candidates: [{finishReason: 'STOP', content: {role: 'model', parts: [{text: 'Done: design applied.'}]}}]}],
    route: u => u.includes(':generateContent') ? 'turn' : u.includes('/v1beta/models') ? 'models' : null,
    check: (reqs) => { const b = reqs[1].body, last = b.contents[b.contents.length - 1], s = JSON.stringify(b.tools);
      const fr = last.parts.map(p => p.functionResponse).filter(Boolean);
      return [reqs[1].url.includes('gemini-2.5-pro'), fr.length === 2 && fr[0].name === 'load_example' && fr[1].name === 'ask_user',
        b.contents.some(c => c.role === 'model' && c.parts.some(p => p.thoughtSignature === 'sig')),
        !s.includes('additionalProperties') && !s.includes('minItems') && !/"enum":\[[0-9]/.test(s)]; }},
  openrouter: {
    models: {data: [{id: 'openai/gpt-6-luna', supported_parameters: ['tools']}, {id: 'anthropic/claude-sonnet-5-5', supported_parameters: ['tools', 'reasoning']},
      {id: 'some/no-tools', supported_parameters: []}]}, expectModel: 'anthropic/claude-sonnet-5-5',
    turns: [
      {choices: [{finish_reason: 'tool_calls', message: {role: 'assistant', content: 'Starting from an example. One question.', tool_calls: [
        {id: 't1', type: 'function', function: {name: 'load_example', arguments: '{"example":"llmdc"}'}},
        {id: 't2', type: 'function', function: {name: 'ask_user', arguments: JSON.stringify(Q)}}]}}]},
      {choices: [{finish_reason: 'tool_calls', message: {role: 'assistant', content: null, tool_calls: [{id: 't3', type: 'function', function: {name: 'optimise', arguments: '{"goal":"power"}'}}]}}]},
      {choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'Done: design applied.'}}]}],
    route: u => u.includes('/api/v1/models') ? 'models' : u.includes('/chat/completions') ? 'turn' : null,
    check: (reqs) => { const b = reqs[1].body, tools = b.messages.filter(m => m.role === 'tool');
      return [b.messages[0].role === 'system', tools.some(t => t.tool_call_id === 't1'), tools.some(t => t.tool_call_id === 't2' && t.content.includes('Soft')),
        !!reqs[1].headers['http-referer'], b.model === 'anthropic/claude-sonnet-5-5']; }},
};

async function run(browser, id) {
  const M = MOCKS[id], page = await browser.newPage(), reqs = [], errors = [];
  let turn = 0;
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url(), kind = /^https:\/\/(api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai)\//.test(u) ? M.route(u) : null;
    if (kind) {
      if (r.method() === 'OPTIONS') return r.respond({status: 204, headers: cors});
      if (kind === 'models') return json(r, M.models);
      reqs.push({url: u, headers: r.headers(), body: JSON.parse(r.postData() || '{}')});
      return json(r, M.turns[Math.min(turn++, M.turns.length - 1)]);
    }
    if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
    r.abort();
  });
  await page.goto('file://' + path.join(ROOT, 'index.html'), {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(pid => { document.getElementById('openAssist').click(); const s = document.getElementById('provSel'); s.value = pid; s.dispatchEvent(new Event('change')); }, id);
  await page.evaluate(() => { document.getElementById('keyInput').value = 'test-key'; document.getElementById('saveKey').click(); });
  await page.waitForFunction(() => document.getElementById('modelSel'), {timeout: 10000});
  const model = await page.evaluate(() => prov.model);
  await page.evaluate(() => userSays('Serve a 70B model to 2,000 users'));
  await page.waitForSelector('.qcard .opt', {timeout: 10000});
  await page.evaluate(() => [...document.querySelectorAll('.qcard .opt')].find(b => b.textContent.startsWith('Soft')).click());
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.bot')].some(m => m.textContent.includes('Done')), {timeout: 15000});
  const state = await page.evaluate(() => ({preset: S.preset, acts: [...document.querySelectorAll('.msg.act')].length, errs: [...document.querySelectorAll('.msg.err')].map(e => e.textContent)}));
  await page.close();
  const checks = M.check(reqs);
  const ok = !errors.length && !state.errs.length && model === M.expectModel && state.preset === 'llmdc' && state.acts >= 2 && reqs.length === 3 && checks.every(Boolean);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: default model ${model}, ${reqs.length} requests, request checks ${checks.map(c => c ? '✓' : '✗').join('')}${errors.length ? ' page errors: ' + errors.join('; ') : ''}${state.errs.length ? ' chat errors: ' + state.errs.join('; ') : ''}`);
  return ok;
}

(async () => {
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  let fails = 0;
  for (const id of Object.keys(MOCKS)) if (!(await run(browser, id))) fails++;
  await browser.close();
  console.log(fails ? `${fails} provider(s) failed` : 'all providers passed');
  process.exit(fails ? 1 : 0);
})();
