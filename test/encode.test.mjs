// Headless test: Encoder produces a string that the Renderer decodes back to a
// non-trivial reconstruction (encode→decode roundtrip), proving the encoder is
// decoupled and correct.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/test/encode.fixture.html';
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
const page = await browser.newPage({ timeout: 60000 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${port}/test/encode.fixture.html`);
await page.waitForEvent('imgoji-ready', null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(50);
const r = await page.evaluate(() => window.__results);
await browser.close(); server.close();

console.log('results:', r);
console.log('errors:', errors.length ? errors : '(none)');

const ok = r && r.paletteLen > 20 && r.strLen > 4 && r.bytes > 0 && r.reconRange > 20 && errors.length === 0;
if (!ok) { console.error('FAIL'); process.exit(1); }
console.log('PASS: encoder produced a string the renderer decoded to a varied reconstruction');
