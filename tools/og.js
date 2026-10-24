// Render the 1200×630 social-preview card (og.png) in headless Chrome:  node tools/og.js
const puppeteer = require('puppeteer');
const path = require('path');
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box} body{margin:0; width:1200px; height:630px; background:#0a0a0a; color:#ededed; font-family:'IBM Plex Sans',sans-serif; position:relative; overflow:hidden}
  .wrap{position:absolute; inset:64px 72px}
  .brand{display:flex; align-items:center; gap:22px}
  .brand svg{width:64px; height:64px}
  h1{margin:0; font-size:76px; font-weight:700; letter-spacing:-.02em; line-height:1}
  p{margin:26px 0 0; font-size:30px; line-height:1.35; color:#a3a3a3; max-width:1000px}
  .row{position:absolute; left:0; right:0; bottom:0; display:flex; align-items:center; gap:18px; font-family:'IBM Plex Mono',monospace; font-size:22px}
  .b{border:2px solid #4a4a4a; border-radius:8px; padding:14px 20px; color:#a3a3a3; white-space:nowrap}
  .b.hot{background:#ededed; color:#0a0a0a; border-color:#ededed}
  .a{color:#4a4a4a; font-size:26px}
  .tag{position:absolute; left:0; bottom:96px; font-family:'IBM Plex Mono',monospace; font-size:20px; letter-spacing:.14em; color:#6b6b6b}
</style></head><body><div class="wrap">
  <div class="tag">BANDWIDTH · LATENCY · PPA</div>
  <div class="brand"><svg viewBox="0 0 32 32"><path d="M3 9h10v14H3zM19 9h10v14H19z" fill="none" stroke="#ededed" stroke-width="2.2"/><path d="M13 16h6" stroke="#ededed" stroke-width="4"/></svg><h1>System Design Explorer</h1></div>
  <p>Size the host, links, accelerators, DRAM, on-chip fabric and racks from throughput and latency requirements, with an optimiser and a design assistant.</p>
  <div class="row"><span class="b">Host</span><span class="a">→</span><span class="b">PCIe 5.0 x16</span><span class="a">→</span><span class="b">Accelerator × 8</span><span class="a">→</span><span class="b hot">HBM3 · bottleneck</span></div>
</div></body></html>`;
(async () => {
  const b = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const p = await b.newPage();
  await p.setViewport({width: 1200, height: 630});
  await p.setContent(html, {waitUntil: 'networkidle0'});
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({path: path.resolve(__dirname, '..', 'og.png')});
  await b.close();
  console.log('wrote og.png');
})();
