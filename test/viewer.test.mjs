// Headless browser test: verify the renderer + viewer actually render pixels.
// Serves the project over http (ESM imports need http, not file://), loads the
// fixture, and asserts the canvases have real variance (glyphs were drawn).
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/test/viewer.fixture.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`http://localhost:${port}/test/viewer.fixture.html`);
await page.waitForEvent('imgoji-ready', null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(100);

const results = await page.evaluate(() => window.__results);
await browser.close();
server.close();

console.log('variances:', results);
console.log('console errors:', errors.length ? errors : '(none)');

const ok = results && results.renderer > 20 && results.scene > 20 && results.viewer > 20 && errors.length === 0;
if (!ok) { console.error('FAIL'); process.exit(1); }
console.log('PASS: renderer + scene + viewer all rendered varied pixels, no errors');
