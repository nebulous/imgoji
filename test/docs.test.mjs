// Integration test for the main web page (docs/index.html): the page loads, the
// encode tab encodes an image with the Encoder, and the <imgoji-viewer> renders
// the reconstruction (no errors, no failed asset requests).
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/docs/index.html';
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

await page.goto(`http://localhost:${port}/docs/index.html`);
await page.evaluate(() => document.fonts.ready);
await page.click('[data-tab="encode"]');
await page.setInputFiles('#file', path.join(ROOT, 'assets/earth.jpg'));
await page.click('#encodeGo');
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2500);
  const st = await page.textContent('#status');
  if (/done in|error/i.test(st)) break;
}
const outLen = (await page.textContent('#out')).length;
const reconRange = await page.evaluate(() => {
  const el = document.getElementById('reconViewer');
  const c = el.shadowRoot.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i+1] + d[i+2]) / 3; if (g < mn) mn = g; if (g > mx) mx = g; }
  return mx - mn;
});
await browser.close(); server.close();

console.log('docs:', { outLen, reconRange, errors: errors.length ? errors : '(none)' });
const ok = outLen > 20 && reconRange > 20 && errors.length === 0;
if (!ok) { console.error('FAIL'); process.exit(1); }
console.log('PASS: docs/index.html encode tab encoded earthrise and rendered the <imgoji-viewer>');
